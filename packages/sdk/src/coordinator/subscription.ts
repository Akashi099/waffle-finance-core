/**
 * Event subscription abstraction for bridge lifecycle notifications.
 *
 * The coordinator does not (yet) provide a WebSocket or SSE push channel, so
 * this module implements a polling-based subscriber that fires typed events
 * whenever an order's status changes. The event contract is stable across
 * future transport changes: if the coordinator adds a push channel the
 * subscriber implementation can be swapped under the hood without changing
 * the event types or the consumer API.
 *
 * Consumer API
 * ────────────
 * ```ts
 * const sub = new OrderSubscriber({ coordinatorClient, orderId: "wf_0x..." });
 *
 * sub.on("statusChanged", (event) => {
 *   console.log(event.from, "→", event.to);
 * });
 * sub.on("secretRevealed", (event) => {
 *   console.log("preimage:", event.preimage);
 * });
 * sub.on("error", (event) => {
 *   console.warn("poll failed:", event.error);
 * });
 *
 * sub.start();
 *
 * // Later:
 * sub.stop(); // clears the poll interval; no resource leak
 * ```
 *
 * Cleanup guarantee
 * ─────────────────
 * `stop()` always clears the interval, even if it is called multiple times or
 * before `start()`. Consumers must call `stop()` when the component/context
 * that owns the subscriber is torn down.
 */

import type { OrderStatus } from "../types/index.js";
import type { CoordinatorClient } from "./client.js";
import type { HistoryRecord } from "./history-client.js";
import { toHistoryRecord } from "./history-client.js";

// ── Event payloads ───────────────────────────────────────────────────────────

/** Fired whenever the coordinator reports a different status than last seen. */
export interface StatusChangedEvent {
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
  record: HistoryRecord;
}

/** Fired when `secret.revealed` transitions from false → true. */
export interface SecretRevealedEvent {
  orderId: string;
  /** Null for public consumers; non-null for operator-authenticated clients. */
  preimage: string | null;
  revealedTx: string | null;
  record: HistoryRecord;
}

/** Fired when the order reaches a terminal state (completed/refunded/failed). */
export interface OrderSettledEvent {
  orderId: string;
  finalStatus: OrderStatus;
  record: HistoryRecord;
}

/**
 * Fired when a poll returns an unexpected error (network failure, 5xx, parse
 * failure). The subscriber continues polling after an error event unless
 * `stopOnError` is set. Consumers should use this for logging/alerting.
 */
export interface SubscriptionErrorEvent {
  orderId: string;
  error: Error;
  /** Number of consecutive poll failures so far. Resets on success. */
  consecutiveFailures: number;
}

/** Fired when polling is about to start. */
export interface SubscriptionStartedEvent {
  orderId: string;
}

/** Fired when polling has stopped (either via stop() or a terminal status). */
export interface SubscriptionStoppedEvent {
  orderId: string;
  reason: "manual" | "terminal" | "max_errors";
}

// ── Event map ────────────────────────────────────────────────────────────────

export interface OrderSubscriptionEvents {
  statusChanged: StatusChangedEvent;
  secretRevealed: SecretRevealedEvent;
  settled: OrderSettledEvent;
  error: SubscriptionErrorEvent;
  started: SubscriptionStartedEvent;
  stopped: SubscriptionStoppedEvent;
}

export type OrderSubscriptionEventName = keyof OrderSubscriptionEvents;

// ── Terminal statuses ────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set<OrderStatus>(["completed", "refunded", "failed"]);

function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface OrderSubscriberOptions {
  /** Coordinator client to poll with. */
  coordinatorClient: CoordinatorClient;
  /** Public order ID to watch. */
  orderId: string;
  /**
   * Poll interval in milliseconds. Default: 5 000 (5 s).
   * Lower values increase coordinator load; higher values increase latency.
   */
  pollIntervalMs?: number;
  /**
   * Stop polling automatically once a terminal status is reached.
   * Default: true.
   */
  stopOnTerminal?: boolean;
  /**
   * Maximum number of consecutive poll errors before stopping automatically.
   * Default: 5. Set to 0 to disable.
   */
  maxConsecutiveErrors?: number;
}

// ── Subscriber ───────────────────────────────────────────────────────────────

type AnyHandler = (event: OrderSubscriptionEvents[OrderSubscriptionEventName]) => void;

/**
 * Polls the coordinator for a single order's state and fires typed events
 * on each meaningful change.
 *
 * The subscriber is intentionally single-order. To watch multiple orders,
 * create one subscriber per order or use a higher-level manager.
 */
export class OrderSubscriber {
  private readonly coordinator: CoordinatorClient;
  private readonly orderId: string;
  private readonly pollIntervalMs: number;
  private readonly stopOnTerminal: boolean;
  private readonly maxConsecutiveErrors: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: OrderStatus | null = null;
  private lastSecretRevealed = false;
  private consecutiveErrors = 0;
  private running = false;

  private readonly handlers = new Map<string, Set<AnyHandler>>();

  constructor(options: OrderSubscriberOptions) {
    this.coordinator = options.coordinatorClient;
    this.orderId = options.orderId;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.stopOnTerminal = options.stopOnTerminal ?? true;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? 5;
  }

  // ── Event registration ─────────────────────────────────────────────────

  /**
   * Register a handler for a lifecycle event.
   * Returns `this` so registrations can be chained.
   */
  on<K extends OrderSubscriptionEventName>(
    event: K,
    handler: (payload: OrderSubscriptionEvents[K]) => void
  ): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as AnyHandler);
    return this;
  }

  /**
   * Remove a previously registered handler.
   * Returns `this` for chaining.
   */
  off<K extends OrderSubscriptionEventName>(
    event: K,
    handler: (payload: OrderSubscriptionEvents[K]) => void
  ): this {
    this.handlers.get(event)?.delete(handler as AnyHandler);
    return this;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start polling. Safe to call multiple times — subsequent calls are no-ops
   * if already running.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Fire an immediate poll so the consumer gets the current state without
    // waiting one full interval.
    void this.poll();

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);

    // Allow Node.js to exit naturally if this is the only active handle.
    if (this.timer && typeof (this.timer as NodeJS.Timeout).unref === "function") {
      (this.timer as NodeJS.Timeout).unref();
    }

    this.emit("started", { orderId: this.orderId });
  }

  /**
   * Stop polling and release resources. Safe to call multiple times and
   * before `start()`.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.running = false;
      this.emit("stopped", { orderId: this.orderId, reason: "manual" });
    }
  }

  /** True while the subscriber is actively polling. */
  get isRunning(): boolean {
    return this.running;
  }

  // ── Internal poll ──────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    let raw;
    try {
      raw = await this.coordinator.getOrder(this.orderId);
    } catch (err) {
      this.consecutiveErrors++;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", {
        orderId: this.orderId,
        error,
        consecutiveFailures: this.consecutiveErrors,
      });

      if (this.maxConsecutiveErrors > 0 && this.consecutiveErrors >= this.maxConsecutiveErrors) {
        this.stopDueToReason("max_errors");
      }
      return;
    }

    // Successful poll — reset error counter
    this.consecutiveErrors = 0;

    // 404: order doesn't exist (yet or has been purged).
    // Fire an error event but keep polling so the consumer can decide.
    if (raw === null) {
      this.emit("error", {
        orderId: this.orderId,
        error: new Error(`Order ${this.orderId} not found`),
        consecutiveFailures: 0,
      });
      return;
    }

    const record = toHistoryRecord(raw);
    const { status } = record;

    // Status changed
    if (this.lastStatus !== null && this.lastStatus !== status) {
      this.emit("statusChanged", {
        orderId: this.orderId,
        from: this.lastStatus,
        to: status,
        record,
      });

      if (isTerminal(status)) {
        this.emit("settled", { orderId: this.orderId, finalStatus: status, record });
        if (this.stopOnTerminal) {
          this.lastStatus = status;
          this.stopDueToReason("terminal");
          return;
        }
      }
    }

    // Secret revealed transition
    if (!this.lastSecretRevealed && record.secret.revealed) {
      this.emit("secretRevealed", {
        orderId: this.orderId,
        preimage: record.secret.preimage,
        revealedTx: record.secret.revealedTx,
        record,
      });
    }

    this.lastStatus = status;
    this.lastSecretRevealed = record.secret.revealed;
  }

  private stopDueToReason(reason: "terminal" | "max_errors"): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.emit("stopped", { orderId: this.orderId, reason });
  }

  private emit<K extends OrderSubscriptionEventName>(
    event: K,
    payload: OrderSubscriptionEvents[K]
  ): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch {
        // Swallow handler errors so one bad handler can't break the others.
      }
    }
  }
}
