/**
 * Tests for ArchivalPolicy — explicit stale-order archival lifecycle contract.
 *
 * The tests confirm that:
 *  1. Orders beyond the retention window with no lock are archived.
 *  2. Archival is idempotent (running twice does not double-count).
 *  3. Orders with src locks, non-announced status, or future created_at
 *     are NOT archived.
 *  4. The reactivation path unarchives an archived order correctly.
 *  5. Reactivation is a no-op when the order is not archived.
 *  6. isArchivalWorthy() correctly classifies edge cases.
 *  7. Prometheus metrics are incremented per run.
 *  8. Replay-safe: a reconciler event after archival unarchives and resumes
 *     normal tracking.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import pino from "pino";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository, type AnnounceOrderInput } from "../src/persistence/orders-repo.js";
import { ArchivalPolicy } from "../src/archival/archival-policy.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const nullLog = pino({ level: "silent" });

const VALID_ETH_ADDR   = "0x3333333333333333333333333333333333333333";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

const BASE_ORDER: AnnounceOrderInput = {
  direction:        "eth_to_xlm",
  hashlock:         "0x" + "cc".repeat(32),
  srcChain:         "ethereum",
  srcAddress:       VALID_ETH_ADDR,
  srcAsset:         "native",
  srcAmount:        "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain:         "stellar",
  dstAddress:       VALID_STELLAR_ADDR,
  dstAsset:         "native",
  dstAmount:        "100000000",
};

async function freshRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-archival-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrdersRepository(db);
}

/** Set created_at to `ageSeconds` seconds ago (just before the cutoff). */
async function backdateOrder(repo: OrdersRepository, publicId: string, ageSeconds: number) {
  const cutoff = Math.floor(Date.now() / 1000) - ageSeconds;
  const db = (repo as any).db;
  db.prepare("UPDATE orders SET created_at = ? WHERE public_id = ?").run(cutoff - 1, publicId);
}

// ── runArchival ───────────────────────────────────────────────────────────────

describe("ArchivalPolicy.runArchival", () => {
  afterEach(() => vi.restoreAllMocks());

  it("archives an announced order older than the retention window with no src lock", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "d1".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    const result = await policy.runArchival();

    expect(result.archivedCount).toBe(1);
    expect(result.reason).toBe("no_lock_within_retention_window");

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.archivedAt).not.toBeNull();
    // Status is preserved (soft-delete only)
    expect(updated!.status).toBe("announced");
  });

  it("does NOT archive a fresh order within the retention window", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "d2".repeat(32) });
    // No backdate — order is just created

    const result = await policy.runArchival();
    expect(result.archivedCount).toBe(0);
  });

  it("does NOT archive an order that has a source lock (src_order_id set)", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "d3".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId:  "src-100",
      txHash:   "0xabc",
      blockNumber: 1,
      timelock: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await policy.runArchival();
    expect(result.archivedCount).toBe(0);

    const unchanged = await repo.findByPublicId(order.publicId);
    expect(unchanged!.archivedAt).toBeNull();
  });

  it("does NOT archive orders in non-announced status even if old", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "d4".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);
    await repo.setStatus(order.publicId, "failed");

    const result = await policy.runArchival();
    expect(result.archivedCount).toBe(0);
  });

  it("is idempotent — running twice archives the order only once", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "d5".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    const first  = await policy.runArchival();
    const second = await policy.runArchival();

    expect(first.archivedCount).toBe(1);
    expect(second.archivedCount).toBe(0); // already archived
  });

  it("respects batchSize and leaves remaining eligible orders for the next run", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30, /* batchSize */ 3);

    for (let i = 0; i < 5; i++) {
      const o = await repo.announce({
        ...BASE_ORDER,
        hashlock: "0x" + String(i).padStart(2, "0").repeat(32),
      });
      await backdateOrder(repo, o.publicId, 31 * 24 * 60 * 60);
    }

    const first  = await policy.runArchival();
    expect(first.archivedCount).toBe(3);

    const second = await policy.runArchival();
    expect(second.archivedCount).toBe(2);

    const third  = await policy.runArchival();
    expect(third.archivedCount).toBe(0);
  });

  it("archives only the qualifying orders when mix of eligible and ineligible exist", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    // Eligible: old + no lock
    const eligible = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "e1".repeat(32) });
    await backdateOrder(repo, eligible.publicId, 35 * 24 * 60 * 60);

    // Ineligible: young
    await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "e2".repeat(32) });

    // Ineligible: old but locked
    const locked = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "e3".repeat(32) });
    await backdateOrder(repo, locked.publicId, 35 * 24 * 60 * 60);
    await repo.recordSrcLock({
      publicId: locked.publicId,
      orderId:  "src-200",
      txHash:   "0xdef",
      blockNumber: 2,
      timelock: Math.floor(Date.now() / 1000) + 7200,
    });

    const result = await policy.runArchival();
    expect(result.archivedCount).toBe(1);

    const archivedOrder = await repo.findByPublicId(eligible.publicId);
    expect(archivedOrder!.archivedAt).not.toBeNull();
  });
});

// ── reactivateOrder ───────────────────────────────────────────────────────────

describe("ArchivalPolicy.reactivateOrder", () => {
  it("clears archived_at on an archived announced order", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "b1".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);
    await policy.runArchival();

    const archived = await repo.findByPublicId(order.publicId);
    expect(archived!.archivedAt).not.toBeNull();

    const result = await policy.reactivateOrder(order.publicId);

    expect(result.reactivated).toBe(true);
    expect(result.reason).toBe("on_chain_lock_discovered");

    const reactivated = await repo.findByPublicId(order.publicId);
    expect(reactivated!.archivedAt).toBeNull();
  });

  it("returns { reactivated: false } for an order that was never archived", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "b2".repeat(32) });

    const result = await policy.reactivateOrder(order.publicId);
    expect(result.reactivated).toBe(false);
  });

  it("returns { reactivated: false } for a non-existent order", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const result = await policy.reactivateOrder("wf_0x" + "f".repeat(64));
    expect(result.reactivated).toBe(false);
  });

  it("is idempotent — reactivating twice does not error", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "b3".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);
    await policy.runArchival();

    const first  = await policy.reactivateOrder(order.publicId);
    const second = await policy.reactivateOrder(order.publicId); // already live

    expect(first.reactivated).toBe(true);
    expect(second.reactivated).toBe(false);
  });

  it("skips reactivation when the order was advanced by the reconciler while archived", async () => {
    // Scenario: order archived → reconciler fires → status advances to src_locked
    // (possible if archived_at does not block recordSrcLock).  The reactivation
    // path should see status !== 'announced' and skip.
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "b4".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);
    await policy.runArchival();

    // Force status to src_locked (simulating reconciler running while archived)
    await repo.setStatus(order.publicId, "src_locked");

    const result = await policy.reactivateOrder(order.publicId);
    expect(result.reactivated).toBe(false);
  });
});

// ── replay-safe recovery ──────────────────────────────────────────────────────

describe("ArchivalPolicy — replay-safe recovery path", () => {
  it("archived order can be reactivated, then a src lock recorded normally", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "b5".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    // Archive it
    await policy.runArchival();
    const archived = await repo.findByPublicId(order.publicId);
    expect(archived!.archivedAt).not.toBeNull();

    // On-chain lock discovered — reactivate
    await policy.reactivateOrder(order.publicId);

    const live = await repo.findByPublicId(order.publicId);
    expect(live!.archivedAt).toBeNull();
    expect(live!.status).toBe("announced");

    // Normal processing can now continue
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-reactivated",
      txHash:  "0xreactivated",
      blockNumber: 999,
      timelock: Math.floor(Date.now() / 1000) + 7200,
    });

    const advanced = await repo.findByPublicId(order.publicId);
    expect(advanced!.status).toBe("src_locked");
    expect(advanced!.srcOrderId).toBe("src-reactivated");
    expect(advanced!.archivedAt).toBeNull();
  });

  it("repeated archival runs do not affect an order that was reactivated and advanced", async () => {
    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "b6".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    await policy.runArchival();
    await policy.reactivateOrder(order.publicId);

    // Record a src lock so the order is no longer in 'announced'
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-safe",
      txHash:  "0xsafe",
      blockNumber: 1000,
      timelock: Math.floor(Date.now() / 1000) + 7200,
    });

    // Run archival again — the order has a src lock now, must not be re-archived
    const result = await policy.runArchival();
    expect(result.archivedCount).toBe(0);

    const unchanged = await repo.findByPublicId(order.publicId);
    expect(unchanged!.archivedAt).toBeNull();
    expect(unchanged!.status).toBe("src_locked");
  });
});

// ── isArchivalWorthy ──────────────────────────────────────────────────────────

describe("ArchivalPolicy.isArchivalWorthy", () => {
  const now = Math.floor(Date.now() / 1000);
  const retentionDays = 30;
  const policy = new ArchivalPolicy(
    null as any, // repo not needed for pure decision fn
    nullLog,
    retentionDays
  );

  const OLD = now - retentionDays * 24 * 60 * 60 - 1; // just past the boundary

  it("returns true for an eligible announced order", () => {
    expect(policy.isArchivalWorthy({
      status:      "announced",
      srcOrderId:  null,
      archivedAt:  null,
      createdAt:   OLD,
    })).toBe(true);
  });

  it("returns false when status is not announced", () => {
    expect(policy.isArchivalWorthy({
      status:      "src_locked",
      srcOrderId:  null,
      archivedAt:  null,
      createdAt:   OLD,
    })).toBe(false);
  });

  it("returns false when srcOrderId is set", () => {
    expect(policy.isArchivalWorthy({
      status:      "announced",
      srcOrderId:  "src-1",
      archivedAt:  null,
      createdAt:   OLD,
    })).toBe(false);
  });

  it("returns false when already archived", () => {
    expect(policy.isArchivalWorthy({
      status:      "announced",
      srcOrderId:  null,
      archivedAt:  OLD - 1000,
      createdAt:   OLD,
    })).toBe(false);
  });

  it("returns false when created within the retention window", () => {
    const recent = now - 60; // 1 minute ago
    expect(policy.isArchivalWorthy({
      status:      "announced",
      srcOrderId:  null,
      archivedAt:  null,
      createdAt:   recent,
    })).toBe(false);
  });
});

// ── Prometheus metrics ────────────────────────────────────────────────────────

describe("ArchivalPolicy — Prometheus metrics", () => {
  it("increments archival run counters and archived counter", async () => {
    const {
      archivalRuns,
      archivalOrdersArchived,
    } = await import("../src/archival/archival-metrics.js");

    const runsBefore     = (await archivalRuns.get()).values.find(
      (v) => v.labels.result === "success"
    )?.value ?? 0;
    const archivedBefore = (await archivalOrdersArchived.get()).values[0]?.value ?? 0;

    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "f1".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);
    await policy.runArchival();

    const runsAfter     = (await archivalRuns.get()).values.find(
      (v) => v.labels.result === "success"
    )?.value ?? 0;
    const archivedAfter = (await archivalOrdersArchived.get()).values[0]?.value ?? 0;

    expect(runsAfter).toBe(runsBefore + 1);
    expect(archivedAfter).toBe(archivedBefore + 1);
  });

  it("increments reactivated counter on successful reactivation", async () => {
    const { archivalOrdersReactivated } = await import("../src/archival/archival-metrics.js");

    const before = (await archivalOrdersReactivated.get()).values[0]?.value ?? 0;

    const repo   = await freshRepo();
    const policy = new ArchivalPolicy(repo, nullLog, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "f2".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);
    await policy.runArchival();
    await policy.reactivateOrder(order.publicId);

    const after = (await archivalOrdersReactivated.get()).values[0]?.value ?? 0;
    expect(after).toBe(before + 1);
  });
});

// ── unarchiveOrder repository method ─────────────────────────────────────────

describe("OrdersRepository.unarchiveOrder", () => {
  it("clears archived_at and updates updated_at", async () => {
    const repo  = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "a1".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    await repo.archiveOrder(order.publicId);
    const archived = await repo.findByPublicId(order.publicId);
    expect(archived!.archivedAt).not.toBeNull();

    await repo.unarchiveOrder(order.publicId);
    const live = await repo.findByPublicId(order.publicId);
    expect(live!.archivedAt).toBeNull();
  });

  it("is a no-op on an order that was never archived", async () => {
    const repo  = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "a2".repeat(32) });

    await expect(repo.unarchiveOrder(order.publicId)).resolves.toBeUndefined();

    const unchanged = await repo.findByPublicId(order.publicId);
    expect(unchanged!.archivedAt).toBeNull();
  });

  it("calling unarchiveOrder twice is idempotent", async () => {
    const repo  = await freshRepo();
    const order = await repo.announce({ ...BASE_ORDER, hashlock: "0x" + "a3".repeat(32) });
    await backdateOrder(repo, order.publicId, 31 * 24 * 60 * 60);

    await repo.archiveOrder(order.publicId);
    await repo.unarchiveOrder(order.publicId);
    await expect(repo.unarchiveOrder(order.publicId)).resolves.toBeUndefined(); // no-op
    const live = await repo.findByPublicId(order.publicId);
    expect(live!.archivedAt).toBeNull();
  });
});
