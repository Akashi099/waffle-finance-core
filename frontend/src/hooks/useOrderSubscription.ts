/**
 * React binding for the order-event subscription contract.
 *
 * Owns one subscription for the lifetime of the calling component and folds the
 * event stream into render-ready state. Subscribing directly from a component
 * is possible but easy to get wrong — the failure modes this hook exists to
 * close are: resubscribing on every render because the callback identity
 * changed, and leaving a poll timer running after unmount.
 *
 * Quiet-stream behaviour
 * ──────────────────────
 * `orders` is only ever added to or updated, never cleared. If the stream
 * errors, goes quiet, or ends, the last known state stays on screen and
 * `error` / `phase` carry the bad news separately. A user watching a swap
 * should not see their order vanish because a poll returned 503 — the order is
 * fine, our view of it is not, and those are different things the UI can show
 * differently.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  subscribeToOrderEvents,
  type OrderEventTransport,
  type OrderSubscription,
} from '../lib/orderEventStream';
import type {
  OrderEvent,
  OrderEventError,
  OrderEventPayload,
  OrderUnsubscribeReason,
} from '../lib/orderEvents';

/** Lifecycle of the underlying subscription. */
export type OrderSubscriptionPhase =
  /** No transport supplied — nothing is being watched. */
  | 'idle'
  /** Subscribed and receiving. */
  | 'active'
  /** Ended, by unmount, `unsubscribe()`, settlement, or exhaustion. */
  | 'closed';

export interface UseOrderSubscriptionOptions {
  /**
   * The stream to watch. Must be referentially stable across renders — wrap it
   * in `useMemo` — or the subscription tears down and reopens each render.
   * Pass `null` to watch nothing (phase stays `'idle'`); useful for gating on a
   * connected wallet without breaking the rules of hooks.
   */
  transport: OrderEventTransport | null;
  /**
   * Optional side-effect hook for every event, called before state updates.
   * Its identity may change freely between renders without resubscribing.
   */
  onEvent?: (event: OrderEvent) => void;
  /** See `OrderSubscriptionOptions.maxConsecutiveFailures`. */
  maxConsecutiveFailures?: number;
  /** See `OrderSubscriptionOptions.stopWhenAllSettled`. */
  stopWhenAllSettled?: boolean;
}

export interface UseOrderSubscriptionResult {
  /** Last known state of every order seen, keyed by `orderId`. */
  orders: Record<string, OrderEventPayload>;
  /** The same orders, most recently updated first. */
  orderList: OrderEventPayload[];
  /** The most recent event, for consumers that want the raw stream. */
  lastEvent: OrderEvent | null;
  phase: OrderSubscriptionPhase;
  /**
   * Most recent stream failure, cleared on the next successful observation.
   * Never reflects an *order* that failed — read `orders[id].error` for that.
   */
  error: OrderEventError | null;
  /** Consecutive stream failures; 0 while healthy. */
  consecutiveFailures: number;
  /** Why the subscription closed, or null while it is open. */
  closedReason: OrderUnsubscribeReason | null;
  /** Close early. Idempotent; unmount does this automatically. */
  unsubscribe: () => void;
}

interface SubscriptionState {
  orders: Record<string, OrderEventPayload>;
  lastEvent: OrderEvent | null;
  phase: OrderSubscriptionPhase;
  error: OrderEventError | null;
  consecutiveFailures: number;
  closedReason: OrderUnsubscribeReason | null;
}

const INITIAL_STATE: SubscriptionState = {
  orders: {},
  lastEvent: null,
  phase: 'idle',
  error: null,
  consecutiveFailures: 0,
  closedReason: null,
};

/** Fold one event into state. Pure, so it is trivially testable in isolation. */
function reduce(state: SubscriptionState, event: OrderEvent): SubscriptionState {
  switch (event.type) {
    case 'subscribed':
      // Deliberately preserves `orders`: resubscribing (a wallet switch, a
      // remount) should not blank a list we already have good data for.
      return { ...state, lastEvent: event, phase: 'active', closedReason: null };

    case 'snapshot': {
      const orders = { ...state.orders };
      for (const order of event.orders) orders[order.orderId] = order;
      return { ...state, orders, lastEvent: event, error: null, consecutiveFailures: 0 };
    }

    case 'status':
      return {
        ...state,
        orders: { ...state.orders, [event.order.orderId]: event.order },
        lastEvent: event,
        error: null,
        consecutiveFailures: 0,
      };

    case 'error':
      // `orders` untouched — see the module header on quiet-stream behaviour.
      return {
        ...state,
        lastEvent: event,
        error: event.error,
        consecutiveFailures: event.consecutiveFailures,
      };

    case 'unsubscribed':
      return { ...state, lastEvent: event, phase: 'closed', closedReason: event.reason };
  }
}

export function useOrderSubscription({
  transport,
  onEvent,
  maxConsecutiveFailures,
  stopWhenAllSettled,
}: UseOrderSubscriptionOptions): UseOrderSubscriptionResult {
  const [state, setState] = useState<SubscriptionState>(INITIAL_STATE);
  const subscriptionRef = useRef<OrderSubscription | null>(null);

  // Held in a ref so a caller passing an inline arrow does not force a
  // resubscribe on every render.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!transport) {
      subscriptionRef.current = null;
      return;
    }

    const subscription = subscribeToOrderEvents({
      transport,
      maxConsecutiveFailures,
      stopWhenAllSettled,
      onEvent: (event) => {
        onEventRef.current?.(event);
        setState((previous) => reduce(previous, event));
      },
    });

    subscriptionRef.current = subscription;

    return () => {
      subscriptionRef.current = null;
      // Idempotent, so React 18 StrictMode's double-invoked effect is harmless.
      subscription.unsubscribe('manual');
    };
  }, [transport, maxConsecutiveFailures, stopWhenAllSettled]);

  const unsubscribe = useCallback(() => {
    subscriptionRef.current?.unsubscribe('manual');
  }, []);

  const orderList = useMemo(
    () => Object.values(state.orders).sort((a, b) => b.at - a.at),
    [state.orders]
  );

  return {
    orders: state.orders,
    orderList,
    lastEvent: state.lastEvent,
    phase: state.phase,
    error: state.error,
    consecutiveFailures: state.consecutiveFailures,
    closedReason: state.closedReason,
    unsubscribe,
  };
}
