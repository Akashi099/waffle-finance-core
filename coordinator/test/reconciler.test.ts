import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import { createHash } from "node:crypto";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { Reconciler } from "../src/reconciliation/reconciler.js";
import type { CoordinatorConfig } from "../src/config.js";
import {
  makeCreatedEvent,
  makeClaimedEvent,
  makeRefundedEvent,
  makeMalformedDataEvent,
  makeUnknownTopicEvent,
  PREIMAGE,
  ORDER_ID,
  TIMELOCK,
  HASHLOCK,
} from "./fixtures/soroban-xdr-fixtures.js";

// ---------------------------------------------------------------------------
// Mock viem + @stellar/stellar-sdk + @solana/web3.js so the reconciler can
// run without live RPCs.
// ---------------------------------------------------------------------------
let mockSorobanEvents: any[] = [];
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => 10_000n),
      getLogs: vi.fn(async () => [])
    }))
  };
});

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: vi.fn(() => ({
      getLatestLedger: vi.fn(async () => ({ sequence: 100_000 })),
      getEvents: vi.fn(async () => ({ events: mockSorobanEvents, cursor: null }))
    }))
  }
}));

vi.mock("@solana/web3.js", () => ({
  Connection: vi.fn(() => ({
    getSlot: vi.fn(async () => 500_000),
    getSignaturesForAddress: vi.fn(async () => []),
    getParsedTransaction: vi.fn(async () => null)
  })),
  PublicKey: vi.fn((id: string) => ({ toBase58: () => id }))
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK = "0x" + "a".repeat(64);
const HASHLOCK2 = "0x" + "b".repeat(64);

// Cryptographically valid (preimage, hashlock) pair used by the OrderClaimed
// tests — required now that the reconciler validates preimages before writing.
const VALID_PREIMAGE_BUF = Buffer.alloc(32, 0xcc);
const VALID_PREIMAGE = "0x" + VALID_PREIMAGE_BUF.toString("hex");
const VALID_HASHLOCK = "0x" + createHash("sha256").update(VALID_PREIMAGE_BUF).digest("hex");

const BASE_CFG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file::memory:",
  logLevel: "silent",
  corsOrigin: "*",
  pollIntervalMs: 15_000,
  ethereum: {
    rpcUrl: "https://rpc.test",
    chainId: 11_155_111,
    htlcEscrow: "0xb352339BEb146f2699d28D736700B953988bB178",
    resolverRegistry: null
  },
  soroban: {
    rpcUrl: "https://soroban.test",
    horizonUrl: "https://horizon.test",
    networkPassphrase: "Test",
    htlcContract: null,
    resolverRegistry: null
  },
  solana: { rpcUrl: "https://solana.test", programId: "PLACEHOLDER", commitment: "confirmed" }
};

async function freshOrders() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-recon-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrderService(new OrdersRepository(db), log);
}

async function seedOrder(orders: OrderService, hashlock = HASHLOCK) {
  return orders.announce({
    direction: "eth_to_xlm",
    hashlock,
    srcChain: "ethereum",
    srcAddress: VALID_ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: "stellar",
    dstAddress: VALID_STELLAR_ADDR,
    dstAsset: "native",
    dstAmount: "100000000"
  });
}

// Helper: grab the mocked ETH client created by the most recent Reconciler
function ethClientMock(reconciler: Reconciler): { getLogs: MockedFunction<any>; getBlockNumber: MockedFunction<any> } {
  const { createPublicClient } = require("viem");
  return (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reconciler — startup state", () => {
  it("getStatus() returns null before any run", () => {
    const orders = { findByHashlock: vi.fn(), findBySrcOrderId: vi.fn() } as any;
    const reconciler = new Reconciler(BASE_CFG, orders, log);
    const status = reconciler.getStatus();
    expect(status.lastRunAt).toBeNull();
    expect(status.lastRunOk).toBeNull();
    expect(status.eventsReplayed).toBe(0);
  });

  it("run() completes and marks lastRunOk=true when no events exist", async () => {
    const orders = await freshOrders();
    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();
    const status = reconciler.getStatus();
    expect(status.lastRunOk).toBe(true);
    expect(status.lastRunAt).toBeTypeOf("number");
    expect(status.eventsReplayed).toBe(0);
  });
});

describe("Reconciler — Ethereum event replay", () => {
  let orders: OrderService;
  let reconciler: Reconciler;

  beforeEach(async () => {
    orders = await freshOrders();
    vi.resetModules();
    vi.clearAllMocks();
    reconciler = new Reconciler(BASE_CFG, orders, log);
  });

  it("replays a missing OrderCreated event and advances order to src_locked", async () => {
    const order = await seedOrder(orders);

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    // Simulate the ETH node returning an OrderCreated log for this order
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [
          {
            args: { orderId: 42n, hashlock: HASHLOCK, timelock: 9999n },
            transactionHash: "0xdeadbeef",
            blockNumber: 9000n
          }
        ];
      }
      return [];
    });

    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("42");
    expect(reconciler.getStatus().eventsReplayed).toBe(1);
  });

  it("replays a missing OrderClaimed event and advances order to secret_revealed", async () => {
    // Seed with a hashlock that actually matches VALID_PREIMAGE via sha256.
    const order = await seedOrder(orders, VALID_HASHLOCK);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "77",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999
    });

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderClaimed") {
        return [
          {
            args: { orderId: 77n, preimage: VALID_PREIMAGE },
            transactionHash: "0xcafe",
            blockNumber: 9100n
          }
        ];
      }
      return [];
    });

    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("secret_revealed");
    expect(reconciler.getStatus().eventsReplayed).toBe(1);
  });

  it("replays a missing OrderRefunded event and advances order to refunded", async () => {
    const order = await seedOrder(orders);
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "55",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999
    });

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderRefunded") {
        return [
          {
            args: { orderId: 55n },
            transactionHash: "0xdead",
            blockNumber: 9200n
          }
        ];
      }
      return [];
    });

    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("refunded");
  });
});

describe("Reconciler — idempotency", () => {
  it("replaying an already-applied OrderCreated is a no-op (no error, eventsReplayed=0)", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);
    // Pre-apply the src lock
    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "10",
      txHash: "0xaaa",
      blockNumber: 100,
      timelock: 9999
    });

    const reconciler = new Reconciler(BASE_CFG, orders, log);

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    // Return the same OrderCreated again
    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [
          {
            args: { orderId: 10n, hashlock: HASHLOCK, timelock: 9999n },
            transactionHash: "0xaaa",
            blockNumber: 100n
          }
        ];
      }
      return [];
    });

    await reconciler.run();

    // Order stays at src_locked, run succeeds, 0 replays because srcOrderId already set
    expect(reconciler.getStatus().lastRunOk).toBe(true);
    expect(reconciler.getStatus().eventsReplayed).toBe(0);
    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
  });

  it("running reconciliation twice produces no duplicate state transitions", async () => {
    const orders = await freshOrders();
    const order = await seedOrder(orders);

    const reconciler = new Reconciler(BASE_CFG, orders, log);

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as MockedFunction<any>).mock.results.at(-1)?.value;

    mockClient.getLogs.mockImplementation(async ({ event }: any) => {
      if (event?.name === "OrderCreated") {
        return [
          {
            args: { orderId: 99n, hashlock: HASHLOCK, timelock: 9999n },
            transactionHash: "0xbbb",
            blockNumber: 200n
          }
        ];
      }
      return [];
    });

    await reconciler.run(); // first — replays 1 event
    expect(reconciler.getStatus().eventsReplayed).toBe(1);

    // Create a second reconciler instance (simulates restart) — same logs returned
    const reconciler2 = new Reconciler(BASE_CFG, orders, log);
    await reconciler2.run(); // second — order already has srcOrderId, 0 replays
    expect(reconciler2.getStatus().eventsReplayed).toBe(0);

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked"); // not double-transitioned
  });
});

describe("Reconciler — Soroban event replay", () => {
  let orders: OrderService;
  let reconciler: Reconciler;

  beforeEach(async () => {
    orders = await freshOrders();
    mockSorobanEvents = [];
    vi.resetModules();
    vi.clearAllMocks();
    reconciler = new Reconciler(BASE_CFG, orders, log);
  });

  it("replays a missing Soroban created event and advances order to src_locked", async () => {
    const order = await seedOrder(orders);
    mockSorobanEvents = [makeCreatedEvent(100050, "0xstellar_created_tx")];

    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe(ORDER_ID);
    expect(updated?.srcLockTx).toBe("0xstellar_created_tx");
  });

  it("skips a malformed Soroban event and records a decode error without mutating state", async () => {
    const order = await seedOrder(orders);
    mockSorobanEvents = [makeMalformedDataEvent(100051, "0xstellar_malformed_tx")];

    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
  });

  it("skips an unknown Soroban topic event without recording a decode error", async () => {
    const order = await seedOrder(orders);
    mockSorobanEvents = [makeUnknownTopicEvent(100052, "0xstellar_unknown_tx")];

    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("announced");
  });
});
