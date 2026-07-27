// @vitest-environment jsdom

/**
 * React-binding tests for the subscription contract.
 *
 * Covers the three scenarios the issue names — initial subscription, status
 * updates, teardown — from the component's point of view, plus the quiet-stream
 * guarantee that keeps the UI stable when the coordinator goes away.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { createOrderEventPayload, type OrderEvent } from '../lib/orderEvents';
import {
  createOrderEventChannel,
  type OrderEventTransport,
  type OrderObservationEmitter,
} from '../lib/orderEventStream';
import { useOrderSubscription } from './useOrderSubscription';

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

const order = (orderId: string, status: string, at?: number) =>
  createOrderEventPayload({ orderId, status, source: 'poll', at });

// ── Initial subscription ─────────────────────────────────────────────────────

describe('useOrderSubscription — initial subscription', () => {
  test('starts idle and goes active once subscribed', () => {
    const m = manualTransport();
    const { result } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    expect(result.current.phase).toBe('active');
    expect(result.current.orders).toEqual({});
    expect(result.current.error).toBeNull();
    expect(result.current.closedReason).toBeNull();
  });

  test('stays idle and never subscribes when no transport is supplied', () => {
    const { result } = renderHook(() => useOrderSubscription({ transport: null }));

    // Lets a caller gate on a connected wallet without breaking hook rules.
    expect(result.current.phase).toBe('idle');
    expect(result.current.orderList).toEqual([]);
  });

  test('populates orders from the first snapshot', () => {
    const m = manualTransport();
    const { result } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    act(() => {
      m.emitter.snapshot([order('a', 'pending'), order('b', 'completed')]);
    });

    expect(Object.keys(result.current.orders).sort()).toEqual(['a', 'b']);
    expect(result.current.orders.a.status).toBe('pending');
    expect(result.current.orders.b.status).toBe('completed');
  });

  test('orderList is sorted most recently updated first', () => {
    const m = manualTransport();
    const { result } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    act(() => {
      m.emitter.snapshot([order('old', 'pending', 1_000), order('new', 'pending', 5_000)]);
    });

    expect(result.current.orderList.map((o) => o.orderId)).toEqual(['new', 'old']);
  });

  test('forwards every event to an optional onEvent callback', () => {
    const onEvent = vi.fn();
    const m = manualTransport();
    renderHook(() => useOrderSubscription({ transport: m.transport, onEvent }));

    act(() => {
      m.emitter.update(order('a', 'pending'));
    });

    const types = onEvent.mock.calls.map(([event]: [OrderEvent]) => event.type);
    expect(types).toEqual(['subscribed', 'status']);
  });
});

// ── Status updates ───────────────────────────────────────────────────────────

describe('useOrderSubscription — status updates', () => {
  test('applies an incremental progression', () => {
    const m = manualTransport();
    const { result } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    act(() => m.emitter.update(order('a', 'pending')));
    expect(result.current.orders.a.status).toBe('pending');

    act(() => m.emitter.update(order('a', 'confirmed')));
    expect(result.current.orders.a).toMatchObject({ status: 'confirmed', previousStatus: 'pending' });

    act(() => m.emitter.update(order('a', 'completed')));
    expect(result.current.orders.a).toMatchObject({ status: 'completed', previousStatus: 'confirmed' });
  });

  test('merges a live push and a poll snapshot into one order map', () => {
    const m = manualTransport();
    const { result } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    act(() => m.emitter.snapshot([order('a', 'pending'), order('b', 'pending')]));
    act(() => m.emitter.update(order('b', 'completed')));

    expect(result.current.orders.a.status).toBe('pending');
    expect(result.current.orders.b.status).toBe('completed');
  });

  test('surfaces a failed order through the order, not the stream error', () => {
    const m = manualTransport();
    const { result } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    act(() => m.emitter.update(order('a', 'failed')));

    expect(result.current.orders.a.error).toMatchObject({ code: 'order_failed', retryable: false });
    // The stream is perfectly healthy; the order is not.
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('active');
  });

  test('does not resubscribe when only the onEvent identity changes', () => {
    const m = manualTransport();
    const start = vi.spyOn(m.transport, 'start');

    const { rerender } = renderHook(
      ({ tick }: { tick: number }) =>
        useOrderSubscription({ transport: m.transport, onEvent: () => tick }),
      { initialProps: { tick: 0 } },
    );

    rerender({ tick: 1 });
    rerender({ tick: 2 });

    // An inline arrow in the caller must not churn the subscription.
    expect(start).toHaveBeenCalledTimes(1);
    expect(m.teardown).not.toHaveBeenCalled();
  });
});

// ── Quiet / failing stream ───────────────────────────────────────────────────

describe('useOrderSubscription — quiet stream', () => {
  test('keeps the last known orders when the stream errors', () => {
    const m = manualTransport();
    const { result } = renderHook(() =>
      useOrderSubscription({ transport: m.transport, maxConsecutiveFailures: 0 }),
    );

    act(() => m.emitter.update(order('a', 'confirmed')));
    act(() => m.emitter.fail(new Error('coordinator offline')));

    // The order did not vanish because a poll returned 503.
    expect(result.current.orders.a.status).toBe('confirmed');
    expect(result.current.error).toMatchObject({ message: 'coordinator offline', retryable: true });
    expect(result.current.consecutiveFailures).toBe(1);
    expect(result.current.phase).toBe('active');
  });

  test('clears the stream error once an observation lands', () => {
    const m = manualTransport();
    const { result } = renderHook(() =>
      useOrderSubscription({ transport: m.transport, maxConsecutiveFailures: 0 }),
    );

    act(() => m.emitter.fail(new Error('offline')));
    act(() => m.emitter.fail(new Error('offline')));
    expect(result.current.consecutiveFailures).toBe(2);

    act(() => m.emitter.snapshot([order('a', 'pending')]));

    expect(result.current.error).toBeNull();
    expect(result.current.consecutiveFailures).toBe(0);
  });

  test('keeps orders on screen after the subscription is exhausted', () => {
    const m = manualTransport();
    const { result } = renderHook(() =>
      useOrderSubscription({ transport: m.transport, maxConsecutiveFailures: 2 }),
    );

    act(() => m.emitter.update(order('a', 'confirmed')));
    act(() => m.emitter.fail(new Error('down')));
    act(() => m.emitter.fail(new Error('down')));

    expect(result.current.phase).toBe('closed');
    expect(result.current.closedReason).toBe('exhausted');
    expect(result.current.orders.a.status).toBe('confirmed');
  });
});

// ── Teardown ─────────────────────────────────────────────────────────────────

describe('useOrderSubscription — teardown', () => {
  test('unsubscribes on unmount', () => {
    const m = manualTransport();
    const { unmount } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    unmount();

    expect(m.teardown).toHaveBeenCalledTimes(1);
  });

  test('detaches from a channel on unmount', () => {
    const channel = createOrderEventChannel();
    const { unmount } = renderHook(() => useOrderSubscription({ transport: channel.transport }));

    expect(channel.subscriberCount).toBe(1);
    unmount();
    expect(channel.subscriberCount).toBe(0);
  });

  test('an event arriving after unmount does not update state', () => {
    const m = manualTransport();
    const { result, unmount } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    act(() => m.emitter.update(order('a', 'pending')));
    unmount();

    // No "setState on an unmounted component" — the subscription drops it.
    expect(() => act(() => m.emitter.update(order('a', 'completed')))).not.toThrow();
    expect(result.current.orders.a.status).toBe('pending');
  });

  test('explicit unsubscribe closes the stream and reports the reason', () => {
    const m = manualTransport();
    const { result } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    act(() => result.current.unsubscribe());

    expect(result.current.phase).toBe('closed');
    expect(result.current.closedReason).toBe('manual');
    expect(m.teardown).toHaveBeenCalledTimes(1);
  });

  test('unsubscribe is idempotent', () => {
    const m = manualTransport();
    const { result } = renderHook(() => useOrderSubscription({ transport: m.transport }));

    act(() => {
      result.current.unsubscribe();
      result.current.unsubscribe();
    });

    expect(m.teardown).toHaveBeenCalledTimes(1);
  });

  test('swapping the transport tears the old one down and keeps known orders', () => {
    const first = manualTransport();
    const second = manualTransport();

    const { result, rerender } = renderHook(
      ({ transport }: { transport: OrderEventTransport }) => useOrderSubscription({ transport }),
      { initialProps: { transport: first.transport } },
    );

    act(() => first.emitter.update(order('a', 'confirmed')));

    rerender({ transport: second.transport });

    expect(first.teardown).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('active');
    // A wallet switch should not blank a list we already have good data for.
    expect(result.current.orders.a.status).toBe('confirmed');

    act(() => second.emitter.update(order('b', 'pending')));
    expect(result.current.orders.b.status).toBe('pending');
  });

  test('stops on settlement when asked', () => {
    const m = manualTransport();
    const { result } = renderHook(() =>
      useOrderSubscription({ transport: m.transport, stopWhenAllSettled: true }),
    );

    act(() => m.emitter.update(order('a', 'pending')));
    expect(result.current.phase).toBe('active');

    act(() => m.emitter.update(order('a', 'completed')));

    expect(result.current.phase).toBe('closed');
    expect(result.current.closedReason).toBe('settled');
    expect(m.teardown).toHaveBeenCalledTimes(1);
  });
});
