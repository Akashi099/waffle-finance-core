/**
 * Tests for the HistoryClient and toHistoryRecord normalisation.
 *
 * All tests use a stubbed CoordinatorClient — no network calls.
 *
 * Scenarios covered:
 *   - Empty result set
 *   - Partial records (announced order, no locks yet)
 *   - Full lifecycle record (src + dst locked, secret revealed)
 *   - Stale query: fetchedAt timestamp is set correctly
 *   - Cursor pagination: nextCursor is forwarded from the wire response
 *   - Legacy offset pagination: nextCursor is null, offset is forwarded
 *   - getAll: walks multiple pages automatically
 *   - getRecord: fetches a single order and returns HistoryRecord | null
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HistoryClient, toHistoryRecord } from "../src/coordinator/history-client.js";
import type { CoordinatorClient } from "../src/coordinator/client.js";
import type { CoordinatorOrder, CoordinatorHistoryResponse } from "../src/coordinator/contract.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ETH_ADDR = "0x1111111111111111111111111111111111111111";
const XLM_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK_A = "0x" + "aa".repeat(32);
const HASHLOCK_B = "0x" + "bb".repeat(32);

function makeWireOrder(id: string, hashlock: string, overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  return {
    id,
    direction: "eth_to_xlm",
    status: "announced",
    hashlock,
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

function makeCursorResponse(
  orders: CoordinatorOrder[],
  nextCursor: string | null = null
): CoordinatorHistoryResponse {
  return {
    transactions: orders,
    pagination: { limit: 50, count: orders.length, nextCursor },
  };
}

function makeOffsetResponse(
  orders: CoordinatorOrder[],
  offset = 0
): CoordinatorHistoryResponse {
  return {
    transactions: orders,
    pagination: { limit: 50, offset, count: orders.length },
  };
}

// ── Stub factory ─────────────────────────────────────────────────────────────

function makeStubClient(
  getHistoryImpl: (opts: Parameters<CoordinatorClient["getHistory"]>[0]) => Promise<CoordinatorHistoryResponse>,
  getOrderImpl?: (id: string) => Promise<CoordinatorOrder | null>
): CoordinatorClient {
  return {
    getHistory: vi.fn(getHistoryImpl),
    getOrder: vi.fn(getOrderImpl ?? (() => Promise.resolve(null))),
    announceOrder: vi.fn(),
    revealSecret: vi.fn(),
    getSecret: vi.fn(),
    getHealth: vi.fn(),
    getReadiness: vi.fn(),
  } as unknown as CoordinatorClient;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HistoryClient.getPage", () => {
  it("returns an empty page when the coordinator returns no transactions", async () => {
    const client = makeStubClient(async () => makeCursorResponse([]));
    const history = new HistoryClient({ coordinatorClient: client });

    const page = await history.getPage({ address: ETH_ADDR });

    expect(page.records).toHaveLength(0);
    expect(page.pagination.count).toBe(0);
    expect(page.pagination.nextCursor).toBeNull();
    expect(typeof page.fetchedAt).toBe("number");
  });

  it("sets fetchedAt to a recent timestamp", async () => {
    const before = Date.now();
    const client = makeStubClient(async () => makeCursorResponse([]));
    const history = new HistoryClient({ coordinatorClient: client });

    const page = await history.getPage({ address: ETH_ADDR });

    expect(page.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(page.fetchedAt).toBeLessThanOrEqual(Date.now());
  });

  it("normalises a partial announced record (all lock fields null)", async () => {
    const wire = makeWireOrder(`wf_${HASHLOCK_A}`, HASHLOCK_A);
    const client = makeStubClient(async () => makeCursorResponse([wire]));
    const history = new HistoryClient({ coordinatorClient: client });

    const page = await history.getPage({ address: ETH_ADDR });
    const rec = page.records[0]!;

    expect(rec.status).toBe("announced");
    expect(rec.src.orderId).toBeNull();
    expect(rec.src.lockTx).toBeNull();
    expect(rec.src.timelock).toBeNull();
    expect(rec.dst.orderId).toBeNull();
    expect(rec.secret.revealed).toBe(false);
    expect(rec.secret.preimage).toBeNull();
  });

  it("normalises a fully locked + revealed record", async () => {
    const preimage = "0x" + "cc".repeat(32);
    const wire = makeWireOrder(`wf_${HASHLOCK_A}`, HASHLOCK_A, {
      status: "secret_revealed",
      src: {
        chain: "ethereum",
        address: ETH_ADDR,
        asset: "native",
        amount: "1000000000000000000",
        safetyDeposit: "1000000000000000",
        orderId: "7",
        lockTx: "0x" + "11".repeat(32),
        lockBlock: 500,
        timelock: 1_800_000_000,
      },
      dst: {
        chain: "stellar",
        address: XLM_ADDR,
        asset: "native",
        amount: "100000000",
        orderId: "xlm-001",
        lockTx: "0x" + "22".repeat(32),
        lockBlock: 600,
        timelock: 1_750_000_000,
      },
      secret: { revealed: true, preimage, revealedTx: "0x" + "33".repeat(32) },
      resolver: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    const client = makeStubClient(async () => makeCursorResponse([wire]));
    const history = new HistoryClient({ coordinatorClient: client });
    const page = await history.getPage({ address: ETH_ADDR });
    const rec = page.records[0]!;

    expect(rec.status).toBe("secret_revealed");
    expect(rec.src.orderId).toBe("7");
    expect(rec.src.lockTx).toBe("0x" + "11".repeat(32));
    expect(rec.src.timelock).toBe(1_800_000_000);
    expect(rec.dst.orderId).toBe("xlm-001");
    expect(rec.dst.timelock).toBe(1_750_000_000);
    expect(rec.secret.revealed).toBe(true);
    expect(rec.secret.preimage).toBe(preimage);
    expect(rec.resolver).toBe("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  it("forwards cursor pagination metadata", async () => {
    const wire = makeWireOrder(`wf_${HASHLOCK_A}`, HASHLOCK_A);
    const client = makeStubClient(async () =>
      makeCursorResponse([wire], "eyJjcmVhdGVkQXQiOjE3fQ")
    );
    const history = new HistoryClient({ coordinatorClient: client });

    const page = await history.getPage({ address: ETH_ADDR });

    expect(page.pagination.nextCursor).toBe("eyJjcmVhdGVkQXQiOjE3fQ");
    expect(page.pagination.count).toBe(1);
    expect(page.pagination.limit).toBe(50);
  });

  it("normalises legacy offset pagination (nextCursor is null)", async () => {
    const wire = makeWireOrder(`wf_${HASHLOCK_A}`, HASHLOCK_A);
    const client = makeStubClient(async () => makeOffsetResponse([wire], 0));
    const history = new HistoryClient({ coordinatorClient: client });

    const page = await history.getPage({ address: ETH_ADDR });

    expect(page.pagination.nextCursor).toBeNull();
    expect(page.pagination.offset).toBe(0);
  });

  it("passes address and limit through to the coordinator", async () => {
    const stub = vi.fn(async () => makeCursorResponse([]));
    const client = makeStubClient(stub);
    const history = new HistoryClient({ coordinatorClient: client });

    await history.getPage({ address: ETH_ADDR, limit: 10 });

    expect(stub).toHaveBeenCalledWith({ address: ETH_ADDR, limit: 10 });
  });
});

describe("HistoryClient.getAll", () => {
  it("returns all records across multiple pages", async () => {
    const orderA = makeWireOrder(`wf_${HASHLOCK_A}`, HASHLOCK_A);
    const orderB = makeWireOrder(`wf_${HASHLOCK_B}`, HASHLOCK_B);
    const cursor = "eyJpZCI6MX0";

    let call = 0;
    const stub = vi.fn(async (opts: { cursor?: string }) => {
      call++;
      if (call === 1) return makeCursorResponse([orderA], cursor);
      return makeCursorResponse([orderB], null);
    });

    const client = makeStubClient(stub as unknown as Parameters<typeof makeStubClient>[0]);
    const history = new HistoryClient({ coordinatorClient: client });

    const records = await history.getAll({ address: ETH_ADDR });

    expect(records).toHaveLength(2);
    expect(records[0]!.id).toBe(`wf_${HASHLOCK_A}`);
    expect(records[1]!.id).toBe(`wf_${HASHLOCK_B}`);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when first page is empty", async () => {
    const client = makeStubClient(async () => makeCursorResponse([]));
    const history = new HistoryClient({ coordinatorClient: client });

    const records = await history.getAll({ address: ETH_ADDR });
    expect(records).toHaveLength(0);
  });
});

describe("HistoryClient.getRecord", () => {
  it("returns null when the order does not exist", async () => {
    const client = makeStubClient(
      async () => makeCursorResponse([]),
      async () => null
    );
    const history = new HistoryClient({ coordinatorClient: client });

    const rec = await history.getRecord("wf_0x" + "ff".repeat(32));
    expect(rec).toBeNull();
  });

  it("returns a HistoryRecord for a known order", async () => {
    const wire = makeWireOrder(`wf_${HASHLOCK_A}`, HASHLOCK_A, { status: "dst_locked" });
    const client = makeStubClient(
      async () => makeCursorResponse([]),
      async () => wire
    );
    const history = new HistoryClient({ coordinatorClient: client });

    const rec = await history.getRecord(`wf_${HASHLOCK_A}`);
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("dst_locked");
  });
});

// ── toHistoryRecord edge cases ────────────────────────────────────────────────

describe("toHistoryRecord edge cases", () => {
  it("handles missing optional safetyDeposit on src (null)", () => {
    const wire = makeWireOrder(`wf_${HASHLOCK_A}`, HASHLOCK_A);
    // Remove safetyDeposit to simulate a missing optional field
    delete (wire.src as Record<string, unknown>)["safetyDeposit"];
    const rec = toHistoryRecord(wire);
    expect(rec.src.safetyDeposit).toBeNull();
  });

  it("sets resolver to null when absent", () => {
    const wire = makeWireOrder(`wf_${HASHLOCK_A}`, HASHLOCK_A);
    const rec = toHistoryRecord(wire);
    expect(rec.resolver).toBeNull();
  });

  it("preserves non-null resolver", () => {
    const resolver = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const wire = makeWireOrder(`wf_${HASHLOCK_A}`, HASHLOCK_A, { resolver });
    const rec = toHistoryRecord(wire);
    expect(rec.resolver).toBe(resolver);
  });
});
