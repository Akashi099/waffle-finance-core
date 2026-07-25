/**
 * Tests for BacklogScheduler — deterministic backlog prioritization contract.
 *
 * The tests confirm that:
 *  1. Priority ordering is enforced (LIVE_EVENT runs before REPLAY, etc.).
 *  2. Queue depth metrics are updated correctly.
 *  3. The maxQueueDepth cap drops new jobs and increments the dropped counter.
 *  4. A failing job does NOT stall the scheduler — subsequent jobs still run.
 *  5. singleStep mode processes exactly one job per run() call.
 *  6. Multiple competing job types resolve in the correct order under load.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { BacklogScheduler, Priority, PRIORITY_LABELS } from "../src/backlog/backlog-scheduler.js";

const log = pino({ level: "silent" });

// ── helpers ───────────────────────────────────────────────────────────────────

function makeJob(name: string, priority: Priority, fn?: () => Promise<void>) {
  return {
    name,
    priority,
    execute: fn ?? (() => Promise.resolve()),
  };
}

// ── basic enqueue / run ───────────────────────────────────────────────────────

describe("BacklogScheduler — enqueue and run", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs a single enqueued job", async () => {
    const sched = new BacklogScheduler(log);
    const fn = vi.fn(async () => {});
    sched.enqueue(makeJob("test", Priority.LIVE_EVENT, fn));

    const executed = await sched.run();
    expect(fn).toHaveBeenCalledOnce();
    expect(executed).toBe(1);
  });

  it("returns 0 when the queue is empty", async () => {
    const sched = new BacklogScheduler(log);
    const executed = await sched.run();
    expect(executed).toBe(0);
  });

  it("drains all queued jobs in a single run() call", async () => {
    const sched = new BacklogScheduler(log);
    const order: string[] = [];

    for (let i = 0; i < 5; i++) {
      const idx = i;
      sched.enqueue(makeJob(`job-${idx}`, Priority.STALE_CLEANUP, async () => {
        order.push(`job-${idx}`);
      }));
    }

    const executed = await sched.run();
    expect(executed).toBe(5);
    // FIFO within the same priority
    expect(order).toEqual(["job-0", "job-1", "job-2", "job-3", "job-4"]);
  });
});

// ── priority ordering ──────────────────────────────────────────────────────────

describe("BacklogScheduler — priority ordering", () => {
  it("processes LIVE_EVENT before REPLAY_JOB before SECRET_RECOVERY before STALE_CLEANUP", async () => {
    const sched = new BacklogScheduler(log);
    const executed: string[] = [];

    // Enqueue in reverse priority order to prove ordering is NOT insertion-order.
    sched.enqueue(makeJob("stale",   Priority.STALE_CLEANUP,   async () => { executed.push("stale"); }));
    sched.enqueue(makeJob("secret",  Priority.SECRET_RECOVERY,  async () => { executed.push("secret"); }));
    sched.enqueue(makeJob("replay",  Priority.REPLAY_JOB,       async () => { executed.push("replay"); }));
    sched.enqueue(makeJob("live",    Priority.LIVE_EVENT,       async () => { executed.push("live"); }));

    await sched.run();

    expect(executed).toEqual(["live", "replay", "secret", "stale"]);
  });

  it("within the same priority, jobs execute in FIFO order", async () => {
    const sched = new BacklogScheduler(log);
    const executed: string[] = [];

    for (const name of ["a", "b", "c"]) {
      sched.enqueue(makeJob(name, Priority.REPLAY_JOB, async () => { executed.push(name); }));
    }

    await sched.run();
    expect(executed).toEqual(["a", "b", "c"]);
  });

  it("drains higher-priority queue completely before touching lower-priority queue", async () => {
    const sched = new BacklogScheduler(log, { singleStep: true });
    const executed: string[] = [];

    // Two live events and one stale cleanup
    sched.enqueue(makeJob("live1", Priority.LIVE_EVENT,   async () => { executed.push("live1"); }));
    sched.enqueue(makeJob("live2", Priority.LIVE_EVENT,   async () => { executed.push("live2"); }));
    sched.enqueue(makeJob("stale", Priority.STALE_CLEANUP, async () => { executed.push("stale"); }));

    // singleStep: one job per run()
    await sched.run();
    expect(executed).toEqual(["live1"]);

    await sched.run();
    expect(executed).toEqual(["live1", "live2"]);

    await sched.run();
    expect(executed).toEqual(["live1", "live2", "stale"]);
  });
});

// ── queue depth metrics and introspection ─────────────────────────────────────

describe("BacklogScheduler — queue depth", () => {
  it("getQueueDepths() reflects enqueued jobs before run()", () => {
    const sched = new BacklogScheduler(log);

    sched.enqueue(makeJob("a", Priority.LIVE_EVENT));
    sched.enqueue(makeJob("b", Priority.LIVE_EVENT));
    sched.enqueue(makeJob("c", Priority.REPLAY_JOB));

    const depths = sched.getQueueDepths();
    expect(depths[PRIORITY_LABELS[Priority.LIVE_EVENT]]).toBe(2);
    expect(depths[PRIORITY_LABELS[Priority.REPLAY_JOB]]).toBe(1);
    expect(depths[PRIORITY_LABELS[Priority.SECRET_RECOVERY]]).toBe(0);
    expect(depths[PRIORITY_LABELS[Priority.STALE_CLEANUP]]).toBe(0);
  });

  it("getTotalDepth() sums all queues", () => {
    const sched = new BacklogScheduler(log);
    sched.enqueue(makeJob("a", Priority.LIVE_EVENT));
    sched.enqueue(makeJob("b", Priority.REPLAY_JOB));
    sched.enqueue(makeJob("c", Priority.STALE_CLEANUP));
    expect(sched.getTotalDepth()).toBe(3);
  });

  it("queue depth decrements as jobs are executed", async () => {
    const sched = new BacklogScheduler(log, { singleStep: true });
    sched.enqueue(makeJob("a", Priority.LIVE_EVENT));
    sched.enqueue(makeJob("b", Priority.LIVE_EVENT));

    expect(sched.getTotalDepth()).toBe(2);
    await sched.run();
    expect(sched.getTotalDepth()).toBe(1);
    await sched.run();
    expect(sched.getTotalDepth()).toBe(0);
  });

  it("clear() empties all queues without executing jobs", async () => {
    const sched = new BacklogScheduler(log);
    const fn = vi.fn(async () => {});
    sched.enqueue(makeJob("a", Priority.LIVE_EVENT, fn));
    sched.enqueue(makeJob("b", Priority.STALE_CLEANUP, fn));

    sched.clear();

    expect(sched.getTotalDepth()).toBe(0);
    const executed = await sched.run();
    expect(executed).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ── max queue depth cap ───────────────────────────────────────────────────────

describe("BacklogScheduler — maxQueueDepth cap", () => {
  it("drops jobs when queue is full and returns false", () => {
    const sched = new BacklogScheduler(log, { maxQueueDepth: 2 });

    const accepted1 = sched.enqueue(makeJob("a", Priority.STALE_CLEANUP));
    const accepted2 = sched.enqueue(makeJob("b", Priority.STALE_CLEANUP));
    const dropped   = sched.enqueue(makeJob("c", Priority.STALE_CLEANUP));

    expect(accepted1).toBe(true);
    expect(accepted2).toBe(true);
    expect(dropped).toBe(false);
    expect(sched.getQueueDepths()[PRIORITY_LABELS[Priority.STALE_CLEANUP]]).toBe(2);
  });

  it("accepts jobs again after the queue drains below maxQueueDepth", async () => {
    const sched = new BacklogScheduler(log, { maxQueueDepth: 2, singleStep: true });
    sched.enqueue(makeJob("a", Priority.STALE_CLEANUP));
    sched.enqueue(makeJob("b", Priority.STALE_CLEANUP));

    // Queue full — should drop
    expect(sched.enqueue(makeJob("c", Priority.STALE_CLEANUP))).toBe(false);

    // Drain one job
    await sched.run();

    // Now there's capacity — should accept
    expect(sched.enqueue(makeJob("d", Priority.STALE_CLEANUP))).toBe(true);
  });

  it("maxQueueDepth=0 disables the cap", () => {
    const sched = new BacklogScheduler(log, { maxQueueDepth: 0 });
    for (let i = 0; i < 2000; i++) {
      expect(sched.enqueue(makeJob(`j${i}`, Priority.STALE_CLEANUP))).toBe(true);
    }
    expect(sched.getTotalDepth()).toBe(2000);
  });
});

// ── error resilience ──────────────────────────────────────────────────────────

describe("BacklogScheduler — error resilience", () => {
  it("a failing job does not stall subsequent jobs", async () => {
    const sched = new BacklogScheduler(log);
    const executed: string[] = [];

    sched.enqueue(makeJob("live-fail", Priority.LIVE_EVENT, async () => {
      throw new Error("live event processing failed");
    }));
    sched.enqueue(makeJob("replay-ok", Priority.REPLAY_JOB, async () => {
      executed.push("replay-ok");
    }));
    sched.enqueue(makeJob("stale-ok", Priority.STALE_CLEANUP, async () => {
      executed.push("stale-ok");
    }));

    // Should not throw even though the first job fails
    const count = await sched.run();

    expect(count).toBe(3);
    expect(executed).toContain("replay-ok");
    expect(executed).toContain("stale-ok");
  });

  it("run() resolves normally even when all jobs fail", async () => {
    const sched = new BacklogScheduler(log);
    for (let i = 0; i < 3; i++) {
      sched.enqueue(makeJob(`fail-${i}`, Priority.LIVE_EVENT, async () => {
        throw new Error(`job ${i} failed`);
      }));
    }
    await expect(sched.run()).resolves.toBe(3);
  });
});

// ── backlog growth simulation ─────────────────────────────────────────────────

describe("BacklogScheduler — backlog growth under competing load", () => {
  it("correctly prioritizes live events over replay under sustained backlog", async () => {
    const sched = new BacklogScheduler(log);
    const executionLog: string[] = [];

    // Simulate a scenario where 10 replay jobs and 5 live events are queued
    // simultaneously (e.g. coordinator restart with a full backlog)
    for (let i = 0; i < 10; i++) {
      sched.enqueue(makeJob(`replay-${i}`, Priority.REPLAY_JOB, async () => {
        executionLog.push(`replay-${i}`);
      }));
    }
    for (let i = 0; i < 5; i++) {
      sched.enqueue(makeJob(`live-${i}`, Priority.LIVE_EVENT, async () => {
        executionLog.push(`live-${i}`);
      }));
    }
    for (let i = 0; i < 3; i++) {
      sched.enqueue(makeJob(`stale-${i}`, Priority.STALE_CLEANUP, async () => {
        executionLog.push(`stale-${i}`);
      }));
    }

    await sched.run();

    expect(executionLog).toHaveLength(18);

    // All live events must appear before any replay job
    const firstReplayIndex = executionLog.findIndex((e) => e.startsWith("replay-"));
    const lastLiveIndex = Math.max(
      ...executionLog.map((e, i) => (e.startsWith("live-") ? i : -1))
    );
    expect(lastLiveIndex).toBeLessThan(firstReplayIndex);

    // All replay jobs must appear before any stale cleanup
    const firstStaleIndex = executionLog.findIndex((e) => e.startsWith("stale-"));
    const lastReplayIndex = Math.max(
      ...executionLog.map((e, i) => (e.startsWith("replay-") ? i : -1))
    );
    expect(lastReplayIndex).toBeLessThan(firstStaleIndex);
  });

  it("two sequential run() calls each see the correct priority ordering", async () => {
    const sched = new BacklogScheduler(log);
    const wave1: string[] = [];
    const wave2: string[] = [];

    // Wave 1: seed jobs
    sched.enqueue(makeJob("stale-a", Priority.STALE_CLEANUP, async () => { wave1.push("stale-a"); }));
    sched.enqueue(makeJob("live-a",  Priority.LIVE_EVENT,    async () => { wave1.push("live-a"); }));

    await sched.run();

    // live-a should have run before stale-a
    expect(wave1).toEqual(["live-a", "stale-a"]);

    // Wave 2: new jobs enqueued after first drain
    sched.enqueue(makeJob("stale-b", Priority.STALE_CLEANUP, async () => { wave2.push("stale-b"); }));
    sched.enqueue(makeJob("replay-b",Priority.REPLAY_JOB,    async () => { wave2.push("replay-b"); }));

    await sched.run();
    expect(wave2).toEqual(["replay-b", "stale-b"]);
  });

  it("system remains consistent after a large burst of mixed-priority jobs", async () => {
    const sched = new BacklogScheduler(log, { maxQueueDepth: 500 });
    const counts: Record<string, number> = {
      live_event: 0,
      replay_job: 0,
      secret_recovery: 0,
      stale_cleanup: 0,
    };

    const priorities: Array<[Priority, string]> = [
      [Priority.LIVE_EVENT,      "live_event"],
      [Priority.REPLAY_JOB,      "replay_job"],
      [Priority.SECRET_RECOVERY, "secret_recovery"],
      [Priority.STALE_CLEANUP,   "stale_cleanup"],
    ];

    // Enqueue 50 jobs per class (200 total)
    for (const [priority, label] of priorities) {
      for (let i = 0; i < 50; i++) {
        sched.enqueue(makeJob(`${label}-${i}`, priority, async () => {
          counts[label]++;
        }));
      }
    }

    expect(sched.getTotalDepth()).toBe(200);

    const executed = await sched.run();

    expect(executed).toBe(200);
    expect(sched.getTotalDepth()).toBe(0);

    // Every job was executed exactly once
    for (const label of Object.keys(counts)) {
      expect(counts[label]).toBe(50);
    }
  });
});

// ── Prometheus metric integration ─────────────────────────────────────────────

describe("BacklogScheduler — Prometheus metrics", () => {
  it("increments backlogJobsExecuted counter on successful job", async () => {
    const { backlogJobsExecuted } = await import("../src/backlog/backlog-metrics.js");

    const before = (await backlogJobsExecuted.get()).values.find(
      (v) => v.labels.priority === "live_event" && v.labels.result === "success"
    )?.value ?? 0;

    const sched = new BacklogScheduler(log);
    sched.enqueue(makeJob("metric-test", Priority.LIVE_EVENT));
    await sched.run();

    const after = (await backlogJobsExecuted.get()).values.find(
      (v) => v.labels.priority === "live_event" && v.labels.result === "success"
    )?.value ?? 0;

    expect(after).toBeGreaterThan(before);
  });

  it("increments backlogDropped counter when queue is full", async () => {
    const { backlogDropped } = await import("../src/backlog/backlog-metrics.js");

    const label = "stale_cleanup";
    const before = (await backlogDropped.get()).values.find(
      (v) => v.labels.priority === label
    )?.value ?? 0;

    const sched = new BacklogScheduler(log, { maxQueueDepth: 1 });
    sched.enqueue(makeJob("ok",      Priority.STALE_CLEANUP));
    sched.enqueue(makeJob("dropped", Priority.STALE_CLEANUP)); // this should be dropped

    const after = (await backlogDropped.get()).values.find(
      (v) => v.labels.priority === label
    )?.value ?? 0;

    expect(after).toBeGreaterThan(before);
  });
});
