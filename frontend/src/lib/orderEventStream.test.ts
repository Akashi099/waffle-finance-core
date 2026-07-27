/**
 * Subscription-mechanics tests.
 *
 * Organised around the three scenarios the issue calls out — initial
 * subscription, incremental status updates, teardown — plus the failure
 * semantics that make teardown trustworthy.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createOrderEventPayload, type OrderEvent, type OrderEventPayload } from './orderEvents';
import {
  createOrderEventChannel,
  createPollingTransport,
  mergeTransports,
  publishLocalOrderStatus,
  subscribeToOrderEvents,
  type OrderEventTransport,
  type OrderObservationEmitter,
} from './orderEventStream';

/** A transport that hands its emitter back so a test can drive it by hand. */
function manualTransport() {
  const teardown = vi.fn();
  let emitter: OrderObservationEmitter | null = null;

  const transport: OrderEventTransport = {
    start(given) {
      emitter = given;
      return teardown;
    },
  };

  return {
    transport,
    teardown,
    get emitter() {
      if (!emitter) throw new Error('transport not started');
      return emitter;
    },
  };
}

function order(
  orderId: string,
  status: string,
  extra: Partial<Parameters<typeof createOrderEventPayload>[0]> = {}
): OrderEventPayload {
  return createOrderEventPayload({ orderId, status, source: 'poll', ...extra });
}

const typesOf = (events: OrderEvent[]) => events.map((event) => event.type);

// ── Initial subscription ─────────────────────────────────────────────────────

describe('subscribeToOrderEvents — initial subscription', () => {
  test('acknowledges with `subscribed` before the transport starts', () => {
    const seen: OrderEvent[] = [];
    let eventsAtStart: number | null = null;

    const transport: OrderEventTransport = {
      start() {
        eventsAtStart = seen.length;
        return () => {};
      },
    };

    const sub = subscribeToOrderEvents({ transport, onEvent: (e) => seen.push(e) });

    // A transport that emits synchronously must not be able to produce events
    // before the acknowledgement.
    expect(eventsAtStart).toBe(1);
    expect(seen[0]).toMatchObject({ type: 'subscribed', subscriptionId: sub.id });
    expect(sub.isActive).toBe(true);
  });

  test('hands out unique subscription ids', () => {
    const t = () => subscribeToOrderEvents({ transport: manualTransport().transport, onEvent: () => {} });
    expect(t().id).not.toBe(t().id);
  });

  test('first snapshot yields a snapshot event plus one status event per order', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    subscribeToOrderEvents({ transport: m.transport, onEvent: (e) => seen.push(e) });

    m.emitter.snapshot([order('a', 'pending'), order('b', 'completed')]);

    expect(typesOf(seen)).toEqual(['subscribed', 'snapshot', 'status', 'status']);

    // Snapshot goes out first so a consumer resynchronising wholesale has the
    // full picture before the per-order deltas arrive.
    const snapshot = seen[1];
    expect(snapshot.type === 'snapshot' && snapshot.orders).toHaveLength(2);

    const first = seen[2];
    expect(first.type === 'status' && first.order.previousStatus).toBeNull();
  });

  test('a transport that throws on start is reported, not propagated', () => {
    const seen: OrderEvent[] = [];
    const transport: OrderEventTransport = {
      start() {
        throw new Error('socket refused');
      },
    };

    const sub = subscribeToOrderEvents({ transport, onEvent: (e) => seen.push(e) });

    expect(typesOf(seen)).toEqual(['subscribed', 'error', 'unsubscribed']);
    expect(sub.isActive).toBe(false);
  });
});

// ── Incremental status updates ───────────────────────────────────────────────

describe('subscribeToOrderEvents — incremental status updates', () => {
  test('threads previousStatus through a full swap progression', () => {
    const statuses: Array<[string | null, string]> = [];
    const m = manualTransport();

    subscribeToOrderEvents({
      transport: m.transport,
      onEvent: (event) => {
        if (event.type === 'status') statuses.push([event.order.previousStatus, event.order.status]);
      },
    });

    m.emitter.update(order('a', 'pending'));
    m.emitter.update(order('a', 'confirmed'));
    m.emitter.update(order('a', 'completed'));

    expect(statuses).toEqual([
      [null, 'pending'],
      ['pending', 'confirmed'],
      ['confirmed', 'completed'],
    ]);
  });

  test('suppresses repeats so a quiet poll does not re-render the list', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    subscribeToOrderEvents({ transport: m.transport, onEvent: (e) => seen.push(e) });

    m.emitter.update(order('a', 'pending'));
    m.emitter.update(order('a', 'pending'));
    m.emitter.update(order('a', 'pending'));

    expect(seen.filter((e) => e.type === 'status')).toHaveLength(1);
  });

  test('diffs across sources, so a poll confirming a live push emits nothing', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    subscribeToOrderEvents({ transport: m.transport, onEvent: (e) => seen.push(e) });

    // Bridge form pushes the transition the instant it happens...
    m.emitter.update(order('a', 'completed', { source: 'local' }));
    // ...and the next poll reports the same thing 15 seconds later.
    m.emitter.snapshot([order('a', 'completed', { source: 'poll' })]);

    expect(seen.filter((e) => e.type === 'status')).toHaveLength(1);
  });

  test('tracks orders independently', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    subscribeToOrderEvents({ transport: m.transport, onEvent: (e) => seen.push(e) });

    m.emitter.snapshot([order('a', 'pending'), order('b', 'pending')]);
    m.emitter.snapshot([order('a', 'completed'), order('b', 'pending')]);

    const changed = seen.filter((e): e is Extract<OrderEvent, { type: 'status' }> => e.type === 'status');
    expect(changed).toHaveLength(3); // a + b first sight, then a only
    expect(changed[2].order).toMatchObject({ orderId: 'a', previousStatus: 'pending', status: 'completed' });
  });

  test('normalises coordinator vocabulary into the canonical progression', () => {
    const statuses: string[] = [];
    const m = manualTransport();

    subscribeToOrderEvents({
      transport: m.transport,
      onEvent: (event) => {
        if (event.type === 'status') statuses.push(event.order.status);
      },
    });

    // `src_locked` and `announced` both mean pending, so the UI sees one
    // transition rather than two identical ones.
    m.emitter.update(order('a', 'announced'));
    m.emitter.update(order('a', 'src_locked'));
    m.emitter.update(order('a', 'dst_locked'));

    expect(statuses).toEqual(['pending', 'confirmed']);
  });
});

// ── Teardown ─────────────────────────────────────────────────────────────────

describe('subscribeToOrderEvents — teardown', () => {
  test('emits `unsubscribed` last and runs the transport teardown', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    const sub = subscribeToOrderEvents({ transport: m.transport, onEvent: (e) => seen.push(e) });

    sub.unsubscribe();

    expect(m.teardown).toHaveBeenCalledTimes(1);
    expect(sub.isActive).toBe(false);
    expect(seen.at(-1)).toMatchObject({ type: 'unsubscribed', reason: 'manual', subscriptionId: sub.id });
  });

  test('is idempotent — repeated unsubscribes tear down and announce once', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    const sub = subscribeToOrderEvents({ transport: m.transport, onEvent: (e) => seen.push(e) });

    sub.unsubscribe();
    sub.unsubscribe();
    sub.unsubscribe();

    expect(m.teardown).toHaveBeenCalledTimes(1);
    expect(seen.filter((e) => e.type === 'unsubscribed')).toHaveLength(1);
  });

  test('drops observations that arrive after teardown', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    const sub = subscribeToOrderEvents({ transport: m.transport, onEvent: (e) => seen.push(e) });

    sub.unsubscribe();
    const afterUnsubscribe = seen.length;

    // An in-flight request completing after unmount must not resurrect the
    // subscription or push state into a dead consumer.
    m.emitter.update(order('a', 'completed'));
    m.emitter.snapshot([order('b', 'pending')]);
    m.emitter.fail(new Error('late failure'));

    expect(seen).toHaveLength(afterUnsubscribe);
  });

  test('stops on settlement when asked', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    const sub = subscribeToOrderEvents({
      transport: m.transport,
      onEvent: (e) => seen.push(e),
      stopWhenAllSettled: true,
    });

    m.emitter.update(order('a', 'pending'));
    expect(sub.isActive).toBe(true);

    m.emitter.update(order('a', 'completed'));

    expect(sub.isActive).toBe(false);
    expect(m.teardown).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toMatchObject({ type: 'unsubscribed', reason: 'settled' });
  });

  test('keeps watching after settlement by default', () => {
    const m = manualTransport();
    const sub = subscribeToOrderEvents({ transport: m.transport, onEvent: () => {} });

    m.emitter.update(order('a', 'completed'));

    // A history view outlives any single order.
    expect(sub.isActive).toBe(true);
  });

  test('a throwing handler cannot leak the transport', () => {
    const m = manualTransport();
    const sub = subscribeToOrderEvents({
      transport: m.transport,
      onEvent: () => {
        throw new Error('consumer blew up');
      },
    });

    expect(() => m.emitter.update(order('a', 'pending'))).not.toThrow();
    expect(() => sub.unsubscribe()).not.toThrow();
    expect(m.teardown).toHaveBeenCalledTimes(1);
  });

  test('a throwing transport teardown still closes the subscription', () => {
    const seen: OrderEvent[] = [];
    const transport: OrderEventTransport = {
      start() {
        return () => {
          throw new Error('cleanup failed');
        };
      },
    };

    const sub = subscribeToOrderEvents({ transport, onEvent: (e) => seen.push(e) });

    expect(() => sub.unsubscribe()).not.toThrow();
    expect(sub.isActive).toBe(false);
    expect(seen.at(-1)).toMatchObject({ type: 'unsubscribed' });
  });
});

// ── Failure semantics ────────────────────────────────────────────────────────

describe('subscribeToOrderEvents — failure semantics', () => {
  test('counts consecutive failures and resets on any success', () => {
    const failures: number[] = [];
    const m = manualTransport();

    subscribeToOrderEvents({
      transport: m.transport,
      onEvent: (event) => {
        if (event.type === 'error') failures.push(event.consecutiveFailures);
      },
      maxConsecutiveFailures: 0,
    });

    m.emitter.fail(new Error('503'));
    m.emitter.fail(new Error('503'));
    m.emitter.snapshot([order('a', 'pending')]);
    m.emitter.fail(new Error('503'));

    expect(failures).toEqual([1, 2, 1]);
  });

  test('gives up after maxConsecutiveFailures', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    const sub = subscribeToOrderEvents({
      transport: m.transport,
      onEvent: (e) => seen.push(e),
      maxConsecutiveFailures: 2,
    });

    m.emitter.fail(new Error('down'));
    expect(sub.isActive).toBe(true);

    m.emitter.fail(new Error('still down'));

    expect(sub.isActive).toBe(false);
    expect(m.teardown).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toMatchObject({ type: 'unsubscribed', reason: 'exhausted' });
  });

  test('maxConsecutiveFailures: 0 retries forever', () => {
    const m = manualTransport();
    const sub = subscribeToOrderEvents({
      transport: m.transport,
      onEvent: () => {},
      maxConsecutiveFailures: 0,
    });

    for (let i = 0; i < 50; i++) m.emitter.fail(new Error('down'));

    expect(sub.isActive).toBe(true);
  });

  test('a stream error is not an order failure', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    subscribeToOrderEvents({ transport: m.transport, onEvent: (e) => seen.push(e), maxConsecutiveFailures: 0 });

    m.emitter.update(order('a', 'pending'));
    m.emitter.fail(new Error('coordinator offline'));

    // No status event: the order is fine, our view of it is not.
    expect(seen.filter((e) => e.type === 'status')).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({ type: 'error' });
  });

  test('passes an already-normalised error through unchanged', () => {
    const seen: OrderEvent[] = [];
    const m = manualTransport();
    subscribeToOrderEvents({ transport: m.transport, onEvent: (e) => seen.push(e), maxConsecutiveFailures: 0 });

    m.emitter.fail({ code: 'http', message: 'Coordinator returned 503', retryable: true });

    const event = seen.at(-1);
    expect(event?.type === 'error' && event.error).toEqual({
      code: 'http',
      message: 'Coordinator returned 503',
      retryable: true,
    });
  });
});

// ── Channel transport ────────────────────────────────────────────────────────

describe('createOrderEventChannel', () => {
  test('fans a publish out to every subscriber', () => {
    const channel = createOrderEventChannel();
    const a: OrderEvent[] = [];
    const b: OrderEvent[] = [];

    subscribeToOrderEvents({ transport: channel.transport, onEvent: (e) => a.push(e) });
    subscribeToOrderEvents({ transport: channel.transport, onEvent: (e) => b.push(e) });

    expect(channel.subscriberCount).toBe(2);

    channel.publish(order('a', 'completed'));

    expect(a.filter((e) => e.type === 'status')).toHaveLength(1);
    expect(b.filter((e) => e.type === 'status')).toHaveLength(1);
  });

  test('unsubscribing detaches from the channel', () => {
    const channel = createOrderEventChannel();
    const seen: OrderEvent[] = [];
    const sub = subscribeToOrderEvents({ transport: channel.transport, onEvent: (e) => seen.push(e) });

    sub.unsubscribe();
    expect(channel.subscriberCount).toBe(0);

    channel.publish(order('a', 'completed'));
    expect(seen.filter((e) => e.type === 'status')).toHaveLength(0);
  });

  test('drops publishes made while nobody is listening', () => {
    const channel = createOrderEventChannel();
    channel.publish(order('a', 'completed'));

    const seen: OrderEvent[] = [];
    subscribeToOrderEvents({ transport: channel.transport, onEvent: (e) => seen.push(e) });

    // No replay by design — producers persist to localStorage, so a consumer
    // mounting later picks the state up from its first poll instead of being
    // handed a transition it has already moved past.
    expect(seen.filter((e) => e.type === 'status')).toHaveLength(0);
  });

  test('survives a subscriber unsubscribing from inside its own handler', () => {
    const channel = createOrderEventChannel();
    const survivor: OrderEvent[] = [];

    const first = subscribeToOrderEvents({
      transport: channel.transport,
      onEvent: (event) => {
        if (event.type === 'status') first.unsubscribe();
      },
    });
    subscribeToOrderEvents({ transport: channel.transport, onEvent: (e) => survivor.push(e) });

    expect(() => channel.publish(order('a', 'completed'))).not.toThrow();
    expect(survivor.filter((e) => e.type === 'status')).toHaveLength(1);
  });

  test('publishLocalOrderStatus routes through the contract and never throws', () => {
    const channel = createOrderEventChannel();
    const seen: OrderEvent[] = [];
    subscribeToOrderEvents({ transport: channel.transport, onEvent: (e) => seen.push(e) });

    publishLocalOrderStatus('wf_1', 'src_locked', { channel, srcTxHash: '0xabc' });

    const event = seen.at(-1);
    expect(event?.type === 'status' && event.order).toMatchObject({
      orderId: 'wf_1',
      status: 'pending',
      source: 'local',
      srcTxHash: '0xabc',
    });

    // Notification is always incidental to the caller's real work.
    const exploding = { publish: () => { throw new Error('nope'); } } as never;
    expect(() => publishLocalOrderStatus('wf_2', 'failed', { channel: exploding })).not.toThrow();
  });
});

// ── Polling transport ────────────────────────────────────────────────────────

describe('createPollingTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('polls immediately and then on the interval', async () => {
    const poll = vi.fn(async () => [order('a', 'pending')]);
    const seen: OrderEvent[] = [];

    subscribeToOrderEvents({
      transport: createPollingTransport({ poll, intervalMs: 1_000 }),
      onEvent: (e) => seen.push(e),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(seen.filter((e) => e.type === 'snapshot')).toHaveLength(3);
  });

  test('honours immediate: false', async () => {
    const poll = vi.fn(async () => []);
    subscribeToOrderEvents({
      transport: createPollingTransport({ poll, intervalMs: 1_000, immediate: false }),
      onEvent: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(poll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  test('reports a rejected poll as a stream error and keeps ticking', async () => {
    const poll = vi
      .fn<[], Promise<OrderEventPayload[]>>()
      .mockRejectedValueOnce(new Error('coordinator offline'))
      .mockResolvedValue([order('a', 'completed')]);
    const seen: OrderEvent[] = [];

    subscribeToOrderEvents({
      transport: createPollingTransport({ poll, intervalMs: 1_000 }),
      onEvent: (e) => seen.push(e),
      maxConsecutiveFailures: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toMatchObject({ type: 'error', consecutiveFailures: 1 });

    // A transient outage self-heals rather than ending the subscription.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen.filter((e) => e.type === 'status')).toHaveLength(1);
  });

  test('skips a tick rather than queueing when a poll is still in flight', async () => {
    let release: (value: OrderEventPayload[]) => void = () => {};
    const poll = vi.fn(() => new Promise<OrderEventPayload[]>((resolve) => { release = resolve; }));

    subscribeToOrderEvents({
      transport: createPollingTransport({ poll, intervalMs: 100 }),
      onEvent: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    // Five timer fires while the first request hangs — a slow coordinator must
    // not accumulate a backlog.
    await vi.advanceTimersByTimeAsync(500);
    expect(poll).toHaveBeenCalledTimes(1);

    release([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  test('teardown clears the interval', async () => {
    const poll = vi.fn(async () => []);
    const sub = subscribeToOrderEvents({
      transport: createPollingTransport({ poll, intervalMs: 100 }),
      onEvent: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    sub.unsubscribe();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  test('a poll resolving after teardown emits nothing', async () => {
    let release: (value: OrderEventPayload[]) => void = () => {};
    const poll = vi.fn(() => new Promise<OrderEventPayload[]>((resolve) => { release = resolve; }));
    const seen: OrderEvent[] = [];

    const sub = subscribeToOrderEvents({
      transport: createPollingTransport({ poll, intervalMs: 100 }),
      onEvent: (e) => seen.push(e),
    });

    await vi.advanceTimersByTimeAsync(0);
    sub.unsubscribe();
    const afterUnsubscribe = seen.length;

    release([order('a', 'completed')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toHaveLength(afterUnsubscribe);
  });
});

// ── Merged transports ────────────────────────────────────────────────────────

describe('mergeTransports', () => {
  test('delivers poll and live updates as one stream in one schema', async () => {
    vi.useFakeTimers();
    try {
      const channel = createOrderEventChannel();
      const poll = vi.fn(async () => [order('a', 'pending', { source: 'poll' })]);
      const seen: OrderEvent[] = [];

      subscribeToOrderEvents({
        transport: mergeTransports(
          createPollingTransport({ poll, intervalMs: 10_000 }),
          channel.transport,
        ),
        onEvent: (e) => seen.push(e),
      });

      await vi.advanceTimersByTimeAsync(0);
      channel.publish(order('a', 'completed', { source: 'local' }));

      const statuses = seen.filter((e): e is Extract<OrderEvent, { type: 'status' }> => e.type === 'status');

      // Same event type, same payload shape — the consumer cannot tell which
      // source produced which, which is exactly the point.
      expect(statuses.map((e) => e.order.status)).toEqual(['pending', 'completed']);
      expect(statuses.map((e) => e.order.source)).toEqual(['poll', 'local']);
      expect(statuses[1].order.previousStatus).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  test('tears every merged transport down', () => {
    const a = manualTransport();
    const b = manualTransport();

    const sub = subscribeToOrderEvents({
      transport: mergeTransports(a.transport, b.transport),
      onEvent: () => {},
    });
    sub.unsubscribe();

    expect(a.teardown).toHaveBeenCalledTimes(1);
    expect(b.teardown).toHaveBeenCalledTimes(1);
  });

  test('one transport failing to start does not stop the others', () => {
    const healthy = manualTransport();
    const broken: OrderEventTransport = {
      start() {
        throw new Error('no socket');
      },
    };
    const seen: OrderEvent[] = [];

    subscribeToOrderEvents({
      transport: mergeTransports(broken, healthy.transport),
      onEvent: (e) => seen.push(e),
      maxConsecutiveFailures: 0,
    });

    expect(seen.some((e) => e.type === 'error')).toBe(true);

    healthy.emitter.update(order('a', 'completed'));
    expect(seen.filter((e) => e.type === 'status')).toHaveLength(1);
  });

  test('a throwing teardown does not strand the remaining transports', () => {
    const healthy = manualTransport();
    const broken: OrderEventTransport = {
      start() {
        return () => {
          throw new Error('cleanup failed');
        };
      },
    };

    const sub = subscribeToOrderEvents({
      transport: mergeTransports(broken, healthy.transport),
      onEvent: () => {},
    });

    expect(() => sub.unsubscribe()).not.toThrow();
    expect(healthy.teardown).toHaveBeenCalledTimes(1);
  });
});
