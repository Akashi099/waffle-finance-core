/**
 * HistoryClient — typed, normalised transaction history for a wallet address.
 *
 * Wraps the coordinator's GET /api/orders/history endpoint and produces a
 * stable `HistoryRecord` shape that the frontend can consume without knowing
 * the raw coordinator wire format. Transformation and pagination are handled
 * here so the UI layer stays thin.
 *
 * Stable contract guarantees
 * ──────────────────────────
 * • `HistoryRecord.status` is always an `OrderStatus` from the SDK type union.
 * • `HistoryRecord.direction` is always a `CoordinatorDirection` string.
 * • Optional fields (lockTx, timelock, resolver, …) are explicitly typed as
 *   `string | null` / `number | null` so callers never see `undefined`.
 * • Partial records (e.g. announced orders with no lock yet) are valid and
 *   their nullable fields are null rather than omitted.
 *
 * Frontend cache contract
 * ───────────────────────
 * `HistoryRecord` is intentionally serialisable (no Date objects, no bigint)
 * so it can be round-tripped through JSON.stringify/localStorage without data
 * loss. The `fetchedAt` timestamp on `HistoryPage` lets the consumer implement
 * stale-while-revalidate caching at the call site.
 */

import type { OrderStatus } from "../types/index.js";
import type { CoordinatorDirection, CoordinatorOrder } from "./contract.js";
import { isCursorPagination } from "./contract.js";
import type { CoordinatorClient, GetHistoryOptions } from "./client.js";

// ── Normalised record ────────────────────────────────────────────────────────

/**
 * A single normalised order record suitable for UI rendering and local cache.
 *
 * All nullable fields are explicitly `string | null` or `number | null` so
 * consumers never have to guard against `undefined`. The raw coordinator
 * fields `lockBlock` and `preimage_enc_version` are dropped — they are
 * coordinator-internal and have no meaning on the client side.
 */
export interface HistoryRecord {
  /** Canonical public order ID: `wf_0x<64-hex>`. */
  id: string;
  direction: CoordinatorDirection;
  status: OrderStatus;
  hashlock: string;

  src: {
    chain: string;
    address: string;
    asset: string;
    /** Atomic units, decimal string. */
    amount: string;
    /** Atomic units, decimal string. Null on destination leg. */
    safetyDeposit: string | null;
    /** On-chain order ID. Null until locked. */
    orderId: string | null;
    /** Lock transaction hash. Null until locked. */
    lockTx: string | null;
    /** Absolute timelock unix seconds. Null until locked. */
    timelock: number | null;
  };

  dst: {
    chain: string;
    address: string;
    asset: string;
    amount: string;
    orderId: string | null;
    lockTx: string | null;
    timelock: number | null;
  };

  secret: {
    /** True once preimage has been revealed on either chain. */
    revealed: boolean;
    /** Null for public consumers; non-null only for operator-authenticated calls. */
    preimage: string | null;
    /** Transaction hash of the reveal. Null until revealed. */
    revealedTx: string | null;
  };

  /** Resolver ETH address if a resolver filled the dst leg. Null otherwise. */
  resolver: string | null;
  /** Unix seconds when the order was announced. */
  createdAt: number;
  /** Unix seconds of the most recent update. */
  updatedAt: number;
}

/** Pagination metadata included with every page result. */
export interface HistoryPagination {
  limit: number;
  count: number;
  /** Opaque cursor for the next page. Null when this is the last page. */
  nextCursor: string | null;
  /** Legacy offset for backward compatibility. Present only on offset-based responses. */
  offset?: number;
}

/** A single page of history results. */
export interface HistoryPage {
  records: HistoryRecord[];
  pagination: HistoryPagination;
  /**
   * Unix millisecond timestamp when this page was fetched.
   * Use this for stale-while-revalidate cache decisions.
   */
  fetchedAt: number;
}

// ── Transform ────────────────────────────────────────────────────────────────

/**
 * Normalise a raw `CoordinatorOrder` into a stable `HistoryRecord`.
 * Defensively handles partial/null fields that can appear on newly
 * announced orders or orders that were partially indexed.
 */
export function toHistoryRecord(wire: CoordinatorOrder): HistoryRecord {
  return {
    id: wire.id,
    direction: wire.direction,
    status: wire.status,
    hashlock: wire.hashlock,

    src: {
      chain: wire.src.chain,
      address: wire.src.address,
      asset: wire.src.asset,
      amount: wire.src.amount,
      safetyDeposit: wire.src.safetyDeposit ?? null,
      orderId: wire.src.orderId ?? null,
      lockTx: wire.src.lockTx ?? null,
      timelock: wire.src.timelock ?? null,
    },

    dst: {
      chain: wire.dst.chain,
      address: wire.dst.address,
      asset: wire.dst.asset,
      amount: wire.dst.amount,
      orderId: wire.dst.orderId ?? null,
      lockTx: wire.dst.lockTx ?? null,
      timelock: wire.dst.timelock ?? null,
    },

    secret: {
      revealed: wire.secret.revealed,
      preimage: wire.secret.preimage ?? null,
      revealedTx: wire.secret.revealedTx ?? null,
    },

    resolver: wire.resolver ?? null,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface HistoryClientOptions {
  /** Underlying coordinator client to delegate HTTP calls to. */
  coordinatorClient: CoordinatorClient;
}

/**
 * HistoryClient provides a stable, typed interface for fetching and paginating
 * order history. It is the recommended way for the frontend to read history
 * data; it handles normalisation and pagination so the UI never touches raw
 * coordinator wire shapes.
 */
export class HistoryClient {
  private readonly coordinator: CoordinatorClient;

  constructor(options: HistoryClientOptions) {
    this.coordinator = options.coordinatorClient;
  }

  /**
   * Fetch one page of history records for a wallet address.
   *
   * Pass `cursor` from a previous `HistoryPage.pagination.nextCursor` to
   * advance to the next page. Omit for the first page.
   *
   * @example
   * const page = await historyClient.getPage({ address: "0x..." });
   * console.log(page.records); // HistoryRecord[]
   * if (page.pagination.nextCursor) {
   *   const nextPage = await historyClient.getPage({
   *     address: "0x...",
   *     cursor: page.pagination.nextCursor,
   *   });
   * }
   */
  async getPage(options: GetHistoryOptions): Promise<HistoryPage> {
    const raw = await this.coordinator.getHistory(options);

    const records = raw.transactions.map(toHistoryRecord);

    let pagination: HistoryPagination;
    if (isCursorPagination(raw.pagination)) {
      pagination = {
        limit: raw.pagination.limit,
        count: raw.pagination.count,
        nextCursor: raw.pagination.nextCursor,
      };
    } else {
      pagination = {
        limit: raw.pagination.limit,
        count: raw.pagination.count,
        nextCursor: null,
        offset: raw.pagination.offset,
      };
    }

    return { records, pagination, fetchedAt: Date.now() };
  }

  /**
   * Fetch ALL history records for an address by walking cursor pages.
   *
   * Use with caution on addresses with large history. Prefer `getPage` for
   * incremental UI loading.
   *
   * @param options.limit  Per-page limit (default 50).
   */
  async getAll(options: Omit<GetHistoryOptions, "cursor" | "offset">): Promise<HistoryRecord[]> {
    const records: HistoryRecord[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.getPage({ ...options, cursor });
      records.push(...page.records);
      cursor = page.pagination.nextCursor ?? undefined;
    } while (cursor);

    return records;
  }

  /**
   * Fetch a single order as a `HistoryRecord`. Returns null if the order
   * does not exist.
   */
  async getRecord(publicId: string): Promise<HistoryRecord | null> {
    const raw = await this.coordinator.getOrder(publicId);
    return raw ? toHistoryRecord(raw) : null;
  }
}
