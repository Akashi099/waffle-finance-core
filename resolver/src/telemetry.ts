import type { Supervisor, SupervisorState } from "./supervisor.js";
import {
  listenerLastEventTimestampSeconds,
  operationFailuresTotal,
  retryAttemptsTotal,
  activeOperations,
  resolverRuntimeStateInfo,
} from "./metrics.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Coarse-grained resolver runtime telemetry state, distinct from
 * `SupervisorState`: the supervisor describes its own restart lifecycle,
 * while this describes whether the resolver is actually fulfilling its
 * role from an operator's point of view.
 *
 * - `connected` — running, all chains reporting recent events, no elevated failures.
 * - `degraded`  — running but actively retrying/restarting through transient errors.
 * - `stale`     — running, but one or more chains have gone quiet longer than expected.
 * - `inactive`  — not running at all (idle, stopping, stopped, or failed).
 */
export type ResolverTelemetryState = "connected" | "degraded" | "stale" | "inactive";

export const RESOLVER_TELEMETRY_STATES: readonly ResolverTelemetryState[] = [
  "connected",
  "degraded",
  "stale",
  "inactive",
];

/** Supervisor states that mean "not actually doing the resolver's job right now". */
const INACTIVE_SUPERVISOR_STATES: readonly SupervisorState[] = [
  "idle",
  "stopping",
  "stopped",
  "failed",
];

export interface ChainTelemetry {
  chain: string;
  /** Seconds since the last observed event on this chain, or null if none yet. */
  secondsSinceLastEvent: number | null;
  /** True when the chain has reported an event within the staleness window. */
  live: boolean;
}

export interface ResolverTelemetrySnapshot {
  state: ResolverTelemetryState;
  /** Short human-readable explanation of why `state` was chosen. */
  reason: string;
  supervisorState: SupervisorState;
  restarts: number;
  commandQueueDepth: number;
  recentFailureCount: number;
  recentRetryCount: number;
  chains: ChainTelemetry[];
}

export interface ComputeTelemetryInput {
  supervisorState: SupervisorState;
  restarts: number;
  nowSeconds: number;
  chainLastEventSeconds: Array<{ chain: string; lastEventSeconds: number | null }>;
  /** A chain is considered stale once this many seconds pass with no event. */
  staleAfterSeconds: number;
  /** Failures observed since the last telemetry collection. */
  recentFailureCount: number;
  /** Retry attempts observed since the last telemetry collection. */
  recentRetryCount: number;
  commandQueueDepth: number;
  /** recentFailureCount at or above this trips "degraded". */
  degradedFailureThreshold: number;
}

// ── Pure computation ──────────────────────────────────────────────────────────

/**
 * Derive a single telemetry snapshot from already-gathered inputs. Kept pure
 * (no clock reads, no metrics registry access) so state-transition logic can
 * be tested deterministically.
 *
 * Precedence when multiple conditions hold: inactive > stale > degraded >
 * connected. A resolver that isn't running at all is a stronger signal than
 * one that is running but has gone quiet, which is a stronger signal than one
 * that is actively retrying through transient errors while still making
 * progress.
 */
export function computeResolverTelemetry(input: ComputeTelemetryInput): ResolverTelemetrySnapshot {
  const {
    supervisorState,
    restarts,
    nowSeconds,
    chainLastEventSeconds,
    staleAfterSeconds,
    recentFailureCount,
    recentRetryCount,
    commandQueueDepth,
    degradedFailureThreshold,
  } = input;

  const chains: ChainTelemetry[] = chainLastEventSeconds.map(({ chain, lastEventSeconds }) => {
    if (lastEventSeconds === null) {
      return { chain, secondsSinceLastEvent: null, live: false };
    }
    const secondsSinceLastEvent = Math.max(0, nowSeconds - lastEventSeconds);
    return { chain, secondsSinceLastEvent, live: secondsSinceLastEvent <= staleAfterSeconds };
  });

  const base = {
    supervisorState,
    restarts,
    commandQueueDepth,
    recentFailureCount,
    recentRetryCount,
    chains,
  };

  if (INACTIVE_SUPERVISOR_STATES.includes(supervisorState)) {
    return { ...base, state: "inactive", reason: `supervisor is ${supervisorState}` };
  }

  const staleChains = chains.filter((c) => !c.live);
  if (staleChains.length > 0) {
    return {
      ...base,
      state: "stale",
      reason: `no recent events from: ${staleChains.map((c) => c.chain).join(", ")}`,
    };
  }

  if (supervisorState === "restarting") {
    return { ...base, state: "degraded", reason: `supervisor is restarting (restart ${restarts})` };
  }

  if (recentFailureCount >= degradedFailureThreshold) {
    return {
      ...base,
      state: "degraded",
      reason: `elevated failure count since last check (${recentFailureCount})`,
    };
  }

  return { ...base, state: "connected", reason: "all chains live, no elevated failures" };
}

// ── Metrics-backed collection ─────────────────────────────────────────────────

export interface CollectTelemetryDeps {
  supervisor: Supervisor;
  /** Chains to report liveness for, e.g. ["ethereum", "soroban"]. */
  chains: string[];
  /** Defaults to 300s (5 minutes). */
  staleAfterSeconds?: number;
  /** Defaults to 3. */
  degradedFailureThreshold?: number;
}

/**
 * Tracks cumulative counter totals across calls so `recentFailureCount` /
 * `recentRetryCount` reflect activity since the *last* collection rather
 * than an ever-growing total that would eventually trip "degraded"
 * permanently on any long-lived process.
 */
export class ResolverTelemetryCollector {
  private lastFailureTotal = 0;
  private lastRetryTotal = 0;

  async collect(deps: CollectTelemetryDeps): Promise<ResolverTelemetrySnapshot> {
    const staleAfterSeconds = deps.staleAfterSeconds ?? 300;
    const degradedFailureThreshold = deps.degradedFailureThreshold ?? 3;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const [lastEventMetric, failuresMetric, retriesMetric, activeOpsMetric] = await Promise.all([
      listenerLastEventTimestampSeconds.get(),
      operationFailuresTotal.get(),
      retryAttemptsTotal.get(),
      activeOperations.get(),
    ]);

    const chainLastEventSeconds = deps.chains.map((chain) => {
      const match = lastEventMetric.values.find((v) => v.labels.chain === chain);
      return { chain, lastEventSeconds: match ? match.value : null };
    });

    const failureTotal = sumValues(failuresMetric.values);
    const retryTotal = sumValues(retriesMetric.values);
    const commandQueueDepth = sumValues(activeOpsMetric.values);

    const recentFailureCount = Math.max(0, failureTotal - this.lastFailureTotal);
    const recentRetryCount = Math.max(0, retryTotal - this.lastRetryTotal);
    this.lastFailureTotal = failureTotal;
    this.lastRetryTotal = retryTotal;

    const snapshot = computeResolverTelemetry({
      supervisorState: deps.supervisor.state,
      restarts: deps.supervisor.restarts,
      nowSeconds,
      chainLastEventSeconds,
      staleAfterSeconds,
      recentFailureCount,
      recentRetryCount,
      commandQueueDepth,
      degradedFailureThreshold,
    });

    publishResolverTelemetryMetric(snapshot.state);
    return snapshot;
  }
}

function sumValues(values: Array<{ value: number }>): number {
  return values.reduce((sum, v) => sum + v.value, 0);
}

/** Set the `resolver_runtime_state_info` gauge so only the current state reads 1. */
function publishResolverTelemetryMetric(state: ResolverTelemetryState): void {
  for (const candidate of RESOLVER_TELEMETRY_STATES) {
    resolverRuntimeStateInfo.set({ state: candidate }, candidate === state ? 1 : 0);
  }
}
