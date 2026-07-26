import type { Logger } from "pino";
import { operationDurationSeconds, operationFailuresTotal, activeOperations } from "./metrics.js";

export interface CommandRunOptions {
  /** Metric/log label for this operation, e.g. "register", "status", "unregister". */
  operation: string;
  /** Chain this operation is scoped to, for metric labelling. */
  chain: string;
  log: Logger;
}

/**
 * Map an error to a low-cardinality failure_reason label. Falls back to the
 * error's own name (for known error classes like TransientError or
 * ConfigValidationError) rather than the raw message, which may contain
 * addresses/amounts and would blow up metric cardinality.
 */
export function classifyFailureReason(err: unknown): string {
  if (err instanceof Error && err.name && err.name !== "Error") {
    return err.name;
  }
  return "unknown_error";
}

/**
 * Run a resolver command (register/status/unregister, etc.) with consistent
 * timing, structured logging, and failure metrics so that one bad command
 * surfaces a clear, attributable signal instead of an opaque stack trace.
 *
 * This does NOT retry `fn` itself — retrying a state-mutating transaction
 * (e.g. registry.register) risks double-submission. Callers should apply
 * retry only around the read-only RPC calls inside `fn` (see retryRpcCall).
 */
export async function runResolverCommand<T>(
  opts: CommandRunOptions,
  fn: () => Promise<T>
): Promise<T> {
  const { operation, chain, log } = opts;
  const cmdLog = log.child({ component: "command-runner", operation });
  activeOperations.inc({ operation });
  const endTimer = operationDurationSeconds.startTimer({ operation, chain });

  try {
    const result = await fn();
    endTimer();
    cmdLog.info({ chain }, "command completed");
    return result;
  } catch (err) {
    endTimer();
    const failureReason = classifyFailureReason(err);
    operationFailuresTotal.inc({ chain, operation, failure_reason: failureReason });
    cmdLog.error(
      { chain, failureReason, err: err instanceof Error ? err.message : String(err) },
      "command failed"
    );
    throw err;
  } finally {
    activeOperations.dec({ operation });
  }
}
