/**
 * Frontend ↔ coordinator subscription contract: the subscription mechanics.
 *
 * `orderEvents.ts` defines *what* an event looks like. This module defines how
 * a consumer subscribes to a stream of them, and how sources plug in.
 *
 * Layering
 * ────────
 *   transport  →  emitter  →  subscription core  →  onEvent(OrderEvent)
 *
 * A **transport** is any source of order observations: a poll timer, an in-app
 * channel, a future SSE/WebSocket connection. It receives an
 * {@link OrderObservationEmitter} and returns a teardown function.
 *
 * Transports deliberately do NOT construct `OrderEvent`s. They report raw
 * observations (`snapshot` / `update` / `fail`) and the **subscription core**
 * turns those into events. That is where status diffing, `previousStatus`
 * threading, no-op suppression, consecutive-failure counting and teardown
 * bookkeeping live — once, rather than re-implemented (and re-bugged) in every
 * transport. It is also what makes the schema guarantees in `orderEvents.ts`
 * true by construction: a transport cannot emit a malformed event because it
 * never emits events at all.
 *
 * Cleanup guarantees
 * ──────────────────
 * For any subscription, regardless of how it ends:
 *  • `subscribed` is emitted exactly once, before the transport starts.
 *  • `unsubscribed` is emitted exactly once, and is always the final event.
 *  • The transport's teardown runs exactly once, even on repeated
 *    `unsubscribe()` calls.
 *  • Observations arriving after teardown are dropped silently — a transport
 *    with an in-flight request cannot resurrect a dead subscription or push a
 *    state update into an unmounted component.
 *  • A throwing `onEvent` handler, or a throwing transport teardown, cannot
 *    prevent any of the above.
 */

import {
  createOrderEventPayload,
  isTerminalOrderStatus,
  toOrderEventError,
  type OrderEvent,
  type OrderEventError,
  type OrderEventPayload,
  type OrderEventSource,
  type OrderEventStatus,
  type OrderUnsubscribeReason,
} from './orderEvents';

// ── Transport interface ──────────────────────────────────────────────────────

/**
 * What a transport is handed. Every method is safe to call at any time; calls
 * made after the subscription ends are ignored rather than throwing, so a
 * transport never needs to track liveness itself.
 */
export interface OrderObservationEmitter {
  /**
   * Report the complete current state of every order this source knows about.
   *
   * Use for pull-style sources, where each read yields the whole picture. The
   * core emits a `snapshot` event plus a `status` event for every order whose
   * status actually changed since the last observation.
   */
  snapshot(orders: OrderEventPayload[]): void;
  /**
   * Report the current state of a single order.
   *
   * Use for push-style sources. Emits a `status` event if the status changed;
   * emits nothing if it did not.
   */
  update(order: OrderEventPayload): void;
  /** Report a stream-level failure (see `orderEvents.ts` on error semantics). */
  fail(error: OrderEventError | unknown): void;
}

/**
 * A source of order observations.
 *
 * `start` is called once when the subscription opens and must return a teardown
 * function that releases everything it acquired (timers, sockets, listeners).
 */
export interface OrderEventTransport {
  start(emitter: OrderObservationEmitter): () => void;
}

// ── Subscription ─────────────────────────────────────────────────────────────

export interface OrderSubscriptionOptions {
  transport: OrderEventTransport;
  /**
   * Receives every event in order. Exceptions thrown here are swallowed: one
   * misbehaving consumer must not take down the stream or leak the transport.
   */
  onEvent: (event: OrderEvent) => void;
  /**
   * Consecutive `fail()` calls tolerated before the subscription gives up and
   * unsubscribes with reason `'exhausted'`. Any successful observation resets
   * the counter. Default 5; set to 0 to retry forever.
   */
  maxConsecutiveFailures?: number;
  /**
   * Unsubscribe with reason `'settled'` once every order the stream has seen
   * has reached a terminal status. Default false, because a history view keeps
   * watching for new orders; a single-order view should set it true.
   */
  stopWhenAllSettled?: boolean;
}

export interface OrderSubscription {
  /** Stable id, echoed in `subscribed` / `unsubscribed` events. */
  readonly id: string;
  /** False once the subscription has ended, by any route. */
  readonly isActive: boolean;
  /** Idempotent. Safe to call from a React cleanup that may run twice. */
  unsubscribe(reason?: OrderUnsubscribeReason): void;
}

let subscriptionCounter = 0;

/**
 * Open a subscription over `transport`.
 *
 * @example
 * const sub = subscribeToOrderEvents({
 *   transport: orderEventChannel.transport,
 *   onEvent: (event) => {
 *     if (event.type === 'status') applyStatus(event.order);
 *   },
 * });
 * // later — always, including on unmount:
 * sub.unsubscribe();
 */
export function subscribeToOrderEvents({
  transport,
  onEvent,
  maxConsecutiveFailures = 5,
  stopWhenAllSettled = false,
}: OrderSubscriptionOptions): OrderSubscription {
  const id = `sub_${++subscriptionCounter}`;

  /** Last status seen per order, the basis for every `previousStatus` value. */
  const lastStatus = new Map<string, OrderEventStatus>();
  let consecutiveFailures = 0;
  let active = true;
  let teardown: (() => void) | null = null;
  let teardownRun = false;

  // A handler that throws must not break the stream. It also must not prevent
  // teardown: an exception escaping here during the `unsubscribed` emit would
  // otherwise skip the cleanup that follows it.
  const emit = (event: OrderEvent): void => {
    try {
      onEvent(event);
    } catch {
      // Intentionally swallowed — see above.
    }
  };

  /**
   * Fold one observed payload into the tracked state.
   * Returns the event to emit, or null when the status did not change.
   */
  const reconcile = (order: OrderEventPayload): OrderEvent | null => {
    const previous = lastStatus.get(order.orderId) ?? null;
    lastStatus.set(order.orderId, order.status);

    // Suppress no-op transitions. A 5-second poll on a swap that sits in
    // `pending` for two minutes would otherwise emit 24 identical events and
    // re-render the history list every tick.
    if (previous === order.status) return null;

    return {
      type: 'status',
      at: order.at,
      order: { ...order, previousStatus: previous },
    };
  };

  const allSettled = (): boolean =>
    lastStatus.size > 0 && Array.from(lastStatus.values()).every(isTerminalOrderStatus);

  const emitter: OrderObservationEmitter = {
    snapshot(orders) {
      if (!active) return;
      consecutiveFailures = 0;

      // The snapshot goes out first so a consumer that resynchronises wholesale
      // has the full picture before the per-order deltas arrive.
      emit({ type: 'snapshot', at: Date.now(), source: sourceOf(orders), orders });

      for (const order of orders) {
        const event = reconcile(order);
        if (event) emit(event);
      }

      if (stopWhenAllSettled && allSettled()) finish('settled');
    },

    update(order) {
      if (!active) return;
      consecutiveFailures = 0;

      const event = reconcile(order);
      if (event) emit(event);

      if (stopWhenAllSettled && allSettled()) finish('settled');
    },

    fail(cause) {
      if (!active) return;
      consecutiveFailures++;

      const error = isOrderEventError(cause) ? cause : toOrderEventError(cause, 'unknown');
      emit({ type: 'error', at: Date.now(), error, consecutiveFailures });

      if (maxConsecutiveFailures > 0 && consecutiveFailures >= maxConsecutiveFailures) {
        finish('exhausted');
      }
    },
  };

  /** The single exit path. Idempotent by the `active` guard. */
  function finish(reason: OrderUnsubscribeReason): void {
    if (!active) return;
    active = false;

    emit({ type: 'unsubscribed', at: Date.now(), subscriptionId: id, reason });

    if (!teardownRun) {
      teardownRun = true;
      try {
        teardown?.();
      } catch {
        // A transport that throws on cleanup has already been released as far
        // as we are concerned; there is nothing further we can do about it.
      }
    }
  }

  emit({ type: 'subscribed', at: Date.now(), subscriptionId: id });

  // Started after `subscribed` so a transport that emits synchronously (a
  // cache-backed one, say) cannot produce events before the acknowledgement.
  try {
    teardown = transport.start(emitter);
  } catch (err) {
    // A transport that cannot start is a stream failure, not a crash for the
    // caller. Report it through the normal channel and close cleanly.
    emitter.fail(toOrderEventError(err, 'network'));
    finish('exhausted');
  }

  return {
    id,
    get isActive() {
      return active;
    },
    unsubscribe(reason: OrderUnsubscribeReason = 'manual') {
      finish(reason);
    },
  };
}

function isOrderEventError(value: unknown): value is OrderEventError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as OrderEventError).code === 'string' &&
    typeof (value as OrderEventError).message === 'string' &&
    typeof (value as OrderEventError).retryable === 'boolean'
  );
}

/** Provenance for a snapshot: the sources agree in practice; first wins. */
function sourceOf(orders: OrderEventPayload[]): OrderEventSource {
  return orders[0]?.source ?? 'poll';
}

// ── Transport: in-app channel (the "live" source) ────────────────────────────

/**
 * A process-local publish/subscribe hub.
 *
 * This is the live event source the contract talks about. The coordinator has
 * no push channel yet, but the bridge form *is* a real-time source of truth for
 * the swap it is currently driving: it knows the moment a receipt confirms or a
 * cross-chain step fails, minutes before the next history poll would notice.
 * Publishing those transitions here lets the history view update immediately
 * through exactly the same event schema a future SSE feed will use.
 *
 * No replay: an event published while nobody is subscribed is dropped. That is
 * intentional — producers also persist to localStorage, so a consumer mounting
 * later still picks the state up from its first poll. Buffering here would mean
 * replaying stale transitions into a view that has already moved past them.
 */
export interface OrderEventChannel {
  /** Push one order's current state to every active subscriber. */
  publish(order: OrderEventPayload): void;
  /** Push a full set of orders to every active subscriber. */
  publishAll(orders: OrderEventPayload[]): void;
  /** Push a stream-level failure to every active subscriber. */
  fail(error: OrderEventError | unknown): void;
  /** Number of active subscribers. Exposed for tests and debugging. */
  readonly subscriberCount: number;
  /** Plug into `subscribeToOrderEvents({ transport })`. */
  readonly transport: OrderEventTransport;
}

export function createOrderEventChannel(): OrderEventChannel {
  const emitters = new Set<OrderObservationEmitter>();

  // Iterate a copy: a subscriber that unsubscribes from inside its own handler
  // would otherwise mutate the set mid-iteration.
  const each = (fn: (emitter: OrderObservationEmitter) => void) => {
    for (const emitter of Array.from(emitters)) fn(emitter);
  };

  return {
    publish(order) {
      each((emitter) => emitter.update(order));
    },
    publishAll(orders) {
      each((emitter) => emitter.snapshot(orders));
    },
    fail(error) {
      each((emitter) => emitter.fail(error));
    },
    get subscriberCount() {
      return emitters.size;
    },
    transport: {
      start(emitter) {
        emitters.add(emitter);
        return () => {
          emitters.delete(emitter);
        };
      },
    },
  };
}

/**
 * The app-wide channel.
 *
 * A module singleton rather than a React context because the producer (the
 * bridge form's imperative swap driver, which runs outside React's render
 * cycle) and the consumer (the history cache hook) sit in unrelated parts of
 * the tree, and threading a context between them would buy nothing.
 */
export const orderEventChannel: OrderEventChannel = createOrderEventChannel();

// ── Transport: polling ───────────────────────────────────────────────────────

export interface PollingTransportOptions {
  /**
   * Read current order state. Rejections become `error` events; the poller
   * keeps ticking so a transient outage self-heals.
   */
  poll: () => Promise<OrderEventPayload[]>;
  /** Milliseconds between ticks. Default 15 000. */
  intervalMs?: number;
  /** Run one poll immediately on subscribe rather than waiting a full interval. Default true. */
  immediate?: boolean;
}

/**
 * Turn a periodic fetch into a transport.
 *
 * Overlapping ticks are suppressed: if a poll is still in flight when the timer
 * fires, that tick is skipped rather than queued, so a slow coordinator cannot
 * accumulate a backlog of requests.
 */
export function createPollingTransport({
  poll,
  intervalMs = 15_000,
  immediate = true,
}: PollingTransportOptions): OrderEventTransport {
  return {
    start(emitter) {
      let stopped = false;
      let inFlight = false;

      const tick = async () => {
        if (stopped || inFlight) return;
        inFlight = true;
        try {
          const orders = await poll();
          // Re-check: the subscription may have ended while the request was
          // open. The emitter would drop this anyway, but returning early keeps
          // the intent explicit.
          if (!stopped) emitter.snapshot(orders);
        } catch (err) {
          if (!stopped) emitter.fail(toOrderEventError(err, 'network'));
        } finally {
          inFlight = false;
        }
      };

      const timer = window.setInterval(() => void tick(), intervalMs);
      if (immediate) void tick();

      return () => {
        stopped = true;
        window.clearInterval(timer);
      };
    },
  };
}

// ── Transport: composition ───────────────────────────────────────────────────

/**
 * Run several transports under one subscription.
 *
 * This is what delivers the acceptance criterion directly: a consumer merging
 * the poll transport with the live channel receives one event stream in one
 * schema, and cannot tell — or need to care — which source produced any given
 * update. Status diffing happens in the subscription core across the merged
 * stream, so a live push followed by a poll reporting the same status emits one
 * event, not two.
 *
 * A transport that throws on start is reported through the emitter and skipped;
 * the remaining transports still run. Teardown of every started transport runs
 * even if an earlier teardown throws.
 */
export function mergeTransports(...transports: OrderEventTransport[]): OrderEventTransport {
  return {
    start(emitter) {
      const teardowns: Array<() => void> = [];

      for (const transport of transports) {
        try {
          teardowns.push(transport.start(emitter));
        } catch (err) {
          emitter.fail(toOrderEventError(err, 'network'));
        }
      }

      return () => {
        for (const teardown of teardowns) {
          try {
            teardown();
          } catch {
            // Keep going: one bad transport must not strand the others.
          }
        }
      };
    },
  };
}

// ── Producer helper ──────────────────────────────────────────────────────────

/**
 * Publish a local status transition to the app-wide channel.
 *
 * The convenience entry point for imperative producers such as the bridge
 * form's swap driver, which knows an order id and a new status and should not
 * have to assemble a payload by hand.
 *
 * Never throws: publishing a status update is always incidental to the work the
 * caller is really doing (sending a transaction, writing history), and must not
 * be able to fail it.
 */
export function publishLocalOrderStatus(
  orderId: string,
  status: unknown,
  options: {
    source?: OrderEventSource;
    srcTxHash?: string | null;
    dstTxHash?: string | null;
    error?: OrderEventError | null;
    details?: Record<string, unknown>;
    channel?: OrderEventChannel;
  } = {}
): void {
  const { channel = orderEventChannel, source = 'local', ...rest } = options;

  try {
    channel.publish(createOrderEventPayload({ orderId, status, source, ...rest }));
  } catch {
    // Best effort by design — see above.
  }
}
