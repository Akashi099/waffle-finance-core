/**
 * Frontend analytics event contract for bridge-order user journeys.
 *
 * Design goals
 * ────────────
 * 1. Every instrumented moment carries a stable orderId (when known) and a
 *    sessionId so events from the same page load can be grouped.
 * 2. No PII and no raw financial amounts. Fields are limited to identifiers,
 *    chain/direction metadata, and boolean outcome flags.
 * 3. The event shape is JSON-serialisable and localStorage-safe.
 * 4. The transport layer is pluggable — `setAnalyticsTransport` lets the app
 *    swap console logging for a real collector without touching call sites.
 */

// ── Session identity ─────────────────────────────────────────────────────────

function generateSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Stable for the lifetime of the page load. Resets on full navigation. */
export const SESSION_ID: string = generateSessionId();

// ── Event kinds ───────────────────────────────────────────────────────────────

/**
 * Exhaustive union of measurable moments in the bridge user journey.
 *
 * Naming convention: <noun>_<verb> in past tense where applicable,
 * present tense for selections/actions the user initiates.
 */
export type BridgeAnalyticsEventKind =
  /** User picks or swaps the bridge direction. */
  | 'route_selected'
  /** A quote/rate fetch completes (success or failure). */
  | 'quote_refreshed'
  /** Order announcement sent to coordinator. */
  | 'order_announced'
  /** On-chain lock transaction submitted. */
  | 'lock_submitted'
  /** Settlement confirmed on the destination chain. */
  | 'settlement_observed'
  /** User initiates or the system detects a failure-recovery action. */
  | 'failure_recovery_initiated';

// ── Per-kind payload shapes ───────────────────────────────────────────────────

export interface RouteSelectedPayload {
  kind: 'route_selected';
  direction: string;
}

export interface QuoteRefreshedPayload {
  kind: 'quote_refreshed';
  pair: string;
  staleness: 'fresh' | 'stale' | 'fallback';
  success: boolean;
}

export interface OrderAnnouncedPayload {
  kind: 'order_announced';
  orderId: string;
  direction: string;
  srcChain: string;
  dstChain: string;
}

export interface LockSubmittedPayload {
  kind: 'lock_submitted';
  orderId: string;
  direction: string;
  txHash: string | null;
}

export interface SettlementObservedPayload {
  kind: 'settlement_observed';
  orderId: string;
  finalStatus: string;
  dstTxHash: string | null;
}

export interface FailureRecoveryInitiatedPayload {
  kind: 'failure_recovery_initiated';
  orderId: string | null;
  reason: string;
  retryable: boolean;
}

export type BridgeAnalyticsEventPayload =
  | RouteSelectedPayload
  | QuoteRefreshedPayload
  | OrderAnnouncedPayload
  | LockSubmittedPayload
  | SettlementObservedPayload
  | FailureRecoveryInitiatedPayload;

// ── Top-level event envelope ──────────────────────────────────────────────────

/**
 * The envelope that every analytics event is wrapped in before dispatch.
 *
 * Guaranteed fields: `sessionId`, `at`, and the discriminated `payload`.
 * `requestId` is propagated from coordinator responses when available so
 * frontend events can be joined with backend log entries.
 */
export interface BridgeAnalyticsEvent {
  sessionId: string;
  /** Unix ms when the event was produced client-side. */
  at: number;
  /** Coordinator requestId from the most recent API response, if captured. */
  requestId: string | null;
  payload: BridgeAnalyticsEventPayload;
}

// ── Transport ─────────────────────────────────────────────────────────────────

export type AnalyticsTransport = (event: BridgeAnalyticsEvent) => void;

let _transport: AnalyticsTransport = (event) => {
  // Default: structured console output so events are visible during development
  // without any external dependency. Production deployments replace this via
  // setAnalyticsTransport() before the first user action.
  if (typeof console !== 'undefined' && process?.env?.NODE_ENV !== 'test') {
    console.debug('[analytics]', event.payload.kind, event);
  }
};

/** Replace the transport. Call once at app startup. */
export function setAnalyticsTransport(transport: AnalyticsTransport): void {
  _transport = transport;
}

// ── Captured coordinator request ID ──────────────────────────────────────────

let _lastRequestId: string | null = null;

/**
 * Record the most recent coordinator X-Request-ID so subsequent analytics
 * events can carry it for cross-system tracing.
 */
export function captureCoordinatorRequestId(id: string | null): void {
  _lastRequestId = id;
}

// ── Emit ──────────────────────────────────────────────────────────────────────

/**
 * Emit a bridge analytics event through the configured transport.
 *
 * This is the single call site all instrumentation points use. It is
 * intentionally synchronous and never throws — a broken analytics path must
 * never affect the user-facing bridge flow.
 */
export function emitAnalyticsEvent(payload: BridgeAnalyticsEventPayload): void {
  try {
    const event: BridgeAnalyticsEvent = {
      sessionId: SESSION_ID,
      at: Date.now(),
      requestId: _lastRequestId,
      payload,
    };
    _transport(event);
  } catch {
    // Swallow — analytics must never break the bridge.
  }
}

// ── Typed helpers (call-site convenience) ─────────────────────────────────────

export function trackRouteSelected(direction: string): void {
  emitAnalyticsEvent({ kind: 'route_selected', direction });
}

export function trackQuoteRefreshed(
  pair: string,
  staleness: QuoteRefreshedPayload['staleness'],
  success: boolean
): void {
  emitAnalyticsEvent({ kind: 'quote_refreshed', pair, staleness, success });
}

export function trackOrderAnnounced(
  orderId: string,
  direction: string,
  srcChain: string,
  dstChain: string
): void {
  emitAnalyticsEvent({ kind: 'order_announced', orderId, direction, srcChain, dstChain });
}

export function trackLockSubmitted(
  orderId: string,
  direction: string,
  txHash: string | null
): void {
  emitAnalyticsEvent({ kind: 'lock_submitted', orderId, direction, txHash });
}

export function trackSettlementObserved(
  orderId: string,
  finalStatus: string,
  dstTxHash: string | null
): void {
  emitAnalyticsEvent({ kind: 'settlement_observed', orderId, finalStatus, dstTxHash });
}

export function trackFailureRecoveryInitiated(
  orderId: string | null,
  reason: string,
  retryable: boolean
): void {
  emitAnalyticsEvent({ kind: 'failure_recovery_initiated', orderId, reason, retryable });
}
