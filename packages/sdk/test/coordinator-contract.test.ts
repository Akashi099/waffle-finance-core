/**
 * Tests for the coordinator compatibility contract.
 *
 * Covers:
 *   - Wire-type shape guards (isCursorPagination, isCoordinatorError)
 *   - CoordinatorOrder → SDK Order transform (toOrder)
 *   - CoordinatorOrder → HistoryRecord transform (toHistoryRecord)
 *   - validateAnnounceRequest: valid payloads pass
 *   - validateAnnounceRequest: each invalid class is caught locally
 *   - assertValidAnnounceRequest: throws CoordinatorValidationError
 *   - DIRECTION_CHAINS alignment matches the coordinator's own map
 *
 * These tests do NOT make network calls — they exercise only the local
 * typing and transformation logic.
 */

import { describe, it, expect } from "vitest";
import {
  isCursorPagination,
  isCoordinatorError,
  toOrder,
  toOrders,
  toHistoryRecord,
  validateAnnounceRequest,
  assertValidAnnounceRequest,
  DIRECTION_CHAINS,
  SUPPORTED_DIRECTIONS,
  CoordinatorValidationError,
} from "../src/coordinator/index.js";
import type { CoordinatorOrder } from "../src/coordinator/index.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ETH_ADDR = "0x1111111111111111111111111111111111111111";
const XLM_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const SOL_ADDR = "11111111111111111111111111111111";
const HASHLOCK = "0x" + "ab".repeat(32);

function makeOrder(overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  return {
    id: `wf_${HASHLOCK}`,
    direction: "eth_to_xlm",
    status: "announced",
    hashlock: HASHLOCK,
    src: {
      chain: "ethereum",
      address: ETH_ADDR,
      asset: "native",
      amount: "1000000000000000000",
      safetyDeposit: "1000000000000000",
      orderId: null,
      lockTx: null,
      lockBlock: null,
      timelock: null,
    },
    dst: {
      chain: "stellar",
      address: XLM_ADDR,
      asset: "native",
      amount: "100000000",
      orderId: null,
      lockTx: null,
      lockBlock: null,
      timelock: null,
    },
    secret: { revealed: false, preimage: null, revealedTx: null },
    resolver: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

const VALID_ANNOUNCE = {
  direction: "eth_to_xlm" as const,
  hashlock: HASHLOCK,
  srcChain: "ethereum" as const,
  srcAddress: ETH_ADDR,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar" as const,
  dstAddress: XLM_ADDR,
  dstAsset: "native",
  dstAmount: "100000000",
};

// ── Type guard tests ─────────────────────────────────────────────────────────

describe("isCursorPagination", () => {
  it("returns true for cursor pagination", () => {
    expect(isCursorPagination({ limit: 50, count: 10, nextCursor: null })).toBe(true);
  });

  it("returns false for offset pagination", () => {
    expect(isCursorPagination({ limit: 50, count: 10, offset: 0 })).toBe(false);
  });
});

describe("isCoordinatorError", () => {
  it("identifies error envelopes", () => {
    expect(isCoordinatorError({ error: "not_found", message: "Order not found" })).toBe(true);
  });

  it("rejects non-error objects", () => {
    expect(isCoordinatorError({ id: "wf_0xabc", status: "announced" })).toBe(false);
    expect(isCoordinatorError(null)).toBe(false);
    expect(isCoordinatorError("string")).toBe(false);
  });
});

// ── Transform: toOrder ────────────────────────────────────────────────────────

describe("toOrder", () => {
  it("maps coordinator id to SDK publicId", () => {
    const order = toOrder(makeOrder());
    expect(order.publicId).toBe(`wf_${HASHLOCK}`);
  });

  it("preserves direction and status", () => {
    const order = toOrder(makeOrder({ direction: "sol_to_eth", status: "src_locked" }));
    expect(order.direction).toBe("sol_to_eth");
    expect(order.status).toBe("src_locked");
  });

  it("flattens secret.preimage to order.preimage", () => {
    const preimage = "0x" + "cc".repeat(32);
    const order = toOrder(
      makeOrder({ secret: { revealed: true, preimage, revealedTx: "0xtx" } })
    );
    expect(order.preimage).toBe(preimage);
  });

  it("sets preimage to null when not revealed", () => {
    const order = toOrder(makeOrder());
    expect(order.preimage).toBeNull();
  });

  it("forwards src leg fields", () => {
    const order = toOrder(makeOrder());
    expect(order.src.chain).toBe("ethereum");
    expect(order.src.address).toBe(ETH_ADDR);
    expect(order.src.safetyDeposit).toBe("1000000000000000");
  });

  it("drops lockBlock (coordinator-internal)", () => {
    const order = toOrder(makeOrder());
    expect((order.src as Record<string, unknown>)["lockBlock"]).toBeUndefined();
  });

  it("converts an array with toOrders", () => {
    const orders = toOrders([makeOrder(), makeOrder({ status: "src_locked" })]);
    expect(orders).toHaveLength(2);
    expect(orders[1]?.status).toBe("src_locked");
  });
});

// ── Transform: toHistoryRecord ────────────────────────────────────────────────

describe("toHistoryRecord", () => {
  it("preserves all stable fields", () => {
    const rec = toHistoryRecord(makeOrder());
    expect(rec.id).toBe(`wf_${HASHLOCK}`);
    expect(rec.direction).toBe("eth_to_xlm");
    expect(rec.status).toBe("announced");
    expect(rec.hashlock).toBe(HASHLOCK);
    expect(rec.createdAt).toBe(1_700_000_000);
    expect(rec.updatedAt).toBe(1_700_000_000);
  });

  it("normalises null leg fields to null (not undefined)", () => {
    const rec = toHistoryRecord(makeOrder());
    expect(rec.src.orderId).toBeNull();
    expect(rec.src.lockTx).toBeNull();
    expect(rec.src.timelock).toBeNull();
    expect(rec.dst.orderId).toBeNull();
    expect(rec.dst.lockTx).toBeNull();
    expect(rec.dst.timelock).toBeNull();
  });

  it("normalises safetyDeposit correctly on src and dst", () => {
    const rec = toHistoryRecord(makeOrder());
    expect(rec.src.safetyDeposit).toBe("1000000000000000");
    // dst never has safetyDeposit in the coordinator schema
    expect("safetyDeposit" in rec.dst).toBe(false);
  });

  it("reflects secret block faithfully", () => {
    const preimage = "0x" + "dd".repeat(32);
    const rec = toHistoryRecord(
      makeOrder({ secret: { revealed: true, preimage, revealedTx: "0xtx2" } })
    );
    expect(rec.secret.revealed).toBe(true);
    expect(rec.secret.preimage).toBe(preimage);
    expect(rec.secret.revealedTx).toBe("0xtx2");
  });

  it("handles partial src_locked order (dst still null)", () => {
    const locked = makeOrder({
      status: "src_locked",
      src: {
        chain: "ethereum",
        address: ETH_ADDR,
        asset: "native",
        amount: "1000000000000000000",
        safetyDeposit: "1000000000000000",
        orderId: "42",
        lockTx: "0x" + "aa".repeat(32),
        lockBlock: 100,
        timelock: 1_800_000_000,
      },
    });
    const rec = toHistoryRecord(locked);
    expect(rec.src.orderId).toBe("42");
    expect(rec.src.lockTx).toBe("0x" + "aa".repeat(32));
    expect(rec.src.timelock).toBe(1_800_000_000);
    expect(rec.dst.orderId).toBeNull();
  });
});

// ── DIRECTION_CHAINS alignment ───────────────────────────────────────────────

describe("DIRECTION_CHAINS", () => {
  it("covers all four coordinator-supported directions", () => {
    expect(Object.keys(DIRECTION_CHAINS)).toEqual(
      expect.arrayContaining(["eth_to_xlm", "xlm_to_eth", "eth_to_sol", "sol_to_eth"])
    );
  });

  it("eth_to_xlm maps ethereum → stellar", () => {
    expect(DIRECTION_CHAINS["eth_to_xlm"]).toEqual({ src: "ethereum", dst: "stellar" });
  });

  it("sol_to_eth maps solana → ethereum", () => {
    expect(DIRECTION_CHAINS["sol_to_eth"]).toEqual({ src: "solana", dst: "ethereum" });
  });

  it("SUPPORTED_DIRECTIONS matches DIRECTION_CHAINS keys", () => {
    expect([...SUPPORTED_DIRECTIONS].sort()).toEqual(Object.keys(DIRECTION_CHAINS).sort());
  });
});

// ── validateAnnounceRequest — valid payloads ──────────────────────────────────

describe("validateAnnounceRequest — valid payloads", () => {
  it("accepts a valid eth_to_xlm request", () => {
    const result = validateAnnounceRequest(VALID_ANNOUNCE);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("accepts a valid sol_to_eth request", () => {
    const result = validateAnnounceRequest({
      direction: "sol_to_eth",
      hashlock: HASHLOCK,
      srcChain: "solana",
      srcAddress: SOL_ADDR,
      srcAsset: "native",
      srcAmount: "1000000000",
      srcSafetyDeposit: "1000000",
      dstChain: "ethereum",
      dstAddress: ETH_ADDR,
      dstAsset: "native",
      dstAmount: "280000000000000000",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid eth_to_sol request", () => {
    const result = validateAnnounceRequest({
      direction: "eth_to_sol",
      hashlock: HASHLOCK,
      srcChain: "ethereum",
      srcAddress: ETH_ADDR,
      srcAsset: "native",
      srcAmount: "100000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "solana",
      dstAddress: SOL_ADDR,
      dstAsset: "native",
      dstAmount: "666000000",
    });
    expect(result.ok).toBe(true);
  });
});

// ── validateAnnounceRequest — invalid payloads ────────────────────────────────

describe("validateAnnounceRequest — invalid payloads", () => {
  it("rejects non-object input", () => {
    expect(validateAnnounceRequest(null).ok).toBe(false);
    expect(validateAnnounceRequest("string").ok).toBe(false);
    expect(validateAnnounceRequest(42).ok).toBe(false);
  });

  it("rejects unsupported direction", () => {
    const result = validateAnnounceRequest({ ...VALID_ANNOUNCE, direction: "xlm_to_sol" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "direction")).toBe(true);
  });

  it("rejects malformed hashlock (wrong length)", () => {
    const result = validateAnnounceRequest({ ...VALID_ANNOUNCE, hashlock: "0xaabb" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "hashlock")).toBe(true);
  });

  it("rejects hashlock missing 0x prefix", () => {
    const result = validateAnnounceRequest({
      ...VALID_ANNOUNCE,
      hashlock: "ab".repeat(32),
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "hashlock")).toBe(true);
  });

  it("rejects wrong srcChain for direction (eth_to_xlm requires ethereum)", () => {
    const result = validateAnnounceRequest({
      ...VALID_ANNOUNCE,
      srcChain: "solana",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "srcChain")).toBe(true);
  });

  it("rejects wrong dstChain for direction (eth_to_xlm requires stellar)", () => {
    const result = validateAnnounceRequest({
      ...VALID_ANNOUNCE,
      dstChain: "solana",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "dstChain")).toBe(true);
  });

  it("rejects invalid Ethereum srcAddress", () => {
    const result = validateAnnounceRequest({ ...VALID_ANNOUNCE, srcAddress: "not-an-address" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "srcAddress")).toBe(true);
  });

  it("rejects Ethereum zero address", () => {
    const result = validateAnnounceRequest({
      ...VALID_ANNOUNCE,
      srcAddress: "0x0000000000000000000000000000000000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "srcAddress")).toBe(true);
  });

  it("rejects invalid Stellar dstAddress", () => {
    const result = validateAnnounceRequest({ ...VALID_ANNOUNCE, dstAddress: "BNOTASTELLARKEY" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "dstAddress")).toBe(true);
  });

  it("rejects non-decimal srcAmount", () => {
    const result = validateAnnounceRequest({ ...VALID_ANNOUNCE, srcAmount: "1.5" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "srcAmount")).toBe(true);
  });

  it("rejects non-decimal dstAmount", () => {
    const result = validateAnnounceRequest({ ...VALID_ANNOUNCE, dstAmount: "1e18" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "dstAmount")).toBe(true);
  });

  it("rejects empty srcAsset", () => {
    const result = validateAnnounceRequest({ ...VALID_ANNOUNCE, srcAsset: "" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === "srcAsset")).toBe(true);
  });

  it("collects ALL issues in a single pass", () => {
    // Multiple bad fields at once
    const result = validateAnnounceRequest({
      ...VALID_ANNOUNCE,
      hashlock: "badhash",
      srcAmount: "1.5",
      dstAmount: "not-a-number",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});

// ── assertValidAnnounceRequest ────────────────────────────────────────────────

describe("assertValidAnnounceRequest", () => {
  it("does not throw for a valid payload", () => {
    expect(() => assertValidAnnounceRequest(VALID_ANNOUNCE)).not.toThrow();
  });

  it("throws CoordinatorValidationError for an invalid payload", () => {
    expect(() =>
      assertValidAnnounceRequest({ ...VALID_ANNOUNCE, hashlock: "bad" })
    ).toThrow(CoordinatorValidationError);
  });

  it("includes the failing field name in the error", () => {
    try {
      assertValidAnnounceRequest({ ...VALID_ANNOUNCE, srcAmount: "abc" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinatorValidationError);
      expect((err as CoordinatorValidationError).field).toBe("srcAmount");
    }
  });
});
