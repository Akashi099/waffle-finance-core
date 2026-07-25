import type { Logger } from "pino";
import {
  OrdersRepository,
  type OrderRow,
  type OrderHistoryResult,
  type AnnounceOrderInput,
  type Chain,
  type OrderStatus
} from "../persistence/orders-repo.js";
import { canTransition } from "../state-machine/order-machine.js";
import {
  ordersTotal,
  orderLifecycleTransitions,
  orderStateDuration,
  orderCurrentState,
  resolverLockActionsTotal
} from "../metrics.js";
import { announceSchema, type AnnounceInput } from "../validation/announce.js";
import { HistoryCache } from "./history-cache.js";

// Re-exported so existing importers (routes, services barrel) keep working
// while the schema itself now lives in the shared validation module.
export { announceSchema };
export type { AnnounceInput };

export class OrderValidationError extends Error {}

/* ── Observability helpers ───────────────────────────────────────────────── */

/**
 * Record lifecycle transition metrics for an order moving from one state
 * to another.  Updates:
 *  - `orderLifecycleTransitions` counter (direction, from, to)
 *  - `orderStateDuration` histogram for the time spent in the previous state
 *  - `orderCurrentState` gauge (+1 for the new state, -1 for the old state)
 *  - `ordersTotal` counter (cumulative count per status)
 */
function recordTransition(
  direction: string,
  from: OrderStatus,
  to: OrderStatus,
  updatedAtSeconds: number
): void {
  // Per-transition counter.
  orderLifecycleTransitions.inc({ direction, from, to });

  // Time in previous state: updatedAt is the timestamp the NEW state is being
  // recorded, so we approximate duration using `createdAt` in the actual
  // call sites.  This is a placeholder; the call site passes the order's
  // `updatedAt` as a proxy for when the order entered `from`.
  orderStateDuration.observe({ direction, state: from }, Math.max(Date.now() / 1000 - updatedAtSeconds, 0));

  // Update instantaneous state distribution.
  orderCurrentState.dec({ direction, state: from });
  orderCurrentState.inc({ direction, state: to });
}

export class OrderService {
  private readonly historyCache: HistoryCache;

  constructor(
    private readonly repo: OrdersRepository,
    private readonly log: Logger,
    options: { enableCache?: boolean; cacheTtlMs?: number } = {}
  ) {
    // Initialize cache if enabled (default: enabled)
    if (options.enableCache !== false) {
      this.historyCache = new HistoryCache(log.child({ component: 'history-cache' }), {
        ttlMs: options.cacheTtlMs
      });
    } else {
      this.historyCache = new HistoryCache(log, { ttlMs: 0 }); // Disabled cache
    }
  }

  /**
   * Record a new order announcement. The coordinator does NOT lock any
   * funds — it simply records the intent so the order book is visible
   * to all resolvers and the user can later attach the on-chain
   * `srcOrderId` once they have locked.
   */
  async announce(input: AnnounceInput): Promise<OrderRow> {
    // Field-shape, address and direction/chain validation is enforced by
    // `announceSchema` at the route boundary; the service only owns the
    // business-level uniqueness check below.
    const existing = await this.repo.findByHashlock(input.hashlock);
    if (existing) {
      throw new OrderValidationError(
        `An order with hashlock ${input.hashlock} already exists (publicId=${existing.publicId})`
      );
    }

    const order = await this.repo.announce(input as AnnounceOrderInput);
    this.log.info(
      { publicId: order.publicId, direction: order.direction, hashlock: order.hashlock },
      "order announced"
    );

    // ── Observability ───────────────────────────────────────────────────
    // The order enters the system in the "announced" state.  Since there is
    // no previous state to decrement, we only increment the new state gauge
    // and the cumulative total counter.
    ordersTotal.inc({ status: "announced", direction: order.direction });
    orderLifecycleTransitions.inc({ direction: order.direction, from: "none", to: "announced" });
    orderCurrentState.inc({ direction: order.direction, state: "announced" });
    
    // Invalidate cache for both source and destination addresses
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);
    
    return order;
  }

  get(publicId: string): Promise<OrderRow | null> {
    return this.repo.findByPublicId(publicId);
  }

  history(address: string, limit?: number, offset?: number): Promise<OrderRow[]> {
    return this.repo.findByAddress(address, limit, offset);
  }

  /**
   * Get order history for an address using cursor-based pagination.
   * More efficient and consistent than offset pagination for large datasets.
   */
  async historyWithCursor(address: string, limit = 50, cursor?: string): Promise<OrderHistoryResult> {
    // Check cache first
    const cached = this.historyCache.get(address, limit, cursor);
    if (cached) {
      this.log.debug({ address, limit, cursor: cursor || 'first' }, "Cache hit for history request");
      return cached;
    }

    // Cache miss - fetch from database
    this.log.debug({ address, limit, cursor: cursor || 'first' }, "Cache miss for history request");
    const result = await this.repo.findByAddressWithCursor(address, limit, cursor);
    
    // Cache the result
    this.historyCache.set(address, limit, cursor, result);
    
    return result;
  }

  findByHashlock(hashlock: string): Promise<OrderRow | null> {
    return this.repo.findByHashlock(hashlock);
  }

  findBySrcOrderId(chain: Chain, orderId: string): Promise<OrderRow | null> {
    return this.repo.findBySrcOrderId(chain, orderId);
  }

  async recordSrcLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
  }): Promise<void> {
    const order = await this.repo.findByPublicId(input.publicId);
    if (!order) throw new OrderValidationError(`unknown order ${input.publicId}`);

    // Idempotency check
    if (order.srcOrderId === input.orderId && order.srcLockTx === input.txHash) {
      this.log.info({ publicId: input.publicId, srcOrderId: input.orderId }, "duplicate src lock ignored");
      return;
    }

    if (!canTransition(order.status, "src_locked") && order.status !== "src_locked") {
      throw new OrderValidationError(`cannot record src lock from status ${order.status}`);
    }
    await this.repo.recordSrcLock(input);
    this.log.info({ publicId: input.publicId, srcOrderId: input.orderId }, "src lock recorded");

    // ── Observability ───────────────────────────────────────────────────
    recordTransition(order.direction, order.status, "src_locked", order.updatedAt);
    ordersTotal.inc({ status: "src_locked", direction: order.direction });
    
    // Invalidate cache for both addresses since order status changed
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);
  }

  async recordDstLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
    resolver: string | null;
  }): Promise<void> {
    const order = await this.repo.findByPublicId(input.publicId);
    if (!order) throw new OrderValidationError(`unknown order ${input.publicId}`);

    // Idempotency check
    if (order.dstOrderId === input.orderId && order.dstLockTx === input.txHash) {
      this.log.info({ publicId: input.publicId, dstOrderId: input.orderId }, "duplicate dst lock ignored");
      return;
    }

    if (!canTransition(order.status, "dst_locked") && order.status !== "dst_locked") {
      throw new OrderValidationError(`cannot record dst lock from status ${order.status}`);
    }
    await this.repo.recordDstLock(input);
    this.log.info({ publicId: input.publicId, dstOrderId: input.orderId, resolver: input.resolver }, "dst lock recorded");

    // ── Observability ───────────────────────────────────────────────────
    recordTransition(order.direction, order.status, "dst_locked", order.updatedAt);
    ordersTotal.inc({ status: "dst_locked", direction: order.direction });
    
    // Invalidate cache for both addresses since order status changed
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);

    if (input.resolver) {
      resolverLockActionsTotal.inc({ resolver_address: input.resolver, action: "dst_lock" });
    }
  }

  async recordSecret(publicId: string, preimage: string, txHash: string, encVersion: number | null = null): Promise<void> {
    const order = await this.repo.findByPublicId(publicId);
    if (!order) throw new OrderValidationError(`unknown order ${publicId}`);

    // Idempotency check
    if (order.preimage === preimage && order.secretRevealedTx === txHash) {
      this.log.info({ publicId }, "duplicate secret ignored");
      return;
    }

    if (!canTransition(order.status, "secret_revealed") && order.status !== "secret_revealed") {
      throw new OrderValidationError(`cannot record secret from status ${order.status}`);
    }
    await this.repo.recordSecretRevealed({ publicId, preimage, txHash, encVersion });
    this.log.info({ publicId }, "secret recorded");

    // ── Observability ───────────────────────────────────────────────────
    recordTransition(order.direction, order.status, "secret_revealed", order.updatedAt);
    ordersTotal.inc({ status: "secret_revealed", direction: order.direction });
    
    // Invalidate cache for both addresses since order status changed
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);
  }

  async markStatus(publicId: string, status: OrderRow["status"]): Promise<void> {
    const order = await this.repo.findByPublicId(publicId);
    if (!order) throw new OrderValidationError(`unknown order ${publicId}`);

    // Idempotency check
    if (order.status === status) {
      this.log.info({ publicId, status }, "duplicate status update ignored");
      return;
    }

    if (!canTransition(order.status, status)) {
      throw new OrderValidationError(`cannot transition from ${order.status} to ${status}`);
    }
    await this.repo.setStatus(publicId, status);
    this.log.info({ publicId, status }, "status updated");

    // ── Observability ───────────────────────────────────────────────────
    recordTransition(order.direction, order.status, status, order.updatedAt);
    ordersTotal.inc({ status, direction: order.direction });
    
    // Invalidate cache for both addresses since order status changed
    this.historyCache.invalidateAddress(order.srcAddress);
    this.historyCache.invalidateAddress(order.dstAddress);
  }

  async rollbackSrcLock(publicId: string): Promise<void> {
    await this.repo.rollbackSrcLock(publicId);
    this.log.warn({ publicId }, "rolled back src lock");
  }

  async rollbackDstLock(publicId: string): Promise<void> {
    await this.repo.rollbackDstLock(publicId);
    this.log.warn({ publicId }, "rolled back dst lock");
  }

  async getLastProcessedBlock(chain: Chain): Promise<number> {
    return this.repo.getLastProcessedBlock(chain);
  }

  findOrdersMissingSecret(): Promise<
    { publicId: string; srcOrderId: string | null; hashlock: string; status: string }[]
  > {
    return this.repo.findOrdersMissingSecret();
  }

  /**
   * Scan for orders whose timelock has passed and mark them `expired`.
   *
   * `expired` is a soft, non-terminal state: the order can still be
   * refunded or fail afterwards.  The scan deliberately skips terminal
   * orders (completed / refunded / failed) — see `findExpiredCandidates`.
   *
   * Returns the number of orders that were successfully transitioned.
   */
  async expireStaleOrders(nowSeconds?: number): Promise<number> {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const candidates = await this.repo.findExpiredCandidates(now);
    let count = 0;
    for (const order of candidates) {
      try {
        await this.markStatus(order.publicId, "expired");
        this.log.info({ publicId: order.publicId }, "order marked expired by timelock");
        count++;
      } catch (err: any) {
        this.log.warn(
          { publicId: order.publicId, err: err?.message },
          "cannot expire order — skipping"
        );
      }
    }
    return count;
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats() {
    return this.historyCache.getStats();
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.historyCache.destroy();
  }
}
