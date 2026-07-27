/**
 * @file maintenance-scheduler.ts
 *
 * Deterministic scheduled maintenance service for the coordinator.
 *
 * ## Why this exists
 *
 * Before this module, stale-order expiry and archival were driven by two
 * independent `setInterval` calls inside `index.ts`, both delegating into
 * the `BacklogScheduler`. That arrangement had several gaps:
 *
 *  - The intervals had no shared lifecycle — stopping one did not stop the
 *    other; graceful shutdown required tracking two separate handles.
 *  - There was no per-job run policy: a job that threw would be silently
 *    swallowed by the backlog runner with no observable signal that the
 *    maintenance cadence had broken.
 *  - "Skip" semantics (e.g. "don't run cleanup if the previous run is still
 *    in flight") were not modelled, so concurrent ticks could produce
 *    overlapping cleanup runs.
 *  - There was no stable, typed API for triggering a maintenance run outside
 *    the normal schedule (the admin route called `staleCleanup.run()` and
 *    `orders.expireStaleOrders()` separately, bypassing the backlog entirely).
 *
 * `MaintenanceScheduler` solves all of these by:
 *
 *  1. Owning a typed registry of **maintenance jobs** — each job has a name,
 *     a cadence multiplier, a priority class, and an `execute` callback.
 *  2. Providing a single `start()` / `stop()` lifecycle that manages one
 *     interval per job and clears all of them on shutdown.
 *  3. Providing `runJob(name)` for on-demand execution (admin routes,
 *     startup warmup) that goes through the same metric and skip path as
 *     the scheduled execution.
 *  4. Exposing `runAll()` to trigger all registered jobs immediately — used
 *     at startup so the coordinator's first scan happens before the first
 *     interval fires.
 *  5. Emitting per-job Prometheus metrics: run counts by result, per-job
 *     duration histogram, last-run timestamp, and skip counts.
 *
 * ## Idempotency
 *
 * Each job carries an `inFlight` flag. When the interval fires while a
 * previous execution is still running, the new tick is counted as a skip
 * (increments `maintenanceSkippedTotal`) and returns immediately without
 * enqueuing a second concurrent invocation. This makes the scheduler safe
 * to use with a tight poll interval even when individual jobs are slow.
 *
 * ## Integration with BacklogScheduler
 *
 * `MaintenanceScheduler` enqueues work through the shared `BacklogScheduler`
 * so the coordinator's existing priority contract is preserved:
 *   LIVE_EVENT > REPLAY_JOB > SECRET_RECOVERY > STALE_CLEANUP
 *
 * Jobs can specify a `priority` field; if omitted, they default to
 * `REPLAY_JOB` for expiry scans and `STALE_CLEANUP` for archival work.
 */

import type { Logger } from "pino";
import { BacklogScheduler, Priority } from "../backlog/backlog-scheduler.js";
import {
  maintenanceRunsTotal,
  maintenanceJobDuration,
  maintenanceLastRun,
  maintenanceSkippedTotal,
} from "../metrics.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The result of a single maintenance job execution.
 *
 * Callers that need structured data (e.g. admin routes) get a typed result
 * rather than having to parse log output.
 */
export interface MaintenanceJobResult {
  /** Job name as registered. */
  jobName: string;
  /** Whether the job ran to completion. */
  ok: boolean;
  /** Wall-clock milliseconds the job took. 0 when skipped. */
  durationMs: number;
  /**
   * True when the job was skipped because a previous invocation was still
   * in flight at tick time.
   */
  skipped: boolean;
  /** Error message when ok=false. Undefined on success or skip. */
  error?: string;
  /**
   * Arbitrary structured data returned by the job — callers receive this
   * opaquely; admin routes can surface it in the HTTP response.
   */
  detail?: Record<string, unknown>;
}

/**
 * A registered maintenance job.
 *
 * The scheduler holds one of these per registered job. Fields are read-only
 * after registration — mutation at runtime is not supported.
 */
export interface MaintenanceJob {
  /** Unique name, used in log entries and Prometheus label values. */
  name: string;
  /**
   * Interval between runs as a multiple of the scheduler's base interval.
   * For example: `baseIntervalMs=15_000`, `cadenceMultiplier=4` → runs every
   * 60 seconds. `cadenceMultiplier=240` → runs every 60 minutes.
   */
  cadenceMultiplier: number;
  /** Priority class passed to BacklogScheduler when enqueueing. */
  priority: Priority;
  /**
   * The actual work. Must be idempotent — the scheduler may call it
   * concurrently if `skipIfRunning` is false.
   *
   * Return any structured data that the caller should surface; it appears
   * in `MaintenanceJobResult.detail`.
   */
  execute: () => Promise<Record<string, unknown> | void>;
  /**
   * When true (default), a new tick is skipped if the job is still running
   * from the previous tick. Set to false only for jobs that are safe to run
   * concurrently.
   * @default true
   */
  skipIfRunning?: boolean;
}

// ── Internal state ────────────────────────────────────────────────────────────

interface JobState {
  job: MaintenanceJob;
  /** Tick counter — incremented on every interval tick for this job. */
  tickCount: number;
  /** True when a run is currently in progress. */
  inFlight: boolean;
  /** The handle returned by setInterval for this job. */
  handle: ReturnType<typeof setInterval> | null;
}

// ── MaintenanceScheduler ──────────────────────────────────────────────────────

export class MaintenanceScheduler {
  private readonly jobs: Map<string, JobState> = new Map();
  private running = false;

  constructor(
    private readonly backlog: BacklogScheduler,
    private readonly log: Logger,
    /** The base tick interval from which `cadenceMultiplier` is applied. */
    private readonly baseIntervalMs: number = 15_000
  ) {}

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a maintenance job.
   *
   * Jobs must be registered **before** `start()` is called. Registering
   * after `start()` is safe but the new job will not have an interval set
   * up until the next `stop()` / `start()` cycle.
   */
  register(job: MaintenanceJob): this {
    if (this.jobs.has(job.name)) {
      throw new Error(
        `MaintenanceScheduler: job "${job.name}" is already registered`
      );
    }
    this.jobs.set(job.name, {
      job: { skipIfRunning: true, ...job },
      tickCount: 0,
      inFlight: false,
      handle: null,
    });
    this.log.debug({ jobName: job.name }, "maintenance job registered");
    return this;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start all registered maintenance intervals.
   *
   * Calling `start()` while already running is a no-op (idempotent).
   * The first tick of each job fires immediately rather than waiting for
   * the first interval to elapse, so the coordinator does not enter a
   * silent gap at startup.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const state of this.jobs.values()) {
      const intervalMs = state.job.cadenceMultiplier * this.baseIntervalMs;

      state.handle = setInterval(() => {
        state.tickCount++;
        this._scheduleJob(state);
      }, intervalMs);

      // Trigger first run immediately without waiting for the interval.
      state.tickCount++;
      this._scheduleJob(state);
    }

    this.log.info(
      { jobCount: this.jobs.size, baseIntervalMs: this.baseIntervalMs },
      "MaintenanceScheduler started"
    );
  }

  /**
   * Stop all registered maintenance intervals.
   *
   * In-flight jobs are not interrupted — `stop()` only prevents new ticks
   * from being enqueued. Callers that need to drain in-flight work before
   * shutdown should `await` the `Promise` returned by any outstanding
   * `runJob()` calls they hold a reference to.
   *
   * Idempotent: safe to call when already stopped.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const state of this.jobs.values()) {
      if (state.handle !== null) {
        clearInterval(state.handle);
        state.handle = null;
      }
    }

    this.log.info("MaintenanceScheduler stopped");
  }

  // ── On-demand execution ───────────────────────────────────────────────────

  /**
   * Run a single registered job immediately, outside the normal schedule.
   *
   * The skip-if-running guard still applies: if the job is currently in
   * flight, this returns a skipped result rather than starting a second
   * concurrent execution.
   *
   * Use this for admin-route triggered runs and startup warm-up.
   */
  async runJob(name: string): Promise<MaintenanceJobResult> {
    const state = this.jobs.get(name);
    if (!state) {
      throw new Error(`MaintenanceScheduler: unknown job "${name}"`);
    }
    return this._executeJob(state);
  }

  /**
   * Run all registered jobs immediately in registration order.
   *
   * Returns one `MaintenanceJobResult` per job. The individual skip guard
   * still applies per job, so this is safe to call even when some jobs
   * are already in flight.
   *
   * Used during coordinator startup to ensure the first maintenance pass
   * completes before the first scheduled interval fires.
   */
  async runAll(): Promise<MaintenanceJobResult[]> {
    const results: MaintenanceJobResult[] = [];
    for (const state of this.jobs.values()) {
      results.push(await this._executeJob(state));
    }
    return results;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Enqueue a job execution through the BacklogScheduler.
   *
   * We enqueue rather than executing directly so the priority contract is
   * respected — a live-event burst will drain before a stale-cleanup job
   * gets CPU time.
   */
  private _scheduleJob(state: JobState): void {
    this.backlog.enqueue({
      name: `maintenance:${state.job.name}`,
      priority: state.job.priority,
      execute: () => this._executeJob(state).then(() => undefined),
    });
    void this.backlog.run();
  }

  /**
   * Execute the job, recording metrics and enforcing the skip-if-running
   * guard. Returns the structured result regardless of success/failure so
   * admin routes have something to surface.
   */
  private async _executeJob(state: JobState): Promise<MaintenanceJobResult> {
    const { name } = state.job;

    // ── Skip guard ──────────────────────────────────────────────────────────
    if (state.job.skipIfRunning && state.inFlight) {
      maintenanceSkippedTotal.inc({ job: name });
      this.log.debug(
        { jobName: name },
        "maintenance job skipped — previous run still in flight"
      );
      return { jobName: name, ok: true, durationMs: 0, skipped: true };
    }

    state.inFlight = true;
    const t0 = Date.now();

    try {
      const detail = await state.job.execute();
      const durationMs = Date.now() - t0;
      const durationSec = durationMs / 1000;

      maintenanceRunsTotal.inc({ job: name, result: "success" });
      maintenanceJobDuration.observe({ job: name }, durationSec);
      maintenanceLastRun.set({ job: name }, Math.floor(Date.now() / 1000));

      this.log.info(
        { jobName: name, durationMs, ...(detail ?? {}) },
        "maintenance job completed"
      );

      return {
        jobName: name,
        ok: true,
        durationMs,
        skipped: false,
        detail: detail ?? undefined,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - t0;
      const durationSec = durationMs / 1000;
      const message = err instanceof Error ? err.message : String(err);

      maintenanceRunsTotal.inc({ job: name, result: "failure" });
      maintenanceJobDuration.observe({ job: name }, durationSec);

      this.log.error(
        { jobName: name, durationMs, err },
        "maintenance job failed"
      );

      return {
        jobName: name,
        ok: false,
        durationMs,
        skipped: false,
        error: message,
      };
    } finally {
      state.inFlight = false;
    }
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /**
   * Return a snapshot of the scheduler's state suitable for health checks
   * and diagnostics.
   */
  getStatus(): Array<{
    name: string;
    cadenceMs: number;
    inFlight: boolean;
    tickCount: number;
  }> {
    return Array.from(this.jobs.values()).map((s) => ({
      name: s.job.name,
      cadenceMs: s.job.cadenceMultiplier * this.baseIntervalMs,
      inFlight: s.inFlight,
      tickCount: s.tickCount,
    }));
  }

  /** True when `start()` has been called and `stop()` has not. */
  get isRunning(): boolean {
    return this.running;
  }
}
