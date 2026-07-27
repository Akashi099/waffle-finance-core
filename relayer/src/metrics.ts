/**
 * Prometheus-compatible metrics for the WaffleFinance relayer.
 *
 * All metrics live in a dedicated registry (not the global default) so
 * tests can instantiate a clean registry per-run without cross-
 * contamination, and so the relayer can be embedded in other processes
 * without polluting their default metrics.
 *
 * Metric naming follows the Prometheus convention:
 *   <namespace>_<subsystem>_<name>_<unit>
 *
 * Security note: no metric label carries order-level data (addresses,
 * amounts, hashlocks). Labels are limited to reason codes and status
 * strings so the /metrics endpoint is safe to expose internally.
 */

import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Shared registry for all relayer metrics. Export it so the /metrics
 * HTTP handler can call `registry.metrics()`.
 */
export const registry = new Registry();

// Attach Node.js process metrics (heap, GC, event loop lag, etc.) to our
// registry rather than the global default. Pass `register: registry` so
// they are scoped to this relayer instance.
collectDefaultMetrics({ register: registry });

// ---------------------------------------------------------------------------
// Refund Watchdog counters
// ---------------------------------------------------------------------------

/**
 * Total number of watchdog tick executions that completed without an
 * unhandled error ΓÇö i.e. the scan loop ran to completion regardless of
 * whether any individual order refund inside the tick succeeded or failed.
 */
export const watchdogRunsTotal = new Counter({
  name: 'relayer_refund_watchdog_runs_total',
  help: 'Total number of refund watchdog scan ticks executed',
  registers: [registry],
});

/**
 * Total number of individual order refunds that succeeded (Stellar tx
 * submitted and confirmed hash returned).
 */
export const watchdogRefundSuccessTotal = new Counter({
  name: 'relayer_refund_watchdog_success_total',
  help: 'Total number of XLM refunds successfully submitted by the watchdog',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/**
 * Total number of individual order refunds that failed. The `reason`
 * label holds a short, sanitised error category (not the raw error
 * message) to keep the cardinality of label combinations bounded.
 *
 * Defined reason values:
 *   missing_address  ΓÇö order has no stellarAddress
 *   refund_error     ΓÇö refundXlmToUser threw
 */
export const watchdogRefundFailureTotal = new Counter({
  name: 'relayer_refund_watchdog_failure_total',
  help: 'Total number of XLM refund attempts that failed in the watchdog',
  labelNames: ['reason', 'network_mode'] as const,
  registers: [registry],
});

/**
 * Total number of stale orders detected (age >= staleAfterMs) during
 * any tick, regardless of whether refund was attempted or skipped
 * (e.g. due to back-off).
 */
export const watchdogStaleOrdersDetected = new Counter({
  name: 'relayer_refund_watchdog_stale_orders_detected_total',
  help: 'Total number of stale orders identified by the refund watchdog',
  registers: [registry],
});

/**
 * Total number of orders skipped during a tick because they were still
 * within the 10-minute back-off window after a previous failure.
 */
export const watchdogBackoffSkipsTotal = new Counter({
  name: 'relayer_refund_watchdog_backoff_skips_total',
  help: 'Total number of stale orders skipped due to post-failure back-off',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Refund Watchdog gauges
// ---------------------------------------------------------------------------

/**
 * Unix timestamp (seconds) of the last successful watchdog tick.
 * Stays at 0 until the first tick completes. An alert rule can fire
 * when `time() - relayer_refund_watchdog_last_run_timestamp_seconds > 2 * interval`.
 */
export const watchdogLastRunTimestamp = new Gauge({
  name: 'relayer_refund_watchdog_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last completed refund watchdog scan tick',
  registers: [registry],
});

/**
 * Age in seconds of the oldest stale order found in the last tick.
 * Useful for alert rules: if this keeps climbing, refunds are not landing.
 * Resets to 0 when no stale orders are found.
 */
export const watchdogMaxStaleAgeSeconds = new Gauge({
  name: 'relayer_refund_watchdog_max_stale_age_seconds',
  help: 'Age in seconds of the oldest stale order seen in the last watchdog tick',
  registers: [registry],
});

/**
 * Current number of orders in the active map that are in a stale/pending
 * refund state. Sampled at each tick.
 */
export const watchdogPendingRefundsGauge = new Gauge({
  name: 'relayer_refund_watchdog_pending_refunds',
  help: 'Number of orders currently awaiting a watchdog refund attempt',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Refund Watchdog histogram
// ---------------------------------------------------------------------------

/**
 * Duration in seconds of each full watchdog tick (scanning all active
 * orders). Lets you spot ticks that are unusually slow.
 */
export const watchdogTickDurationSeconds = new Histogram({
  name: 'relayer_refund_watchdog_tick_duration_seconds',
  help: 'Duration of a full refund watchdog tick in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Solana configuration
// ---------------------------------------------------------------------------

/**
 * Set to 1 when SOLANA_HTLC_PROGRAM is a placeholder (Solana flows
 * disabled), or 0 when a real program address is configured.
 * Useful for alerting operators that Solana support is inactive.
 */
export const solanaPlaceholderMode = new Gauge({
  name: 'relayer_solana_placeholder_mode',
  help: '1 when SOLANA_HTLC_PROGRAM is a placeholder and Solana flows are disabled, 0 when configured',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// XLM refund service counters
// ---------------------------------------------------------------------------

/**
 * Total refund submissions suppressed because the RefundLedger already
 * holds a committed or in-flight entry for that orderId. This is the
 * primary signal for exactly-once compliance.
 */
export const refundDuplicatesSuppressed = new Counter({
  name: 'relayer_xlm_refund_duplicates_suppressed_total',
  help: 'Total XLM refund attempts suppressed by the RefundLedger idempotency guard',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/**
 * Total Horizon submit calls that returned a 504, 408, or network-level
 * timeout. These are *ambiguous* — the tx may have landed. Callers should
 * mark the order ambiguous in the RefundLedger and not retry immediately.
 */
export const refundHorizonTimeouts = new Counter({
  name: 'relayer_xlm_refund_horizon_timeouts_total',
  help: 'Total Horizon submit calls that returned a timeout or 504 (ambiguous outcome)',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/**
 * Total intra-call retries performed for transient (non-terminal, non-timeout)
 * Horizon errors inside refundXlmToUser. One unit = one retry attempt, not
 * one overall refund invocation.
 */
export const refundHorizonRetries = new Counter({
  name: 'relayer_xlm_refund_horizon_retries_total',
  help: 'Total transient-error retries inside refundXlmToUser',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Convenience re-export
// ---------------------------------------------------------------------------

/** All watchdog metrics in one object ΓÇö useful for test assertions. */
export const watchdogMetrics = {
  runsTotal: watchdogRunsTotal,
  successTotal: watchdogRefundSuccessTotal,
  failureTotal: watchdogRefundFailureTotal,
  staleDetected: watchdogStaleOrdersDetected,
  backoffSkips: watchdogBackoffSkipsTotal,
  lastRunTimestamp: watchdogLastRunTimestamp,
  maxStaleAge: watchdogMaxStaleAgeSeconds,
  pendingRefunds: watchdogPendingRefundsGauge,
  tickDuration: watchdogTickDurationSeconds,
} as const;

/** All XLM refund service metrics in one object — useful for test assertions. */
export const refundMetrics = {
  duplicatesSuppressed: refundDuplicatesSuppressed,
  horizonTimeouts: refundHorizonTimeouts,
  horizonRetries: refundHorizonRetries,
} as const;

// ---------------------------------------------------------------------------
// XLM→ETH settlement path counters
// ---------------------------------------------------------------------------

/**
 * Total Horizon verification attempts on the XLM→ETH settlement path.
 *
 * `result` label values:
 *   success          — payment verified; ETH release proceeded
 *   tx_not_found     — stellarTxHash unknown to Horizon (StellarTxNotFoundError)
 *   tx_failed        — tx was submitted but failed on-chain (StellarTxFailedError)
 *   payment_mismatch — tx exists but payment shape is wrong (StellarPaymentMismatch)
 *   horizon_error    — unexpected Horizon / network error
 */
export const settlementVerificationTotal = new Counter({
  name: 'relayer_xlm_to_eth_verification_total',
  help: 'Total Horizon verification attempts on the XLM→ETH settlement path',
  labelNames: ['result', 'network_mode'] as const,
  registers: [registry],
});

/**
 * Total requests rejected because the stellarTxHash was already consumed.
 * Each increment represents one replayed (or retried) proof that was blocked
 * before any ETH was sent.
 */
export const settlementProofReplaysTotal = new Counter({
  name: 'relayer_xlm_to_eth_proof_replays_total',
  help: 'Total XLM→ETH settlement requests rejected due to a replayed stellarTxHash',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/** All XLM→ETH settlement metrics in one object — useful for test assertions. */
export const settlementMetrics = {
  verificationTotal: settlementVerificationTotal,
  proofReplaysTotal: settlementProofReplaysTotal,
} as const;

// ---------------------------------------------------------------------------
// Pipeline observability — order ingestion, relay decision, submission,
// receipt, retries, queue depth, dropped orders, chain delay.
//
// These metrics give operators a complete picture of where in the pipeline
// an order is, how long each stage takes, and where pressure or failures
// accumulate.  Naming follows the existing convention:
//   relayer_<subsystem>_<name>_<unit>
//
// Label cardinality is kept low: `direction` (eth_to_xlm | xlm_to_eth),
// `chain` (ethereum | stellar), `result` (success | failure | ...).
// No order-level data (addresses, amounts, hashlocks) ever appears in labels.
// ---------------------------------------------------------------------------

/**
 * Total orders received at the ingestion boundary (POST /api/orders/create).
 *
 * Incremented immediately on every request that passes basic HTTP parsing,
 * before route-capability or permission checks.  Compare with
 * `relayer_relay_decision_total{result="accepted"}` to compute the
 * rejection rate at the policy boundary.
 *
 * `direction` label: the direction slug from the request body, or
 * "unknown" when the body is missing or malformed.
 */
export const orderIngestionTotal = new Counter({
  name: 'relayer_order_ingestion_total',
  help: 'Total orders received at the relayer ingestion boundary, by direction',
  labelNames: ['direction'] as const,
  registers: [registry],
});

/**
 * Current number of orders tracked in the relayer's active-order map.
 *
 * Sampled after every successful ingestion and after every terminal
 * state transition (settled, refunded, expired).  A steadily climbing
 * gauge with no corresponding decrease in settlement metrics indicates
 * orders are being accepted but not settling.
 */
export const orderQueueDepth = new Gauge({
  name: 'relayer_order_queue_depth',
  help: 'Current number of orders in the relayer active-order map',
  registers: [registry],
});

/**
 * Total relay-policy decisions, by direction and result.
 *
 * `result` label values:
 *   accepted              — route + permissions passed; order entered pipeline
 *   rejected_route        — decideOrderRoute returned supported=false
 *   rejected_permissions  — checkOrderSettleable returned a denial
 *   rejected_validation   — request body failed schema validation
 *
 * Use `rate(relayer_relay_decision_total{result!="accepted"}[5m])` to alert
 * on a sustained spike in policy rejections (could indicate a misconfiguration
 * or a client bug sending bad directions).
 */
export const relayDecisionTotal = new Counter({
  name: 'relayer_relay_decision_total',
  help: 'Total relay-policy decisions at order creation, by direction and result',
  labelNames: ['direction', 'result'] as const,
  registers: [registry],
});

/**
 * End-to-end submission latency: from the moment the relayer accepts an order
 * (route + permissions passed) to the moment the on-chain transaction hash
 * is confirmed or an error is returned.
 *
 * Measured in seconds.  Use p95/p99 to set SLO thresholds; a histogram
 * is more useful than a summary here because the distribution is bimodal
 * (fast testnet paths vs slow mainnet gas estimation + confirm loops).
 *
 * `direction` label identifies which bridge leg was submitted.
 * `result` is `success` or `failure`.
 */
export const submissionLatencySeconds = new Histogram({
  name: 'relayer_submission_latency_seconds',
  help: 'Latency from order acceptance to on-chain tx hash, in seconds',
  labelNames: ['direction', 'result'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
  registers: [registry],
});

/**
 * Receipt / proof-verification latency: from the moment the relayer
 * receives a settlement proof request (POST /api/orders/xlm-to-eth or
 * the xlm-proof branch of /api/orders/process) to the moment Horizon
 * verification completes (success or failure).
 *
 * This isolates the Horizon round-trip from the subsequent ETH release,
 * making it easy to spot when Horizon is slow without blaming the Ethereum
 * RPC.
 *
 * `result` values: `success`, `tx_not_found`, `tx_failed`,
 *   `payment_mismatch`, `horizon_error`.
 */
export const receiptLatencySeconds = new Histogram({
  name: 'relayer_receipt_latency_seconds',
  help: 'Latency for Horizon proof verification on the XLM→ETH path, in seconds',
  labelNames: ['result'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 20, 30],
  registers: [registry],
});

/**
 * Distribution of retry attempts per submission or Horizon call.
 *
 * One observation per *completed* submission attempt (whether it eventually
 * succeeded or exhausted retries).  The value is the number of retries
 * performed (0 = succeeded on first try, N = needed N extra attempts).
 *
 * `operation` label: `eth_send` | `balance_check` | `horizon_verify`.
 * `result`: `success` | `failure` (did the final attempt succeed?).
 *
 * A high p95 retry count for `eth_send` suggests RPC rate-limiting or
 * network instability; a high count for `horizon_verify` suggests Horizon
 * node issues.
 */
export const retryAttemptsHistogram = new Histogram({
  name: 'relayer_retry_attempts',
  help: 'Distribution of retry count per submission or verification attempt',
  labelNames: ['operation', 'result'] as const,
  buckets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  registers: [registry],
});

/**
 * Total orders dropped from the active-order map without reaching a
 * terminal settlement state.
 *
 * An order is "dropped" when the relayer cannot proceed and has no safe
 * retry path — e.g. a permanent Horizon error on the XLM→ETH path after
 * the proof was already consumed, or a fatal ETH transaction failure.
 *
 * `reason` label: a short stable code (not a raw error message):
 *   eth_tx_failed       — Ethereum send reverted or timed out fatally
 *   horizon_permanent   — Horizon returned a terminal error (tx_failed, etc.)
 *   proof_replay        — stellarTxHash already consumed
 *   permission_denied   — settlement permission check failed mid-flight
 *   internal_error      — unexpected exception with no safe retry
 */
export const droppedOrdersTotal = new Counter({
  name: 'relayer_dropped_orders_total',
  help: 'Total orders dropped without reaching a terminal settlement state, by reason',
  labelNames: ['direction', 'reason'] as const,
  registers: [registry],
});

/**
 * Observed delay between the expected and actual processing time for a
 * chain event or settlement step, per chain.
 *
 * Set to a non-negative number of seconds after each settlement step
 * completes.  The value represents how far behind "real time" that step
 * was — for example, if the relayer expected to confirm an ETH tx within
 * 30 s but it took 90 s, the gauge is set to 60.
 *
 * Reset to 0 when the step completes on time.  A persistently elevated
 * gauge for a specific chain indicates congestion or RPC node issues on
 * that chain.
 *
 * `chain` label: `ethereum` | `stellar`.
 */
export const chainDelayGauge = new Gauge({
  name: 'relayer_chain_delay_seconds',
  help: 'Observed delay beyond expected processing time for the most recent step, per chain',
  labelNames: ['chain'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Convenience re-export
// ---------------------------------------------------------------------------

/** All pipeline observability metrics in one object — useful for test assertions. */
export const pipelineMetrics = {
  ingestionTotal: orderIngestionTotal,
  queueDepth: orderQueueDepth,
  relayDecisionTotal,
  submissionLatency: submissionLatencySeconds,
  receiptLatency: receiptLatencySeconds,
  retryAttempts: retryAttemptsHistogram,
  droppedOrders: droppedOrdersTotal,
  chainDelay: chainDelayGauge,
} as const;
