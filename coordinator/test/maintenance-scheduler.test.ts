/**
 * Tests for MaintenanceScheduler.
 *
 * Covers:
 *  1. No-op: empty execute → result ok, archivedCount/expiredCount = 0.
 *  2. Partial: only some orders meet the retention threshold.
 *  3. Idempotent: running the same job twice leaves state consistent.
 *  4. Over-retention: orders beyond threshold are cleaned up; fresh ones are not.
 *  5. Skip-if-running: concurrent invocations are counted as skips, not double-runs.
 *  6. Failure handling: a throwing job produces ok=false, does not throw to caller.
 *  7. Lifecycle: start/stop, isRunning, getStatus.
 *  8. runAll: all registered jobs execute and results are returned in order.
 *  9. Metric assertions: maintenanceRunsTotal, maintenanceSkippedTotal,
 *     maintenanceLastRun all update correctly.
 * 10. Unknown job: runJob with unregistered name throws synchronously.
 * 11. Duplicate registration: registering same name twice throws.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import pino from "pino";
import { BacklogScheduler, Priority } from "../src/backlog/backlog-scheduler.js";
import { MaintenanceScheduler } from "../src/services/maintenance-scheduler.js";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository, type AnnounceOrderInput } from "../src/persistence/orders-repo.js";
import { StaleCleanupService } from "../src/services/stale-cleanup.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

function makeBacklog() {
  return new BacklogScheduler(log);
}

function makeScheduler(backlog = makeBacklog()) {
  // baseIntervalMs=1 so tests don't need real timers — cadence only matters
  // for setInterval tests which we keep synchronous via runJob/runAll.
  return new MaintenanceScheduler(backlog, log, 1);
}

const VALID_ETH = "0x1111111111111111111111111111111111111111";
const VALID_XLM = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

const BASE_ORDER: AnnounceOrderInput = {
  direction: "eth_to_xlm",
  hashlock: "0x" + "aa".repeat(32),
  srcChain: "ethereum",
  srcAddress: VALID_ETH,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar",
  dstAddress: VALID_XLM,
  dstAsset: "native",
  dstAmount: "100000000",
};

async function freshRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), "wf-maint-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrdersRepository(db);
}

function uniqueHashlock(seed: string) {
  return "0x" + seed.repeat(32).slice(0, 64);
}

/** Backdate a row so it appears `ageSeconds` old. */
async function backdate(repo: OrdersRepository, publicId: string, ageSeconds: number) {
  const cutoff = Math.floor(Date.now() / 1000) - ageSeconds;
  const db = (repo as any).db as import("better-sqlite3").Database;
  db.prepare("UPDATE orders SET created_at = ? WHERE public_id = ?").run(cutoff - 1, publicId);
}

// ── No-op ─────────────────────────────────────────────────────────────────────

describe("MaintenanceScheduler — no-op job", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs a job that does nothing and returns ok=true, skipped=false", async () => {
    const s = makeScheduler();
    s.register({
      name: "noop",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => ({ touched: 0 }),
    });

    const result = await s.runJob("noop");

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.jobName).toBe("noop");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.detail).toEqual({ touched: 0 });
  });

  it("reports archivedCount=0 when no stale orders exist", async () => {
    const repo = await freshRepo();
    const cleanup = new StaleCleanupService(repo, log, 30);

    const s = makeScheduler();
    s.register({
      name: "stale_cleanup",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {
        const r = await cleanup.run();
        return { archivedCount: r.archivedCount };
      },
    });

    const result = await s.runJob("stale_cleanup");
    expect(result.ok).toBe(true);
    expect(result.detail?.archivedCount).toBe(0);
  });
});

// ── Partial cleanup ───────────────────────────────────────────────────────────

describe("MaintenanceScheduler — partial cleanup", () => {
  it("archives only orders beyond the retention window", async () => {
    const repo = await freshRepo();
    const cleanup = new StaleCleanupService(repo, log, 30);

    // Order 1: 31 days old — should be archived.
    const old = await repo.announce({ ...BASE_ORDER, hashlock: uniqueHashlock("b1") });
    await backdate(repo, old.publicId, 31 * 24 * 3600);

    // Order 2: brand new — should NOT be archived.
    await repo.announce({ ...BASE_ORDER, hashlock: uniqueHashlock("b2") });

    const s = makeScheduler();
    s.register({
      name: "stale_cleanup",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {
        const r = await cleanup.run();
        return { archivedCount: r.archivedCount };
      },
    });

    const result = await s.runJob("stale_cleanup");
    expect(result.ok).toBe(true);
    expect(result.detail?.archivedCount).toBe(1);

    const archived = await repo.findByPublicId(old.publicId);
    expect(archived!.archivedAt).not.toBeNull();
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("MaintenanceScheduler — idempotent runs", () => {
  it("running the same job twice produces consistent state", async () => {
    const repo = await freshRepo();
    const cleanup = new StaleCleanupService(repo, log, 30);

    const order = await repo.announce({ ...BASE_ORDER, hashlock: uniqueHashlock("c1") });
    await backdate(repo, order.publicId, 31 * 24 * 3600);

    const s = makeScheduler();
    s.register({
      name: "stale_cleanup",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {
        const r = await cleanup.run();
        return { archivedCount: r.archivedCount };
      },
    });

    const first = await s.runJob("stale_cleanup");
    expect(first.detail?.archivedCount).toBe(1);

    // Second run: already archived, should be a no-op.
    const second = await s.runJob("stale_cleanup");
    expect(second.ok).toBe(true);
    expect(second.detail?.archivedCount).toBe(0);
  });

  it("expiry scan is idempotent: expired orders cannot be re-expired", async () => {
    const repo = await freshRepo();
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Announce and src-lock an order with an expired timelock.
    const order = await repo.announce({ ...BASE_ORDER, hashlock: uniqueHashlock("c2") });
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-ord-1",
      txHash: "0xabc",
      blockNumber: 100,
      timelock: nowSeconds - 10, // already expired
    });

    let runCount = 0;
    const s = makeScheduler();
    s.register({
      name: "expiry_scan",
      cadenceMultiplier: 1,
      priority: Priority.REPLAY_JOB,
      execute: async () => {
        runCount++;
        const candidates = await repo.findExpiredCandidates(nowSeconds);
        let expired = 0;
        for (const c of candidates) {
          try {
            await repo.setStatus(c.publicId, "expired");
            expired++;
          } catch { /* state machine already past */ }
        }
        return { expiredCount: expired };
      },
    });

    const first = await s.runJob("expiry_scan");
    expect(first.detail?.expiredCount).toBe(1);

    const second = await s.runJob("expiry_scan");
    // expired → expired is not a valid transition, so 0 on second run.
    expect(second.detail?.expiredCount).toBe(0);
    expect(runCount).toBe(2);
  });
});

// ── Over-retention ────────────────────────────────────────────────────────────

describe("MaintenanceScheduler — over-retention scenarios", () => {
  it("archives all orders beyond retention, leaves fresh orders untouched", async () => {
    const repo = await freshRepo();
    const cleanup = new StaleCleanupService(repo, log, 30);

    // 3 stale orders
    for (let i = 0; i < 3; i++) {
      const o = await repo.announce({ ...BASE_ORDER, hashlock: uniqueHashlock(`d${i}`) });
      await backdate(repo, o.publicId, 31 * 24 * 3600);
    }
    // 2 fresh orders
    for (let i = 3; i < 5; i++) {
      await repo.announce({ ...BASE_ORDER, hashlock: uniqueHashlock(`d${i}`) });
    }

    const s = makeScheduler();
    s.register({
      name: "stale_cleanup",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {
        const r = await cleanup.run();
        return { archivedCount: r.archivedCount };
      },
    });

    const result = await s.runJob("stale_cleanup");
    expect(result.detail?.archivedCount).toBe(3);
  });

  it("batchSize cap leaves remaining stale orders for the next run", async () => {
    const repo = await freshRepo();
    // batchSize=2: only 2 per run
    const cleanup = new StaleCleanupService(repo, log, 30, 2);

    for (let i = 0; i < 5; i++) {
      const o = await repo.announce({ ...BASE_ORDER, hashlock: uniqueHashlock(`e${i}`) });
      await backdate(repo, o.publicId, 31 * 24 * 3600);
    }

    const s = makeScheduler();
    s.register({
      name: "stale_cleanup",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {
        const r = await cleanup.run();
        return { archivedCount: r.archivedCount };
      },
    });

    const r1 = await s.runJob("stale_cleanup");
    expect(r1.detail?.archivedCount).toBe(2);

    const r2 = await s.runJob("stale_cleanup");
    expect(r2.detail?.archivedCount).toBe(2);

    const r3 = await s.runJob("stale_cleanup");
    expect(r3.detail?.archivedCount).toBe(1);

    const r4 = await s.runJob("stale_cleanup");
    expect(r4.detail?.archivedCount).toBe(0);
  });
});

// ── Skip-if-running ───────────────────────────────────────────────────────────

describe("MaintenanceScheduler — skip-if-running guard", () => {
  it("concurrent invocation returns skipped=true and does not double-execute", async () => {
    let execCount = 0;
    let resolveExec!: () => void;

    const s = makeScheduler();
    s.register({
      name: "slow_job",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: () =>
        new Promise<void>((resolve) => {
          execCount++;
          resolveExec = resolve;
        }),
    });

    // Start first run — it will hang until we call resolveExec.
    const first = s.runJob("slow_job");

    // Try a second run while first is in flight.
    const second = await s.runJob("slow_job");
    expect(second.skipped).toBe(true);
    expect(second.ok).toBe(true);

    // Finish the first run.
    resolveExec();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    expect(firstResult.skipped).toBe(false);

    // Only one actual execution happened.
    expect(execCount).toBe(1);
  });

  it("after the first run completes, a subsequent call executes normally", async () => {
    let count = 0;
    const s = makeScheduler();
    s.register({
      name: "countable",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => { count++; return { count }; },
    });

    await s.runJob("countable");
    await s.runJob("countable");
    expect(count).toBe(2);
  });
});

// ── Failure handling ──────────────────────────────────────────────────────────

describe("MaintenanceScheduler — failure handling", () => {
  it("a throwing job returns ok=false with the error message, does not throw to caller", async () => {
    const s = makeScheduler();
    s.register({
      name: "bad_job",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {
        throw new Error("simulated failure");
      },
    });

    const result = await s.runJob("bad_job");
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.error).toBe("simulated failure");
  });

  it("after a failure the in-flight flag is cleared so the next run executes", async () => {
    let attempt = 0;
    const s = makeScheduler();
    s.register({
      name: "flaky",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {
        attempt++;
        if (attempt === 1) throw new Error("first run fails");
        return { attempt };
      },
    });

    const r1 = await s.runJob("flaky");
    expect(r1.ok).toBe(false);

    const r2 = await s.runJob("flaky");
    expect(r2.ok).toBe(true);
    expect(r2.detail?.attempt).toBe(2);
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe("MaintenanceScheduler — lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("isRunning reflects start/stop correctly", () => {
    const s = makeScheduler();
    s.register({
      name: "dummy",
      cadenceMultiplier: 100_000, // very long — won't fire in test
      priority: Priority.STALE_CLEANUP,
      execute: async () => {},
    });

    expect(s.isRunning).toBe(false);
    s.start();
    expect(s.isRunning).toBe(true);
    s.stop();
    expect(s.isRunning).toBe(false);
    s.stop(); // idempotent
    expect(s.isRunning).toBe(false);
  });

  it("start() is idempotent — calling twice does not double-register intervals", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const s = makeScheduler();
    s.register({
      name: "dummy",
      cadenceMultiplier: 100_000,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {},
    });

    s.start();
    const callsAfterFirst = setIntervalSpy.mock.calls.length;
    s.start(); // second call — should be no-op
    expect(setIntervalSpy.mock.calls.length).toBe(callsAfterFirst);

    s.stop();
  });

  it("getStatus returns one entry per registered job", () => {
    const s = makeScheduler();
    for (const name of ["job_a", "job_b"]) {
      s.register({
        name,
        cadenceMultiplier: 1,
        priority: Priority.STALE_CLEANUP,
        execute: async () => {},
      });
    }

    const status = s.getStatus();
    expect(status).toHaveLength(2);
    expect(status.map((j) => j.name).sort()).toEqual(["job_a", "job_b"]);
    for (const entry of status) {
      expect(entry.inFlight).toBe(false);
      expect(entry.tickCount).toBe(0);
      expect(entry.cadenceMs).toBeGreaterThan(0);
    }
  });
});

// ── runAll ────────────────────────────────────────────────────────────────────

describe("MaintenanceScheduler — runAll", () => {
  it("executes all registered jobs and returns results in registration order", async () => {
    const executed: string[] = [];
    const s = makeScheduler();

    for (const name of ["alpha", "beta", "gamma"]) {
      const n = name;
      s.register({
        name: n,
        cadenceMultiplier: 1,
        priority: Priority.STALE_CLEANUP,
        execute: async () => { executed.push(n); return { ran: n }; },
      });
    }

    const results = await s.runAll();
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.jobName)).toEqual(["alpha", "beta", "gamma"]);
    expect(executed).toEqual(["alpha", "beta", "gamma"]);
  });

  it("runAll continues past a failing job and returns all results", async () => {
    const s = makeScheduler();
    s.register({
      name: "ok_first",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => ({ step: 1 }),
    });
    s.register({
      name: "fails",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => { throw new Error("boom"); },
    });
    s.register({
      name: "ok_last",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => ({ step: 3 }),
    });

    const results = await s.runAll();
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
    expect(results[1]!.error).toBe("boom");
    expect(results[2]!.ok).toBe(true);
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe("MaintenanceScheduler — error cases", () => {
  it("runJob throws synchronously for an unregistered job name", async () => {
    const s = makeScheduler();
    await expect(s.runJob("nonexistent")).rejects.toThrow('unknown job "nonexistent"');
  });

  it("registering the same job name twice throws", () => {
    const s = makeScheduler();
    s.register({
      name: "dup",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {},
    });
    expect(() =>
      s.register({
        name: "dup",
        cadenceMultiplier: 1,
        priority: Priority.STALE_CLEANUP,
        execute: async () => {},
      })
    ).toThrow('already registered');
  });
});

// ── Prometheus metric assertions ──────────────────────────────────────────────

describe("MaintenanceScheduler — Prometheus metrics", () => {
  it("maintenanceRunsTotal increments on success", async () => {
    const { maintenanceRunsTotal } = await import("../src/metrics.js");

    const before =
      (await maintenanceRunsTotal.get()).values.find(
        (v) => v.labels.job === "metrics_test_ok" && v.labels.result === "success"
      )?.value ?? 0;

    const s = makeScheduler();
    s.register({
      name: "metrics_test_ok",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {},
    });
    await s.runJob("metrics_test_ok");

    const after =
      (await maintenanceRunsTotal.get()).values.find(
        (v) => v.labels.job === "metrics_test_ok" && v.labels.result === "success"
      )?.value ?? 0;

    expect(after).toBe(before + 1);
  });

  it("maintenanceRunsTotal increments on failure", async () => {
    const { maintenanceRunsTotal } = await import("../src/metrics.js");

    const before =
      (await maintenanceRunsTotal.get()).values.find(
        (v) => v.labels.job === "metrics_test_fail" && v.labels.result === "failure"
      )?.value ?? 0;

    const s = makeScheduler();
    s.register({
      name: "metrics_test_fail",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => { throw new Error("fail"); },
    });
    await s.runJob("metrics_test_fail");

    const after =
      (await maintenanceRunsTotal.get()).values.find(
        (v) => v.labels.job === "metrics_test_fail" && v.labels.result === "failure"
      )?.value ?? 0;

    expect(after).toBe(before + 1);
  });

  it("maintenanceSkippedTotal increments when a concurrent run is skipped", async () => {
    const { maintenanceSkippedTotal } = await import("../src/metrics.js");

    let resolve!: () => void;
    const s = makeScheduler();
    s.register({
      name: "metrics_test_skip",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: () => new Promise<void>((res) => { resolve = res; }),
    });

    const before =
      (await maintenanceSkippedTotal.get()).values.find(
        (v) => v.labels.job === "metrics_test_skip"
      )?.value ?? 0;

    // Start the first (slow) run.
    const first = s.runJob("metrics_test_skip");
    // Second run while first is in flight — should be skipped.
    await s.runJob("metrics_test_skip");

    const after =
      (await maintenanceSkippedTotal.get()).values.find(
        (v) => v.labels.job === "metrics_test_skip"
      )?.value ?? 0;

    expect(after).toBe(before + 1);

    resolve();
    await first;
  });

  it("maintenanceLastRun is set to approximately now after a successful run", async () => {
    const { maintenanceLastRun } = await import("../src/metrics.js");

    const before = Date.now() / 1000;

    const s = makeScheduler();
    s.register({
      name: "metrics_test_lastrun",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => {},
    });
    await s.runJob("metrics_test_lastrun");

    const after = Date.now() / 1000;
    const recorded =
      (await maintenanceLastRun.get()).values.find(
        (v) => v.labels.job === "metrics_test_lastrun"
      )?.value ?? 0;

    expect(recorded).toBeGreaterThanOrEqual(Math.floor(before));
    expect(recorded).toBeLessThanOrEqual(Math.ceil(after));
  });

  it("maintenanceLastRun is NOT updated when a job fails", async () => {
    const { maintenanceLastRun } = await import("../src/metrics.js");

    // Read the value before (may be 0 if this label has never been set).
    const before =
      (await maintenanceLastRun.get()).values.find(
        (v) => v.labels.job === "metrics_test_lastrun_fail"
      )?.value ?? 0;

    const s = makeScheduler();
    s.register({
      name: "metrics_test_lastrun_fail",
      cadenceMultiplier: 1,
      priority: Priority.STALE_CLEANUP,
      execute: async () => { throw new Error("nope"); },
    });
    await s.runJob("metrics_test_lastrun_fail");

    const after =
      (await maintenanceLastRun.get()).values.find(
        (v) => v.labels.job === "metrics_test_lastrun_fail"
      )?.value ?? 0;

    // The gauge must not have advanced on failure.
    expect(after).toBe(before);
  });
});

// ── Integration: expiry scan with real repo ───────────────────────────────────

describe("MaintenanceScheduler — expiry scan integration", () => {
  it("marks src_locked orders whose timelock has passed as expired", async () => {
    const repo = await freshRepo();
    const nowSeconds = Math.floor(Date.now() / 1000);

    const order = await repo.announce({
      ...BASE_ORDER,
      hashlock: uniqueHashlock("f1"),
    });
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-ord-exp",
      txHash: "0xdef",
      blockNumber: 50,
      timelock: nowSeconds - 5, // expired 5 seconds ago
    });

    const s = makeScheduler();
    s.register({
      name: "expiry_scan",
      cadenceMultiplier: 1,
      priority: Priority.REPLAY_JOB,
      execute: async () => {
        const candidates = await repo.findExpiredCandidates(nowSeconds);
        let expiredCount = 0;
        for (const c of candidates) {
          try {
            await repo.setStatus(c.publicId, "expired");
            expiredCount++;
          } catch { /* already terminal */ }
        }
        return { expiredCount };
      },
    });

    const result = await s.runJob("expiry_scan");
    expect(result.ok).toBe(true);
    expect(result.detail?.expiredCount).toBe(1);

    const updated = await repo.findByPublicId(order.publicId);
    expect(updated!.status).toBe("expired");
  });

  it("does not expire orders whose timelock has not yet passed", async () => {
    const repo = await freshRepo();
    const nowSeconds = Math.floor(Date.now() / 1000);

    const order = await repo.announce({
      ...BASE_ORDER,
      hashlock: uniqueHashlock("f2"),
    });
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-ord-live",
      txHash: "0x123",
      blockNumber: 50,
      timelock: nowSeconds + 3600, // still valid for an hour
    });

    const s = makeScheduler();
    s.register({
      name: "expiry_scan",
      cadenceMultiplier: 1,
      priority: Priority.REPLAY_JOB,
      execute: async () => {
        const candidates = await repo.findExpiredCandidates(nowSeconds);
        return { expiredCount: candidates.length };
      },
    });

    const result = await s.runJob("expiry_scan");
    expect(result.detail?.expiredCount).toBe(0);

    const unchanged = await repo.findByPublicId(order.publicId);
    expect(unchanged!.status).toBe("src_locked");
  });

  it("already-terminal orders are skipped by the expiry scan", async () => {
    const repo = await freshRepo();
    const nowSeconds = Math.floor(Date.now() / 1000);

    const order = await repo.announce({
      ...BASE_ORDER,
      hashlock: uniqueHashlock("f3"),
    });
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-ord-done",
      txHash: "0x456",
      blockNumber: 50,
      timelock: nowSeconds - 5,
    });
    // Move order to a terminal state before the expiry scan runs.
    await repo.setStatus(order.publicId, "refunded");

    const s = makeScheduler();
    s.register({
      name: "expiry_scan",
      cadenceMultiplier: 1,
      priority: Priority.REPLAY_JOB,
      execute: async () => {
        // findExpiredCandidates only returns src_locked / dst_locked — terminal
        // orders are excluded at the SQL level.
        const candidates = await repo.findExpiredCandidates(nowSeconds);
        return { expiredCount: candidates.length };
      },
    });

    const result = await s.runJob("expiry_scan");
    expect(result.detail?.expiredCount).toBe(0);
  });
});
