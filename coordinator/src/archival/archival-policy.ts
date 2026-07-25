/**
 * ArchivalPolicy — explicit stale-order archival lifecycle contract.
 *
 * ## What "archival" means
 *
 * Archival is a **soft-delete** (`archived_at` timestamp stamped, status
 * unchanged).  The order row is kept in the database so on-chain recovery
 * can reactivate it at any time.  Archived orders are excluded from normal
 * coordinator operations (reconciler, expiry scan, stale-cleanup) unless
 * explicitly reactivated.
 *
 * ## When is an order archival-worthy?
 *
 * An order is eligible for archival when ALL of the following hold:
 *
 *  1. Status is `announced` (it was never locked on-chain).
 *  2. `src_order_id` is NULL (no source-chain lock was ever observed).
 *  3. `archived_at` is NULL (not already archived).
 *  4. `created_at` is older than `retentionWindowSeconds`.
 *
 * Orders in any other status (`src_locked`, `dst_locked`, `secret_revealed`,
 * `completed`, `refunded`, `failed`, `expired`) are NEVER eligible — funds
 * may still be at risk on-chain and the coordinator must keep tracking them.
 *
 * ## Idempotency
 *
 * `archiveOrder()` in the repository uses a `WHERE archived_at IS NULL`
 * guard, so calling archival twice on the same order is a safe no-op.
 *
 * ## Reactivation (safe recovery path)
 *
 * If an archived order is later found on-chain (e.g. a very delayed lock
 * event surfaces during reconciliation), `reactivateOrder()` clears
 * `archived_at` so the coordinator resumes normal tracking.  The reactivation
 * path is intentionally conservative: it only acts on `announced` orders that
 * have been archived — orders with non-announced status were never archived by
 * this policy.
 *
 * ## Observability
 *
 * All archival and reactivation events emit structured log lines and are
 * counted in Prometheus metrics so operators can audit why each order was
 * archived.
 */

import type { Logger } from "pino";
import type { OrdersRepository } from "../persistence/orders-repo.js";
import {
  archivalRuns,
  archivalOrdersArchived,
  archivalOrdersReactivated,
  archivalLastRun,
  archivalErrors,
} from "./archival-metrics.js";

// ── ArchivalReason ────────────────────────────────────────────────────────────

/**
 * Machine-readable reason code recorded in the log when an order is archived.
 *
 * Having an explicit reason makes it easy to filter logs and understand the
 * coordinator's cleanup decisions without relying on free-text search.
 */
export type ArchivalReason =
  /** No on-chain lock event arrived within the retention window. */
  | "no_lock_within_retention_window";

/**
 * Machine-readable reason code recorded in the log when an order is
 * reactivated.
 */
export type ReactivationReason =
  /** An on-chain lock event was discovered for a previously-archived order. */
  | "on_chain_lock_discovered";

// ── ArchivalResult ─────────────────────────────────────────────────────────────

export interface ArchivalResult {
  /** Orders archived in this run. */
  archivedCount: number;
  /** Reason applied to every order archived in this run. */
  reason: ArchivalReason;
}

// ── ReactivationResult ────────────────────────────────────────────────────────

export interface ReactivationResult {
  /** `true` if the order was reactivated; `false` if it was not archived. */
  reactivated: boolean;
  reason?: ReactivationReason;
}

// ── ArchivalPolicy ────────────────────────────────────────────────────────────

export class ArchivalPolicy {
  private readonly retentionWindowSeconds: number;

  /**
   * @param repo             - Orders repository.
   * @param log              - Pino logger instance.
   * @param retentionDays    - Number of days an `announced` order with no
   *                           source lock can sit before it becomes
   *                           archival-worthy.  Default: 30.
   * @param batchSize        - Maximum orders to archive per `runArchival()`
   *                           call.  Keeps single runs bounded in duration.
   *                           Default: 100.
   */
  constructor(
    private readonly repo: OrdersRepository,
    private readonly log: Logger,
    retentionDays = 30,
    private readonly batchSize = 100
  ) {
    this.retentionWindowSeconds = retentionDays * 24 * 60 * 60;
  }

  // ── Archival ───────────────────────────────────────────────────────────────

  /**
   * Find and archive announced orders that have exceeded the retention window
   * without receiving an on-chain lock.
   *
   * The operation is **idempotent**: re-running after a partial failure will
   * simply archive the remaining eligible orders.
   *
   * @returns Summary of what was archived in this run.
   */
  async runArchival(): Promise<ArchivalResult> {
    const reason: ArchivalReason = "no_lock_within_retention_window";

    try {
      const candidates = await this.repo.findStaleAnnounced(this.retentionWindowSeconds);
      const batch = candidates.slice(0, this.batchSize);

      for (const order of batch) {
        await this.repo.archiveOrder(order.publicId);
        this.log.info(
          {
            publicId: order.publicId,
            reason,
            createdAt: order.createdAt,
            retentionWindowSeconds: this.retentionWindowSeconds,
          },
          "ArchivalPolicy: order archived"
        );
      }

      const archivedCount = batch.length;

      archivalRuns.inc({ result: "success" });
      archivalOrdersArchived.inc(archivedCount);
      archivalLastRun.set(Math.floor(Date.now() / 1000));

      if (archivedCount > 0) {
        this.log.info(
          {
            archivedCount,
            retentionWindowSeconds: this.retentionWindowSeconds,
            reason,
          },
          "ArchivalPolicy: archival run complete"
        );
      }

      return { archivedCount, reason };
    } catch (err) {
      archivalRuns.inc({ result: "failure" });
      archivalErrors.inc();
      this.log.error({ err }, "ArchivalPolicy: archival run failed");
      throw err;
    }
  }

  // ── Reactivation ──────────────────────────────────────────────────────────

  /**
   * Reactivate an archived order so the coordinator resumes tracking it.
   *
   * This is the safe recovery path for archived orders that are later found
   * to have an on-chain lock (e.g. a very delayed reconciler event).
   *
   * **Preconditions checked before reactivation:**
   *  - The order must exist.
   *  - The order must currently be archived (`archived_at IS NOT NULL`).
   *  - The order status must still be `announced` — orders that were archived
   *    but have since been transitioned by the reconciler are already "live"
   *    and need no reactivation.
   *
   * @param publicId  - The order's public identifier.
   * @param reason    - Why the order is being reactivated (logged and counted).
   * @returns         - `{ reactivated: true }` when the order was reactivated,
   *                   `{ reactivated: false }` when nothing needed to change.
   */
  async reactivateOrder(
    publicId: string,
    reason: ReactivationReason = "on_chain_lock_discovered"
  ): Promise<ReactivationResult> {
    const order = await this.repo.findByPublicId(publicId);

    if (!order) {
      this.log.warn({ publicId }, "ArchivalPolicy: reactivation skipped — order not found");
      return { reactivated: false };
    }

    // If the order is not archived, nothing to do.
    if (order.archivedAt === null) {
      return { reactivated: false };
    }

    // Only reactivate orders that are still in `announced` status.  If the
    // reconciler or a live event has already advanced the order (e.g. to
    // `src_locked`), that status was written while `archived_at` was set,
    // meaning the archival guard in `archiveOrder()` was already cleared.
    // In that case the order is already being tracked — no action needed.
    if (order.status !== "announced") {
      this.log.info(
        { publicId, status: order.status, reason },
        "ArchivalPolicy: reactivation skipped — order already advanced past announced"
      );
      return { reactivated: false };
    }

    await this.repo.unarchiveOrder(publicId);

    archivalOrdersReactivated.inc();
    this.log.info(
      {
        publicId,
        reason,
        archivedAt: order.archivedAt,
      },
      "ArchivalPolicy: order reactivated"
    );

    return { reactivated: true, reason };
  }

  // ── Status check ──────────────────────────────────────────────────────────

  /**
   * Return `true` if the given order meets the archival eligibility criteria.
   *
   * This is a pure decision function — it does not write to the database.
   * Useful for testing the policy without side effects.
   */
  isArchivalWorthy(order: {
    status: string;
    srcOrderId: string | null;
    archivedAt: number | null;
    createdAt: number;
  }): boolean {
    const cutoff = Math.floor(Date.now() / 1000) - this.retentionWindowSeconds;
    return (
      order.status === "announced" &&
      order.srcOrderId === null &&
      order.archivedAt === null &&
      order.createdAt < cutoff
    );
  }
}
