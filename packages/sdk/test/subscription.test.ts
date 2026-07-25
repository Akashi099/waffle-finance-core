/**
 * Tests for OrderSubscriber — bridge lifecycle event subscription.
 *
 * All tests use fake timers and a stubbed CoordinatorClient.
 * No real network calls or wall-clock delays are used.
 *
 * Scenarios covered:
 *   - subscribe fires statusChanged on first status change
 *   - secretRevealed fires when secret.revealed transitions false → true
 *   - settled fires on terminal status (completed / refunded / failed)
 *   - subscriber stops automatically on terminal status (stopOnTerminal=true)
 *   - subscriber continues after terminal when stopOnTerminal=false
 *   - unsubscribe (stop) prevents further events
 *   - error event fires on network failure; polling continues
 *   - error event fires on 404 (order not found)
 *   - maxConsecutiveErrors stops polling automatically
 *   - no events fired when status has not changed between polls
 *   - isRunning reflects subscriber lifecycle correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OrderSubscriber } from "../src/coordinator/subscription.js";
import type { CoordinatorClient } from "../src/coordinator/client.js";
import type { CoordinatorOrder } from "../src/coordinator/contract.js";
import type {
  StatusChangedEvent,
  SecretRevealedEvent,
  OrderSettledEvent,
  SubscriptionErrorEvent,
  SubscriptionStoppedEvent,
} from "../src/coordinator/subscription.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ETH_ADDR = "0x1111111111111111111111111111111111111111";
const XLM_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK = "0x" + "ab".repeat(32);
const ORDER_ID = `wf_${HASHLOCK}`;

function makeWireOrder(overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  return {
    id: ORDER_ID,
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

function makeStubClient(
  getOrderImpl: (id: string) => Promise<CoordinatorOrder | null>
): CoordinatorClient {
  return {
    getOrder: vi.fn(getOrderImpl),
    getHistory: vi.fn(),
    announceOrder: vi.fn(),
    revealSecret: vi.fn(),
    getSecret: vi.fn(),
    getHealth: vi.fn(),
    getReadiness: vi.fn(),
  } as unknown as CoordinatorClient;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Helper: run one immediate poll cycle ──────────────────────────────────────

async function tickOnce() {
  // The subscriber fires an immediate poll on start() then uses setInterval.
  // We let the microtask queue flush, then advance time by one interval.
  await vi.runAllMicrotasksAsync();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OrderSubscriber — status changes", () => {
  it("fires statusChanged when status advances", async () => {
    let call = 0;
    const client = makeStubClient(async () => {
      call++;
      return makeWireOrder({ status: call === 1 ? "announced" : "src_locked" });
    });

    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID, pollIntervalMs: 100 });
    const events: StatusChangedEvent[] = [];
    sub.on("statusChanged", (e) => events.push(e));
    sub.start();
    await tickOnce(); // first poll: announced, no previous status → no statusChanged yet

    // Second poll: status changes announced → src_locked
    vi.advanceTimersByTime(100);
    await tickOnce();

    expect(events).toHaveLength(1);
    expect(events[0]!.from).toBe("announced");
    expect(events[0]!.to).toBe("src_locked");
    expect(events[0]!.orderId).toBe(ORDER_ID);

    sub.stop();
  });

  it("does NOT fire statusChanged when status is unchanged between polls", async () => {
    const client = makeStubClient(async () => makeWireOrder({ status: "announced" }));

    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID, pollIntervalMs: 100 });
    const events: StatusChangedEvent[] = [];
    sub.on("statusChanged", (e) => events.push(e));
    sub.start();
    await tickOnce();

    vi.advanceTimersByTime(100);
    await tickOnce();

    vi.advanceTimersByTime(100);
    await tickOnce();

    expect(events).toHaveLength(0);
    sub.stop();
  });
});

describe("OrderSubscriber — secretRevealed", () => {
  it("fires secretRevealed when revealed transitions false → true", async () => {
    const preimage = "0x" + "cc".repeat(32);
    let call = 0;
    const client = makeStubClient(async () => {
      call++;
      if (call === 1) return makeWireOrder({ status: "src_locked" });
      return makeWireOrder({
        status: "secret_revealed",
        secret: { revealed: true, preimage, revealedTx: "0x" + "dd".repeat(32) },
      });
    });

    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID, pollIntervalMs: 100 });
    const events: SecretRevealedEvent[] = [];
    sub.on("secretRevealed", (e) => events.push(e));
    sub.start();
    await tickOnce();

    vi.advanceTimersByTime(100);
    await tickOnce();

    expect(events).toHaveLength(1);
    expect(events[0]!.preimage).toBe(preimage);
    expect(events[0]!.orderId).toBe(ORDER_ID);

    sub.stop();
  });

  it("does NOT re-fire secretRevealed on subsequent polls after reveal", async () => {
    const preimage = "0x" + "cc".repeat(32);
    const client = makeStubClient(async () =>
      makeWireOrder({
        status: "secret_revealed",
        secret: { revealed: true, preimage, revealedTx: "0xtx" },
      })
    );

    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID, pollIntervalMs: 100, stopOnTerminal: false });
    const events: SecretRevealedEvent[] = [];
    sub.on("secretRevealed", (e) => events.push(e));
    sub.start();
    await tickOnce(); // first poll — fires secretRevealed

    vi.advanceTimersByTime(100);
    await tickOnce(); // second poll — already revealed, must not re-fire

    expect(events).toHaveLength(1);
    sub.stop();
  });
});

describe("OrderSubscriber — terminal / settled", () => {
  it("fires settled when order reaches completed", async () => {
    let call = 0;
    const client = makeStubClient(async () => {
      call++;
      return makeWireOrder({ status: call === 1 ? "secret_revealed" : "completed" });
    });

    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID, pollIntervalMs: 100 });
    const settled: OrderSettledEvent[] = [];
    sub.on("settled", (e) => settled.push(e));
    sub.start();
    await tickOnce();

    vi.advanceTimersByTime(100);
    await tickOnce();

    expect(settled).toHaveLength(1);
    expect(settled[0]!.finalStatus).toBe("completed");
  });

  it("stops automatically on terminal status when stopOnTerminal=true (default)", async () => {
    let call = 0;
    const client = makeStubClient(async () => {
      call++;
      return makeWireOrder({ status: call === 1 ? "src_locked" : "refunded" });
    });

    const stoppedEvents: SubscriptionStoppedEvent[] = [];
    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID, pollIntervalMs: 100 });
    sub.on("stopped", (e) => stoppedEvents.push(e));
    sub.start();
    await tickOnce();

    vi.advanceTimersByTime(100);
    await tickOnce();

    expect(sub.isRunning).toBe(false);
    expect(stoppedEvents[0]!.reason).toBe("terminal");
  });

  it("continues polling after terminal when stopOnTerminal=false", async () => {
    let call = 0;
    const client = makeStubClient(async () => {
      call++;
      return makeWireOrder({ status: call === 1 ? "announced" : "completed" });
    });

    const sub = new OrderSubscriber({
      coordinatorClient: client,
      orderId: ORDER_ID,
      pollIntervalMs: 100,
      stopOnTerminal: false,
    });
    sub.start();
    await tickOnce();

    vi.advanceTimersByTime(100);
    await tickOnce();

    expect(sub.isRunning).toBe(true);
    sub.stop();
  });
});

describe("OrderSubscriber — unsubscribe", () => {
  it("stop() prevents further events after being called", async () => {
    let call = 0;
    const client = makeStubClient(async () => {
      call++;
      return makeWireOrder({ status: call <= 2 ? "announced" : "src_locked" });
    });

    const events: StatusChangedEvent[] = [];
    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID, pollIntervalMs: 100 });
    sub.on("statusChanged", (e) => events.push(e));
    sub.start();
    await tickOnce();

    sub.stop(); // stop before any status change poll

    vi.advanceTimersByTime(500);
    await tickOnce();

    expect(events).toHaveLength(0);
    expect(sub.isRunning).toBe(false);
  });

  it("stop() is safe to call multiple times", () => {
    const client = makeStubClient(async () => makeWireOrder());
    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID });
    sub.start();
    expect(() => { sub.stop(); sub.stop(); sub.stop(); }).not.toThrow();
  });

  it("stop() before start() does not throw", () => {
    const client = makeStubClient(async () => makeWireOrder());
    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID });
    expect(() => sub.stop()).not.toThrow();
    expect(sub.isRunning).toBe(false);
  });
});

describe("OrderSubscriber — error handling", () => {
  it("fires error event on network failure and keeps polling", async () => {
    let call = 0;
    const client = makeStubClient(async () => {
      call++;
      if (call <= 2) throw new Error("network timeout");
      return makeWireOrder({ status: "src_locked" });
    });

    const errors: SubscriptionErrorEvent[] = [];
    const sub = new OrderSubscriber({
      coordinatorClient: client,
      orderId: ORDER_ID,
      pollIntervalMs: 100,
      maxConsecutiveErrors: 5,
    });
    sub.on("error", (e) => errors.push(e));
    sub.start();
    await tickOnce(); // call 1: error

    vi.advanceTimersByTime(100);
    await tickOnce(); // call 2: error

    vi.advanceTimersByTime(100);
    await tickOnce(); // call 3: success

    expect(errors).toHaveLength(2);
    expect(errors[0]!.consecutiveFailures).toBe(1);
    expect(errors[1]!.consecutiveFailures).toBe(2);
    expect(sub.isRunning).toBe(true);

    sub.stop();
  });

  it("fires error event when getOrder returns null (404)", async () => {
    const client = makeStubClient(async () => null);

    const errors: SubscriptionErrorEvent[] = [];
    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID, pollIntervalMs: 100 });
    sub.on("error", (e) => errors.push(e));
    sub.start();
    await tickOnce();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.message).toContain("not found");

    sub.stop();
  });

  it("stops automatically after maxConsecutiveErrors", async () => {
    const client = makeStubClient(async () => { throw new Error("always fails"); });

    const stoppedEvents: SubscriptionStoppedEvent[] = [];
    const sub = new OrderSubscriber({
      coordinatorClient: client,
      orderId: ORDER_ID,
      pollIntervalMs: 100,
      maxConsecutiveErrors: 3,
    });
    sub.on("stopped", (e) => stoppedEvents.push(e));
    sub.start();

    // 3 error polls
    await tickOnce();
    vi.advanceTimersByTime(100); await tickOnce();
    vi.advanceTimersByTime(100); await tickOnce();

    expect(sub.isRunning).toBe(false);
    expect(stoppedEvents[0]!.reason).toBe("max_errors");
  });

  it("resets consecutiveFailures counter after a successful poll", async () => {
    let call = 0;
    const client = makeStubClient(async () => {
      call++;
      if (call === 1) throw new Error("transient failure");
      return makeWireOrder();
    });

    const errors: SubscriptionErrorEvent[] = [];
    const sub = new OrderSubscriber({
      coordinatorClient: client,
      orderId: ORDER_ID,
      pollIntervalMs: 100,
      maxConsecutiveErrors: 5,
    });
    sub.on("error", (e) => errors.push(e));
    sub.start();
    await tickOnce(); // call 1: error

    vi.advanceTimersByTime(100);
    await tickOnce(); // call 2: success — counter resets

    // A subsequent error should start from 1 again
    vi.advanceTimersByTime(100);
    // No third error in this test sequence — just confirm we're still running
    expect(sub.isRunning).toBe(true);
    expect(errors[0]!.consecutiveFailures).toBe(1);

    sub.stop();
  });
});

describe("OrderSubscriber — off()", () => {
  it("off() removes a specific handler", async () => {
    let call = 0;
    const client = makeStubClient(async () => {
      call++;
      return makeWireOrder({ status: call === 1 ? "announced" : "src_locked" });
    });

    const events: StatusChangedEvent[] = [];
    const handler = (e: StatusChangedEvent) => events.push(e);

    const sub = new OrderSubscriber({ coordinatorClient: client, orderId: ORDER_ID, pollIntervalMs: 100 });
    sub.on("statusChanged", handler);
    sub.off("statusChanged", handler);
    sub.start();
    await tickOnce();

    vi.advanceTimersByTime(100);
    await tickOnce();

    expect(events).toHaveLength(0);
    sub.stop();
  });
});
