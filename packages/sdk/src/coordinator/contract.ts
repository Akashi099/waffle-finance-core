/**
 * Coordinator HTTP API — typed wire contract.
 *
 * Every interface in this file mirrors an exact JSON shape that the
 * coordinator currently produces or consumes. They are intentionally
 * additive: new optional fields can be introduced on the backend without
 * breaking existing SDK consumers because TypeScript's structural typing
 * silently ignores unknown fields on assignment.
 *
 * Versioning strategy
 * ───────────────────
 * The coordinator does not yet embed a version token in every response, but
 * it does expose `version` in /health. To stay forward-compatible the SDK
 * marks all "new field" additions as optional (`field?: T`). If the backend
 * later adds a required field the SDK type is updated first, so the SDK
 * version gate moves to package semver rather than a runtime check.
 *
 * When a new field MUST exist to drive behaviour (e.g. a new status value)
 * a narrowGuard helper is provided so callers can opt in to the strict check
 * without breaking older consumers.
 */

import type { Chain, Direction, OrderStatus } from "../types/index.js";

// ── Supported directions on the coordinator (subset of SDK Direction) ────────

/**
 * The four swap directions the coordinator currently supports. The SDK
 * `Direction` type contains two additional values (`xlm_to_sol`,
 * `sol_to_xlm`) that are not yet live on the backend; CoordinatorDirection
 * represents only what the API actually accepts.
 */
export type CoordinatorDirection = "eth_to_xlm" | "xlm_to_eth" | "eth_to_sol" | "sol_to_eth";

// ── Wire shapes — responses ─────────────────────────────────────────────────

/** Source or destination leg as serialised by the coordinator. */
export interface CoordinatorChainLeg {
  chain: Chain;
  address: string;
  asset: string;
  /** Atomic units, decimal string. */
  amount: string;
  /** Present on source leg only. */
  safetyDeposit?: string;
  /** On-chain order id once the leg is locked. Null until then. */
  orderId: string | null;
  /** Transaction hash that created the on-chain lock. Null until locked. */
  lockTx: string | null;
  /** Block number of the lock transaction. Null until locked. */
  lockBlock: number | null;
  /** Absolute timelock as unix seconds. Null until locked. */
  timelock: number | null;
}

/** Secret block returned on GET /api/orders/:id. */
export interface CoordinatorSecretBlock {
  /** True once the preimage has been revealed. */
  revealed: boolean;
  /**
   * The preimage value. Present only once revealed AND only if the
   * caller is a trusted operator. For public consumers this is null
   * even after reveal — use GET /api/secrets/:id instead.
   */
  preimage: string | null;
  /** Transaction hash of the reveal tx. Null until revealed. */
  revealedTx: string | null;
}

/**
 * A single order as returned by:
 *   GET  /api/orders/:id
 *   POST /api/orders/announce  (201 response)
 *   GET  /api/orders/history   (inside `transactions` array)
 */
export interface CoordinatorOrder {
  /** Canonical public order ID: `wf_0x<64-hex-chars>`. */
  id: string;
  direction: CoordinatorDirection;
  status: OrderStatus;
  /** SHA-256 hashlock as 0x-prefixed 64-char hex. */
  hashlock: string;
  src: CoordinatorChainLeg;
  dst: CoordinatorChainLeg;
  secret: CoordinatorSecretBlock;
  /** Resolver ETH address if a resolver filled the dst leg. Null otherwise. */
  resolver: string | null;
  /** Unix seconds when the order was first announced. */
  createdAt: number;
  /** Unix seconds of the most recent status update. */
  updatedAt: number;
}

/** Pagination metadata for offset-based history (legacy). */
export interface CoordinatorOffsetPagination {
  limit: number;
  offset: number;
  count: number;
}

/** Pagination metadata for cursor-based history (preferred). */
export interface CoordinatorCursorPagination {
  limit: number;
  count: number;
  /** Opaque base64url cursor. Null when there are no further pages. */
  nextCursor: string | null;
}

/** Response envelope for GET /api/orders/history. */
export interface CoordinatorHistoryResponse {
  transactions: CoordinatorOrder[];
  pagination: CoordinatorOffsetPagination | CoordinatorCursorPagination;
}

/** Response for GET /api/secrets/:publicId. */
export interface CoordinatorSecretResponse {
  publicId: string;
  preimage: string;
}

/** Response for POST /api/secrets/reveal (success). */
export interface CoordinatorRevealResponse {
  ok: true;
}

/**
 * Error envelope returned by the coordinator on 4xx/5xx responses.
 * The `error` field is a stable machine-readable code; `message` is
 * human-readable and may change between releases.
 */
export interface CoordinatorErrorResponse {
  error: string;
  message: string;
  /** Only present on SecretRevealError subtypes. */
  retryable?: boolean;
}

/** Response for GET /health. */
export interface CoordinatorHealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  reconciliation?: {
    lastRunAt: number | null;
    lastRunOk: boolean | null;
    eventsReplayed: number;
  } | null;
}

/** Response for GET /readyz. */
export interface CoordinatorReadinessResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: Array<{
    name: string;
    ok: boolean;
    detail?: string;
    latencyMs?: number;
  }>;
}

// ── Wire shapes — requests ──────────────────────────────────────────────────

/**
 * Body for POST /api/orders/announce.
 * Field names and types mirror the coordinator's `announceSchema` exactly.
 */
export interface CoordinatorAnnounceRequest {
  direction: CoordinatorDirection;
  hashlock: string;
  srcChain: Chain;
  srcAddress: string;
  srcAsset: string;
  /** Atomic units, decimal string. */
  srcAmount: string;
  /** Atomic units, decimal string. */
  srcSafetyDeposit: string;
  dstChain: Chain;
  dstAddress: string;
  dstAsset: string;
  /** Atomic units, decimal string. */
  dstAmount: string;
}

/** Body for POST /api/secrets/reveal. */
export interface CoordinatorRevealRequest {
  publicId: string;
  /** 0x-prefixed hex preimage. */
  preimage: string;
  /** Transaction hash of the reveal. */
  txHash: string;
}

// ── Type guards ─────────────────────────────────────────────────────────────

/** Narrow a pagination block to the cursor variant. */
export function isCursorPagination(
  p: CoordinatorOffsetPagination | CoordinatorCursorPagination
): p is CoordinatorCursorPagination {
  return "nextCursor" in p;
}

/** True when the response is an error envelope. */
export function isCoordinatorError(body: unknown): body is CoordinatorErrorResponse {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as CoordinatorErrorResponse).error === "string"
  );
}
