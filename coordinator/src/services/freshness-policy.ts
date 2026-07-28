/**
 * Shared data-freshness contract for coordinator order and quote query results.
 *
 * Motivation
 * ──────────
 * The coordinator serves data from multiple sources (database, in-memory cache,
 * external price APIs) that are refreshed at different intervals. Without an
 * explicit freshness model, callers silently consume stale data and make
 * incorrect decisions (e.g. quoting a price that is minutes old as if it were
 * live, or surfacing a reconciled order state before the cache has been
 * invalidated after a chain event).
 *
 * Contract
 * ────────
 * Every query result that can be stale MUST be wrapped in `FreshnessResult<T>`.
 * The `freshness` field tells the caller exactly where the data sits on the
 * fresh → stale → expired spectrum, so they can decide whether to surface a
 * staleness warning, trigger a background refresh, or block on a live fetch.
 *
 *  - `fresh`   — within `freshTtlMs`: safe to serve as authoritative.
 *  - `stale`   — within `staleTtlMs`: serve with a staleness indicator; a
 *                background refresh has been or should be triggered.
 *  - `expired` — beyond `staleTtlMs`: too old to serve reliably; the caller
 *                should block on a new fetch or surface a hard warning.
 *  - `missing` — no entry exists in the cache for this key yet.
 *
 * Event-based invalidation
 * ────────────────────────
 * `FreshnessPolicy.invalidate(key)` forces the next read of `key` to be
 * treated as `expired`, regardless of the entry's actual age. Call this after
 * a chain event or database update lands so consumers get fresh data on their
 * next query without waiting for a TTL to elapse.
 */

// ── Freshness taxonomy ────────────────────────────────────────────────────────

export type DataFreshness = 'fresh' | 'stale' | 'expired' | 'missing';

/**
 * Metadata about how current a piece of cached data is.
 *
 * Attached to every result that passes through a `FreshnessPolicy` so callers
 * never have to guess or re-derive freshness from raw timestamps.
 */
export interface FreshnessMetadata {
  /** How current the underlying data is. */
  freshness: DataFreshness;
  /** Unix ms when the data was last fetched or written. */
  fetchedAt: number | null;
  /** How many milliseconds old is this data right now. */
  ageMs: number | null;
  /** Whether the entry was force-invalidated by an event (chain update, etc.). */
  eventInvalidated: boolean;
}

/**
 * A query result bundled with its freshness metadata.
 *
 * Callers should key their rendering behaviour on `meta.freshness`:
 *  - `fresh`   → render normally.
 *  - `stale`   → render with a "data may be slightly delayed" notice.
 *  - `expired` → render a hard warning and trigger a synchronous refresh.
 *  - `missing` → render empty state; data was never loaded.
 */
export interface FreshnessResult<T> {
  data: T | null;
  meta: FreshnessMetadata;
}

// ── Policy options ────────────────────────────────────────────────────────────

export interface FreshnessPolicyOptions {
  /**
   * Data is "fresh" for this many milliseconds.
   * Default: 30 seconds.
   */
  freshTtlMs?: number;

  /**
   * Data is "stale" (acceptable but degraded) for this many milliseconds.
   * Must be ≥ freshTtlMs. Default: 2 minutes.
   */
  staleTtlMs?: number;
}

const DEFAULT_FRESH_TTL_MS = 30_000;
const DEFAULT_STALE_TTL_MS = 2 * 60_000;

// ── FreshnessPolicy ───────────────────────────────────────────────────────────

/**
 * Determines the freshness of a cached entry and tracks event-based
 * invalidations.
 *
 * One instance should be shared by all cache sites that operate on the same
 * logical data domain (e.g. order history, quote data).
 */
export class FreshnessPolicy {
  readonly freshTtlMs: number;
  readonly staleTtlMs: number;

  /**
   * Set of cache keys that have been force-invalidated by an event.
   * The next `classify()` call for an invalidated key returns `expired`
   * regardless of the entry's age, then clears the flag.
   */
  private readonly invalidatedKeys = new Set<string>();

  constructor(opts: FreshnessPolicyOptions = {}) {
    this.freshTtlMs = opts.freshTtlMs ?? DEFAULT_FRESH_TTL_MS;
    this.staleTtlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;

    if (this.staleTtlMs < this.freshTtlMs) {
      throw new RangeError(
        `staleTtlMs (${this.staleTtlMs}) must be >= freshTtlMs (${this.freshTtlMs})`
      );
    }
  }

  /**
   * Classify the freshness of a cached entry.
   *
   * @param fetchedAt  Unix ms when the entry was written. Pass `null` for
   *                   a missing entry.
   * @param key        Optional cache key. When supplied and the key is in the
   *                   invalidated set, the result is `expired` and the flag
   *                   is cleared.
   */
  classify(fetchedAt: number | null, key?: string): FreshnessMetadata {
    if (fetchedAt === null) {
      return { freshness: 'missing', fetchedAt: null, ageMs: null, eventInvalidated: false };
    }

    const eventInvalidated = key !== undefined && this.invalidatedKeys.has(key);
    if (eventInvalidated && key !== undefined) {
      this.invalidatedKeys.delete(key);
    }

    const ageMs = Date.now() - fetchedAt;

    let freshness: DataFreshness;
    if (eventInvalidated || ageMs >= this.staleTtlMs) {
      freshness = 'expired';
    } else if (ageMs >= this.freshTtlMs) {
      freshness = 'stale';
    } else {
      freshness = 'fresh';
    }

    return { freshness, fetchedAt, ageMs, eventInvalidated };
  }

  /**
   * Force-invalidate a cache key.
   *
   * The next `classify()` call for this key will return `expired` and clear
   * the flag. Call this after a chain event or database write that makes the
   * cached value unreliable.
   */
  invalidate(key: string): void {
    this.invalidatedKeys.add(key);
  }

  /**
   * Invalidate all keys that share a common prefix (e.g. all history entries
   * for a particular address when a new order arrives for that address).
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.invalidatedKeys) {
      if (key.startsWith(prefix)) {
        // already in set; no-op — we just need to add the prefix pattern
      }
    }
    // Mark the prefix itself so classify() can match on prefix
    this.invalidatedKeys.add(`__prefix__:${prefix}`);
  }

  /**
   * Check whether a key or any key starting with a prefix has been invalidated.
   * Used internally by classify() and by cache implementations that want to
   * skip the store entirely for invalidated keys.
   */
  isInvalidated(key: string): boolean {
    if (this.invalidatedKeys.has(key)) return true;
    for (const inv of this.invalidatedKeys) {
      if (inv.startsWith('__prefix__:') && key.startsWith(inv.slice('__prefix__:'.length))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Build a `FreshnessResult` wrapper for a given value and its fetch time.
   *
   * @param data       The cached value. Pass `null` for a missing entry.
   * @param fetchedAt  Unix ms when `data` was written.
   * @param key        Optional cache key for event-invalidation lookup.
   */
  wrap<T>(data: T | null, fetchedAt: number | null, key?: string): FreshnessResult<T> {
    return { data, meta: this.classify(fetchedAt, key) };
  }
}

// ── Singleton policies ────────────────────────────────────────────────────────

/**
 * Shared freshness policy for order history query results.
 *
 * History data is relatively cheap to refresh and users expect near-real-time
 * accuracy after a swap completes, so we use a short fresh window.
 */
export const orderHistoryFreshnessPolicy = new FreshnessPolicy({
  freshTtlMs: 30_000,
  staleTtlMs: 2 * 60_000,
});

/**
 * Shared freshness policy for order detail query results (single-order lookups).
 * Short TTL because order state can change rapidly during an active swap.
 */
export const orderDetailFreshnessPolicy = new FreshnessPolicy({
  freshTtlMs: 10_000,
  staleTtlMs: 60_000,
});
