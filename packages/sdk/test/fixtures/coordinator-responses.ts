/**
 * Deterministic coordinator wire-response fixtures shared across SDK tests.
 *
 * These mirror the exact JSON shapes CoordinatorClient/HistoryClient/
 * OrderSubscriber consume in production (see src/coordinator/contract.ts),
 * covering the happy path plus recovery-relevant shapes: partial order
 * states, malformed/unexpected error envelopes, and mixed-chain history
 * pages. Centralising them keeps new tests aligned with the real contract
 * instead of each test file inventing slightly different fixtures.
 */
import type {
  CoordinatorOrder,
  CoordinatorErrorResponse,
  CoordinatorHistoryResponse,
  CoordinatorChainLeg,
} from "../../src/coordinator/contract.js";

export const ETH_ADDR = "0x1111111111111111111111111111111111111111";
export const XLM_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
export const SOL_ADDR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export const HASHLOCK_A = "0x" + "ab".repeat(32);
export const HASHLOCK_B = "0x" + "cd".repeat(32);

function unlockedLeg(overrides: Partial<CoordinatorChainLeg> = {}): CoordinatorChainLeg {
  return {
    chain: "ethereum",
    address: ETH_ADDR,
    asset: "native",
    amount: "1000000000000000000",
    orderId: null,
    lockTx: null,
    lockBlock: null,
    timelock: null,
    ...overrides,
  };
}

/** A freshly announced order — neither leg locked yet. */
export function announcedOrder(overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  return {
    id: `wf_${HASHLOCK_A}`,
    direction: "eth_to_xlm",
    status: "announced",
    hashlock: HASHLOCK_A,
    src: unlockedLeg({ chain: "ethereum", address: ETH_ADDR, safetyDeposit: "1000000000000000" }),
    dst: unlockedLeg({ chain: "stellar", address: XLM_ADDR, amount: "100000000" }),
    secret: { revealed: false, preimage: null, revealedTx: null },
    resolver: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

/**
 * Partial state: source leg locked, destination leg still untouched. This
 * is the most common "in-flight" shape a subscriber/history poll observes —
 * a resolver hasn't filled the destination leg yet.
 */
export function partialSrcLockedOrder(overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  const base = announcedOrder();
  return {
    ...base,
    status: "src_locked",
    src: {
      ...base.src,
      orderId: "42",
      lockTx: "0xaaaa",
      lockBlock: 19_000_000,
      timelock: 1_700_003_600,
    },
    resolver: null,
    updatedAt: 1_700_000_300,
    ...overrides,
  };
}

/** Both legs locked, secret not yet revealed. */
export function bothLegsLockedOrder(overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  const base = partialSrcLockedOrder();
  return {
    ...base,
    status: "dst_locked",
    dst: {
      ...base.dst,
      orderId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
      lockTx: "soroban-tx-hash",
      lockBlock: null,
      timelock: 1_700_003_000,
    },
    resolver: "0x2222222222222222222222222222222222222222",
    updatedAt: 1_700_000_600,
    ...overrides,
  };
}

/** Terminal: secret revealed and order completed. */
export function completedOrder(overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  const base = bothLegsLockedOrder();
  return {
    ...base,
    status: "completed",
    secret: { revealed: true, preimage: null, revealedTx: "0xreveal" },
    updatedAt: 1_700_001_000,
    ...overrides,
  };
}

/** Terminal: refunded after timelock expiry — destination leg never locked. */
export function refundedOrder(overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  const base = partialSrcLockedOrder();
  return {
    ...base,
    status: "refunded",
    src: { ...base.src, lockTx: "0xaaaa" },
    updatedAt: 1_700_010_000,
    ...overrides,
  };
}

/** A well-formed coordinator error envelope (matches CoordinatorErrorResponse). */
export function errorEnvelope(overrides: Partial<CoordinatorErrorResponse> = {}): CoordinatorErrorResponse {
  return {
    error: "order_not_found",
    message: "No order exists for the given public ID",
    ...overrides,
  };
}

/**
 * A malformed response body: not a valid CoordinatorErrorResponse (missing
 * the required `error` string field) even though the HTTP status is non-2xx.
 * Exercises the "unknown_error" fallback path in CoordinatorClient.
 */
export function malformedErrorBody(): unknown {
  return { message: "something went wrong", statusCode: 500 };
}

/**
 * A mixed-chain history page: one order per coordinator-supported direction,
 * in different lifecycle states, as a wallet with cross-chain activity would
 * actually see it in a single page.
 */
export function mixedChainHistoryPage(): CoordinatorHistoryResponse {
  return {
    transactions: [
      completedOrder({ id: `wf_${HASHLOCK_A}`, direction: "eth_to_xlm" }),
      partialSrcLockedOrder({
        id: `wf_${HASHLOCK_B}`,
        hashlock: HASHLOCK_B,
        direction: "eth_to_sol",
        src: unlockedLeg({ chain: "ethereum", address: ETH_ADDR, orderId: "7", lockTx: "0xbbbb", timelock: 1_700_004_000 }),
        dst: unlockedLeg({ chain: "solana", address: SOL_ADDR, amount: "500000000" }),
      }),
      refundedOrder({ id: `wf_0x${"ef".repeat(32)}`, hashlock: "0x" + "ef".repeat(32), direction: "sol_to_eth" }),
    ],
    pagination: { limit: 50, count: 3, nextCursor: null },
  };
}
