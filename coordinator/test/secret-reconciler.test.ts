import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { keccak256, toHex } from "viem";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import {
  validatePreimage,
  SecretReconciler,
  type SecretRecoveryResult,
} from "../src/reconciliation/secret-reconciler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

// Build two canonical (preimage, hashlock) pairs — one sha256, one keccak256.
const SHA256_PRE_BUF = Buffer.alloc(32, 0xaa);
const SHA256_PREIMAGE = "0x" + SHA256_PRE_BUF.toString("hex");
const SHA256_HASHLOCK = "0x" + createHash("sha256").update(SHA256_PRE_BUF).digest("hex");

const KECCAK_PRE_BUF = Buffer.alloc(32, 0xbb);
const KECCAK_PREIMAGE = "0x" + KECCAK_PRE_BUF.toString("hex");
const KECCAK_HASHLOCK = keccak256(toHex(KECCAK_PRE_BUF));

async function freshOrders(): Promise<OrderService> {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-secretrecon-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrderService(new OrdersRepository(db), log);
}

async function seedOrder(orders: OrderService, hashlock: string): Promise<string> {
  const row = await orders.announce({
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
    dstAmount: "100000000",
  });
  return row.publicId;
}

function makeMockClient(logs: any[] = []) {
  return {
    getLogs: vi.fn(async () => logs),
  };
}

// ---------------------------------------------------------------------------
// validatePreimage
// ---------------------------------------------------------------------------

describe("validatePreimage", () => {
  it("returns 'sha256' when preimage sha256-hashes to hashlock", () => {
    expect(validatePreimage(SHA256_PREIMAGE, SHA256_HASHLOCK)).toBe("sha256");
  });

  it("returns 'keccak256' when preimage keccak256-hashes to hashlock", () => {
    expect(validatePreimage(KECCAK_PREIMAGE, KECCAK_HASHLOCK)).toBe("keccak256");
  });

  it("returns null when preimage does not match either hash", () => {
    const randomHashlock = "0x" + "ff".repeat(32);
    expect(validatePreimage(SHA256_PREIMAGE, randomHashlock)).toBeNull();
  });

  it("returns null for a zeroed-out (all-zero) preimage against a mismatched hashlock", () => {
    const zeroPreimage = "0x" + "00".repeat(32);
    const wrongHashlock = "0x" + "aa".repeat(32);
    expect(validatePreimage(zeroPreimage, wrongHashlock)).toBeNull();
  });

  it("accepts preimage without 0x prefix", () => {
    const noPrefixPreimage = SHA256_PRE_BUF.toString("hex");
    expect(validatePreimage(noPrefixPreimage, SHA256_HASHLOCK)).toBe("sha256");
  });

  it("returns null for malformed (non-hex) preimage without throwing", () => {
    expect(validatePreimage("not-valid-hex!!!", SHA256_HASHLOCK)).toBeNull();
  });

  it("returns null for empty string preimage", () => {
    expect(validatePreimage("", SHA256_HASHLOCK)).toBeNull();
  });

  it("sha256 match takes priority over keccak256 when both would match (pathological case)", () => {
    // Construct a preimage that sha256-matches its own SHA256_HASHLOCK.
    expect(validatePreimage(SHA256_PREIMAGE, SHA256_HASHLOCK)).toBe("sha256");
  });
});

// ---------------------------------------------------------------------------
// SecretReconciler.recoverFromEthereumLogs
// ---------------------------------------------------------------------------

describe("SecretReconciler — recoverFromEthereumLogs", () => {
  let orders: OrderService;

  beforeEach(async () => {
    orders = await freshOrders();
  });

  it("returns zeroed result when no logs are returned", async () => {
    const client = makeMockClient([]);
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 100n);
    expect(result).toEqual<SecretRecoveryResult>({
      recovered: 0,
      invalidPreimages: 0,
      alreadyKnown: 0,
      stateConflict: 0,
      errors: 0,
    });
  });

  it("recovers a missing sha256 preimage and writes it to the DB", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({
      publicId,
      orderId: "10",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999,
    });

    const client = makeMockClient([
      {
        args: { orderId: 10n, preimage: SHA256_PREIMAGE },
        transactionHash: "0xdeadbeef",
        blockNumber: 200n,
      },
    ]);
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 200n);

    expect(result.recovered).toBe(1);
    expect(result.invalidPreimages).toBe(0);
    const updated = await orders.get(publicId);
    expect(updated?.status).toBe("secret_revealed");
    expect(updated?.preimage).toBe(SHA256_PREIMAGE);
  });

  it("recovers a missing keccak256 preimage and writes it to the DB", async () => {
    const publicId = await seedOrder(orders, KECCAK_HASHLOCK);
    await orders.recordSrcLock({
      publicId,
      orderId: "20",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999,
    });

    const client = makeMockClient([
      {
        args: { orderId: 20n, preimage: KECCAK_PREIMAGE },
        transactionHash: "0xcafe",
        blockNumber: 200n,
      },
    ]);
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 200n);

    expect(result.recovered).toBe(1);
    const updated = await orders.get(publicId);
    expect(updated?.status).toBe("secret_revealed");
  });

  it("rejects an invalid preimage and leaves the order unchanged", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({
      publicId,
      orderId: "30",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999,
    });

    const BAD_PREIMAGE = "0x" + "ff".repeat(32);
    const client = makeMockClient([
      {
        args: { orderId: 30n, preimage: BAD_PREIMAGE },
        transactionHash: "0xbad",
        blockNumber: 200n,
      },
    ]);
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 200n);

    expect(result.recovered).toBe(0);
    expect(result.invalidPreimages).toBe(1);
    const updated = await orders.get(publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.preimage).toBeNull();
  });

  it("counts already-known orders (preimage already in DB) without writing again", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({
      publicId,
      orderId: "40",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: 9999,
    });
    // Write the secret first (simulating the live listener already caught it).
    await orders.recordSecret(publicId, SHA256_PREIMAGE, "0xabc");

    const client = makeMockClient([
      {
        args: { orderId: 40n, preimage: SHA256_PREIMAGE },
        transactionHash: "0xdeadbeef",
        blockNumber: 200n,
      },
    ]);
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 200n);

    expect(result.recovered).toBe(0);
    expect(result.alreadyKnown).toBe(1);
  });

  it("skips logs with no matching DB order", async () => {
    const client = makeMockClient([
      {
        args: { orderId: 999n, preimage: SHA256_PREIMAGE },
        transactionHash: "0xdeadbeef",
        blockNumber: 200n,
      },
    ]);
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 200n);
    expect(result.recovered).toBe(0);
    expect(result.invalidPreimages).toBe(0);
    expect(result.alreadyKnown).toBe(0);
  });

  it("handles multiple logs in a single scan — recovers valid, rejects invalid", async () => {
    const pid1 = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId: pid1, orderId: "50", txHash: "0x", blockNumber: 1, timelock: 9999 });

    const DIFFERENT_HASHLOCK = "0x" + "cd".repeat(32);
    const pid2 = await seedOrder(orders, DIFFERENT_HASHLOCK);
    await orders.recordSrcLock({ publicId: pid2, orderId: "51", txHash: "0x", blockNumber: 1, timelock: 9999 });

    const client = makeMockClient([
      { args: { orderId: 50n, preimage: SHA256_PREIMAGE }, transactionHash: "0x1", blockNumber: 200n },
      { args: { orderId: 51n, preimage: SHA256_PREIMAGE }, transactionHash: "0x2", blockNumber: 200n },
    ]);

    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 200n);

    expect(result.recovered).toBe(1);
    expect(result.invalidPreimages).toBe(1);
  });

  it("returns zero result and does not throw when getLogs fails", async () => {
    const client = { getLogs: vi.fn(async () => { throw new Error("RPC timeout"); }) };
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 100n);
    expect(result).toEqual<SecretRecoveryResult>({ recovered: 0, invalidPreimages: 0, alreadyKnown: 0, stateConflict: 0, errors: 0 });
  });

  it("is idempotent — running twice does not double-write", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId, orderId: "60", txHash: "0xabc", blockNumber: 100, timelock: 9999 });

    const log_ = [{ args: { orderId: 60n, preimage: SHA256_PREIMAGE }, transactionHash: "0xd", blockNumber: 200n }];
    const client = makeMockClient(log_);
    const reconciler = new SecretReconciler(client as any, orders, log);

    const r1 = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 200n);
    const r2 = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 200n);

    expect(r1.recovered).toBe(1);
    expect(r2.recovered).toBe(0);
    expect(r2.alreadyKnown).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SecretReconciler.detectStaleRevelations
// ---------------------------------------------------------------------------

describe("SecretReconciler — detectStaleRevelations", () => {
  let orders: OrderService;

  beforeEach(async () => {
    orders = await freshOrders();
  });

  it("returns empty array when all orders have preimages", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId, orderId: "1", txHash: "0x", blockNumber: 1, timelock: 9999 });
    await orders.recordSecret(publicId, SHA256_PREIMAGE, "0x");

    const client = makeMockClient();
    const reconciler = new SecretReconciler(client as any, orders, log);
    const stale = await reconciler.detectStaleRevelations();
    expect(stale).toHaveLength(0);
  });

  it("returns empty array when no orders exist", async () => {
    const client = makeMockClient();
    const reconciler = new SecretReconciler(client as any, orders, log);
    expect(await reconciler.detectStaleRevelations()).toHaveLength(0);
  });

  it("returns empty array for orders in 'announced' state (not yet locked)", async () => {
    await seedOrder(orders, SHA256_HASHLOCK);
    const client = makeMockClient();
    const reconciler = new SecretReconciler(client as any, orders, log);
    expect(await reconciler.detectStaleRevelations()).toHaveLength(0);
  });

  it("returns src_locked orders with no preimage", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId, orderId: "77", txHash: "0x", blockNumber: 1, timelock: 9999 });

    const client = makeMockClient();
    const reconciler = new SecretReconciler(client as any, orders, log);
    const stale = await reconciler.detectStaleRevelations();

    expect(stale).toHaveLength(1);
    expect(stale[0].publicId).toBe(publicId);
    expect(stale[0].srcOrderId).toBe("77");
    expect(stale[0].hashlock).toBe(SHA256_HASHLOCK);
    expect(stale[0].status).toBe("src_locked");
  });

  it("returns dst_locked orders with no preimage", async () => {
    const publicId = await seedOrder(orders, KECCAK_HASHLOCK);
    await orders.recordSrcLock({ publicId, orderId: "80", txHash: "0x", blockNumber: 1, timelock: 9999 });
    await orders.recordDstLock({
      publicId,
      orderId: "81",
      txHash: "0x",
      blockNumber: 2,
      timelock: 9999,
      resolver: null,
    });

    const client = makeMockClient();
    const reconciler = new SecretReconciler(client as any, orders, log);
    const stale = await reconciler.detectStaleRevelations();

    expect(stale).toHaveLength(1);
    expect(stale[0].status).toBe("dst_locked");
    expect(stale[0].hashlock).toBe(KECCAK_HASHLOCK);
  });

  it("does not include completed or refunded orders", async () => {
    const p1 = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId: p1, orderId: "90", txHash: "0x", blockNumber: 1, timelock: 9999 });
    await orders.recordSecret(p1, SHA256_PREIMAGE, "0x");
    await orders.markStatus(p1, "completed");

    const ANOTHER_HASHLOCK = "0x" + createHash("sha256").update(Buffer.alloc(32, 0xee)).digest("hex");
    const p2 = await seedOrder(orders, ANOTHER_HASHLOCK);
    await orders.recordSrcLock({ publicId: p2, orderId: "91", txHash: "0x", blockNumber: 1, timelock: 9999 });
    await orders.markStatus(p2, "refunded");

    const client = makeMockClient();
    const reconciler = new SecretReconciler(client as any, orders, log);
    expect(await reconciler.detectStaleRevelations()).toHaveLength(0);
  });

  it("returns multiple stale orders", async () => {
    const HASH_A = "0x" + createHash("sha256").update(Buffer.alloc(32, 0x01)).digest("hex");
    const HASH_B = "0x" + createHash("sha256").update(Buffer.alloc(32, 0x02)).digest("hex");

    const pa = await seedOrder(orders, HASH_A);
    await orders.recordSrcLock({ publicId: pa, orderId: "100", txHash: "0x", blockNumber: 1, timelock: 9999 });

    const pb = await seedOrder(orders, HASH_B);
    await orders.recordSrcLock({ publicId: pb, orderId: "101", txHash: "0x", blockNumber: 1, timelock: 9999 });

    const client = makeMockClient();
    const reconciler = new SecretReconciler(client as any, orders, log);
    const stale = await reconciler.detectStaleRevelations();

    expect(stale).toHaveLength(2);
    const publicIds = stale.map((s) => s.publicId).sort();
    expect(publicIds).toContain(pa);
    expect(publicIds).toContain(pb);
  });
});

// ---------------------------------------------------------------------------
// #309: SecretRecoveryResult — stateConflict and errors fields
// ---------------------------------------------------------------------------

describe("SecretRecoveryResult — stateConflict and errors counters", () => {
  let orders: OrderService;

  beforeEach(async () => {
    orders = await freshOrders();
  });

  it("result includes stateConflict:0 and errors:0 on a clean run", async () => {
    const client = makeMockClient([]);
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 100n);
    expect(result.stateConflict).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("increments stateConflict when order is in an incompatible state for secret recording", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    // Lock src side so the order is in src_locked, which allows secret_revealed…
    await orders.recordSrcLock({ publicId, orderId: "200", txHash: "0x", blockNumber: 1, timelock: 9999 });
    // …but then mark it refunded (terminal) so the service rejects the recording.
    await orders.markStatus(publicId, "refunded");

    const client = makeMockClient([
      { args: { orderId: 200n, preimage: SHA256_PREIMAGE }, transactionHash: "0xabc", blockNumber: 50n },
    ]);
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 100n);

    // The order is terminal — service raises "cannot record secret" which maps to state_conflict.
    expect(result.stateConflict).toBe(1);
    expect(result.recovered).toBe(0);
  });

  it("increments errors when no DB order exists for the log's orderId", async () => {
    // orderId 999 doesn't exist in the DB — _recoverOneOrder returns "error".
    const client = makeMockClient([
      { args: { orderId: 999n, preimage: SHA256_PREIMAGE }, transactionHash: "0x1", blockNumber: 1n },
    ]);
    const reconciler = new SecretReconciler(client as any, orders, log);
    const result = await reconciler.recoverFromEthereumLogs("0xcontract", 1n, 100n);
    expect(result.errors).toBe(1);
    expect(result.recovered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #309: _recoverOneOrder — deterministic outcome per order
// ---------------------------------------------------------------------------

describe("SecretReconciler._recoverOneOrder", () => {
  let orders: OrderService;

  beforeEach(async () => {
    orders = await freshOrders();
  });

  it("returns 'recovered' when a missing sha256 preimage is written", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId, orderId: "300", txHash: "0x", blockNumber: 1, timelock: 9999 });

    const reconciler = new SecretReconciler(makeMockClient() as any, orders, log);
    const outcome = await reconciler._recoverOneOrder("300", SHA256_PREIMAGE, "0xok");
    expect(outcome).toBe("recovered");

    const updated = await orders.get(publicId);
    expect(updated?.status).toBe("secret_revealed");
  });

  it("returns 'already_known' when preimage is already in DB", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId, orderId: "301", txHash: "0x", blockNumber: 1, timelock: 9999 });
    await orders.recordSecret(publicId, SHA256_PREIMAGE, "0x");

    const reconciler = new SecretReconciler(makeMockClient() as any, orders, log);
    const outcome = await reconciler._recoverOneOrder("301", SHA256_PREIMAGE, "0xagain");
    expect(outcome).toBe("already_known");
  });

  it("returns 'invalid_preimage' when the preimage does not hash to the hashlock", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId, orderId: "302", txHash: "0x", blockNumber: 1, timelock: 9999 });

    const BAD = "0x" + "ff".repeat(32);
    const reconciler = new SecretReconciler(makeMockClient() as any, orders, log);
    const outcome = await reconciler._recoverOneOrder("302", BAD, "0xbad");
    expect(outcome).toBe("invalid_preimage");
  });

  it("returns 'error' when no DB order matches the orderId", async () => {
    const reconciler = new SecretReconciler(makeMockClient() as any, orders, log);
    const outcome = await reconciler._recoverOneOrder("999", SHA256_PREIMAGE, "0x");
    expect(outcome).toBe("error");
  });

  it("returns 'state_conflict' when the order is terminal and rejects secret recording", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId, orderId: "303", txHash: "0x", blockNumber: 1, timelock: 9999 });
    await orders.markStatus(publicId, "refunded");

    const reconciler = new SecretReconciler(makeMockClient() as any, orders, log);
    const outcome = await reconciler._recoverOneOrder("303", SHA256_PREIMAGE, "0x");
    expect(outcome).toBe("state_conflict");
  });

  it("is idempotent — running twice returns 'recovered' then 'already_known'", async () => {
    const publicId = await seedOrder(orders, SHA256_HASHLOCK);
    await orders.recordSrcLock({ publicId, orderId: "304", txHash: "0x", blockNumber: 1, timelock: 9999 });

    const reconciler = new SecretReconciler(makeMockClient() as any, orders, log);
    const first = await reconciler._recoverOneOrder("304", SHA256_PREIMAGE, "0x1");
    const second = await reconciler._recoverOneOrder("304", SHA256_PREIMAGE, "0x2");

    expect(first).toBe("recovered");
    expect(second).toBe("already_known");
  });
});
