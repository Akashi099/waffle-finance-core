/**
 * BacklogScheduler — deterministic backlog prioritization contract.
 *
 * ## Priority order (highest → lowest)
 *
 *  1. LIVE_EVENT     — events arriving from chain listeners right now.
 *                      These must be processed before any recovery work to
 *                      keep the order book fresh and resolver latency low.
 *  2. REPLAY_JOB     — reconciler catch-up replay for blocks/ledgers the
 *                      live listeners missed (restart gap, RPC outage, etc.).
 *  3. SECRET_RECOVERY— secret reconciler: preimages missing from the DB
 *                      after an `OrderClaimed` was missed.
 *  4. STALE_CLEANUP  — soft-delete of orphaned announced orders that never
 *                      received an on-chain lock. Lowest urgency — no funds
 *                      are at risk; only DB hygiene is affected.
 *
 * ## Why deterministic?
 *
 * Under backlog conditions multiple job types compete for the same async
 * execution context.  Without an explicit priority model, scheduling depends
 * on `setInterval` / `setTimeout` tick ordering, which is non-deterministic
 * across Node.js event-loop cycles.  `BacklogScheduler` enforces the policy
 * through a priority-ordered `run()` gate: callers submit work via
 * `enqueue()`, and `run()` always drains the highest-priority non-empty bucket
 * before moving to the next.
 *
 * ## Observability
 *
 * Queue depth per priority class is tracked in Prometheus gauges
 * (`coordinator_backlog_queue_depth`).  A high depth for REPLAY_JOB while
 * LIVE_EVENT depth is 0 indicates normal catch-up; a persistently high
 * STALE_CLEANUP depth simply means cleanup is backlogged but the service is
 * healthy.  Operators can alert on LIVE_EVENT depth > N to detect listener
 * stalls.
 */

import type { Logger } from "pino";
import {
  backlogQueueDepth,
  backlogJobsExecuted,
  backlogJobDuration,
  backlogDropped,
} from "./backlog-metrics.js";

// ── Priority enum ─────────────────────────────────────────────────────────────

/**
 * Numeric priority — lower number = higher priority.
 * Kept as a const enum so TypeScript inlines the values and consumers can
 * do `>` / `<` comparisons without importing the runtime object.
 */
export const Priority = {
  LIVE_EVENT:       1,
  REPLAY_JOB:       2,
  SECRET_RECOVERY:  3,
  STALE_CLEANUP:    4,
} as const;

export type Priority = typeof Priority[keyof typeof Priority];

export const PRIORITY_LABELS: Record<Priority, string> = {
  [Priority.LIVE_EVENT]:      "live_event",
  [Priority.REPLAY_JOB]:      "replay_job",
  [Priority.SECRET_RECOVERY]: "secret_recovery",
  [Priority.STALE_CLEANUP]:   "stale_cleanup",
};

// ── Job type ──────────────────────────────────────────────────────────────────

export interface ScheduledJob {
  /** Human-readable name for log / metrics tagging. */
  name: string;
  priority: Priority;
  /** The unit of work. Must be idempotent — it may be executed more than once
   *  if a previous attempt threw before completion. */
  execute: () => Promise<void>;
}

// ── BacklogScheduler ──────────────────────────────────────────────────────────

export interface BacklogSchedulerOptions {
  /**
   * Maximum number of jobs per priority class that can sit in the queue at
   * once.  When the queue for a given priority reaches `maxQueueDepth`, new
   * jobs at that priority are **dropped** with a warning rather than
   * accumulating unboundedly.  Set to 0 to disable the cap (not recommended
   * for production).
   *
   * @default 1000
   */
  maxQueueDepth?: number;

  /**
   * When `true`, `run()` processes exactly one job per call (useful for
   * testing turn-by-turn execution).  When `false` (default), `run()` drains
   * all pending jobs in priority order.
   */
  singleStep?: boolean;
}

export class BacklogScheduler {
  private readonly queues: Map<Priority, ScheduledJob[]> = new Map();
  private readonly maxQueueDepth: number;
  private readonly singleStep: boolean;
  private readonly log: Logger;

  /** Sorted ascending so index 0 = highest priority. */
  private readonly sortedPriorities: Priority[];

  constructor(log: Logger, options: BacklogSchedulerOptions = {}) {
    this.log = log.child({ component: "BacklogScheduler" });
    this.maxQueueDepth = options.maxQueueDepth ?? 1000;
    this.singleStep = options.singleStep ?? false;

    this.sortedPriorities = (
      Object.values(Priority) as Priority[]
    ).sort((a, b) => a - b);

    for (const p of this.sortedPriorities) {
      this.queues.set(p, []);
    }
  }

  // ── Enqueue ────────────────────────────────────────────────────────────────

  /**
   * Submit a job.  Jobs are not executed here — they are held until `run()`
   * is called.  This means live-event handlers can call `enqueue()` without
   * blocking; the scheduler drains the queue on its own tick.
   *
   * Returns `true` if the job was accepted, `false` if it was dropped because
   * the queue for this priority class is full.
   */
  enqueue(job: ScheduledJob): boolean {
    const queue = this.queues.get(job.priority)!;
    const label = PRIORITY_LABELS[job.priority];

    if (this.maxQueueDepth > 0 && queue.length >= this.maxQueueDepth) {
      backlogDropped.inc({ priority: label });
      this.log.warn(
        { priority: label, name: job.name, queueDepth: queue.length, maxQueueDepth: this.maxQueueDepth },
        "BacklogScheduler: job dropped — queue full"
      );
      return false;
    }

    queue.push(job);
    backlogQueueDepth.set({ priority: label }, queue.length);

    this.log.debug(
      { priority: label, name: job.name, queueDepth: queue.length },
      "BacklogScheduler: job enqueued"
    );
    return true;
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  /**
   * Execute pending jobs in strict priority order.
   *
   * If `singleStep` is `true`, runs exactly one job from the highest-priority
   * non-empty queue.  Otherwise drains all queues completely before returning.
   *
   * Returns the number of jobs executed in this call.
   */
  async run(): Promise<number> {
    let total = 0;

    for (const priority of this.sortedPriorities) {
      const queue = this.queues.get(priority)!;
      const label = PRIORITY_LABELS[priority];

      while (queue.length > 0) {
        const job = queue.shift()!;
        backlogQueueDepth.set({ priority: label }, queue.length);

        const t0 = Date.now();
        try {
          await job.execute();
          const durationSec = (Date.now() - t0) / 1000;
          backlogJobsExecuted.inc({ priority: label, result: "success" });
          backlogJobDuration.observe({ priority: label }, durationSec);
          this.log.debug(
            { priority: label, name: job.name, durationSec },
            "BacklogScheduler: job completed"
          );
        } catch (err) {
          const durationSec = (Date.now() - t0) / 1000;
          backlogJobsExecuted.inc({ priority: label, result: "failure" });
          backlogJobDuration.observe({ priority: label }, durationSec);
          this.log.warn(
            { priority: label, name: job.name, err, durationSec },
            "BacklogScheduler: job failed"
          );
          // Failures are logged and counted but do not stall the scheduler —
          // the job is consumed even on error to avoid an infinite retry loop.
          // Callers that need retry semantics should implement them inside
          // `job.execute()`.
        }

        total++;

        if (this.singleStep) {
          return total;
        }
      }
    }

    return total;
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /**
   * Return the current queue depth for every priority class.
   * Useful for health checks and tests.
   */
  getQueueDepths(): Record<string, number> {
    const depths: Record<string, number> = {};
    for (const [priority, queue] of this.queues.entries()) {
      depths[PRIORITY_LABELS[priority]] = queue.length;
    }
    return depths;
  }

  /**
   * Return the total number of jobs currently queued across all priorities.
   */
  getTotalDepth(): number {
    let n = 0;
    for (const queue of this.queues.values()) n += queue.length;
    return n;
  }

  /**
   * Drain all queues without executing jobs.  Used by tests to reset state
   * between runs.
   */
  clear(): void {
    for (const [priority, queue] of this.queues.entries()) {
      queue.length = 0;
      backlogQueueDepth.set({ priority: PRIORITY_LABELS[priority] }, 0);
    }
  }
}
