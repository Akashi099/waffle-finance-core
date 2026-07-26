import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithRetry } from '../lib/fetchWithRetry';
import {
  createOrderEventChannel,
  mergeTransports,
  orderEventChannel,
  type OrderEventChannel,
} from '../lib/orderEventStream';
import { orderEventFromHistoryRow, type OrderEvent } from '../lib/orderEvents';
import { useOrderSubscription } from './useOrderSubscription';

export interface Transaction {
  id: string;
  txHash: string;
  fromNetwork: string;
  toNetwork: string;
  fromToken: string;
  toToken: string;
  amount: string;
  estimatedAmount: string;
  status: 'pending' | 'completed' | 'confirmed' | 'cancelled' | 'failed' | 'refunded' | 'expired' | 'timed_out';
  timestamp: number;
  ethTxHash?: string;
  stellarTxHash?: string;
  ethAddress?: string;
  stellarAddress?: string;
  direction: 'eth-to-xlm' | 'xlm-to-eth';
  onChainOrderId?: string;
  htlcContractAddress?: string;
  htlcContractMode?: 'v1-mainnet-htlc' | 'v2-escrow';
  timelockUnixSeconds?: number;
  amountWei?: string;
  refundTxHash?: string;
  refundNetwork?: 'ethereum' | 'stellar';
  refundedAt?: number;
  autoRefundFailed?: boolean;
  autoRefundError?: string;
  networkMode?: 'mainnet' | 'testnet';
}

interface HistoryCachePayload {
  fetchedAt: number;
  transactions: Transaction[];
}

interface UseTransactionHistoryCacheOptions {
  ethAddress?: string;
  stellarAddress?: string;
  apiBase: string;
  staleMs?: number;
  fetcher?: typeof fetch;
  /**
   * Live event source to merge with the poll path. Defaults to the app-wide
   * `orderEventChannel`, which is what the bridge form publishes into.
   * Overridable so tests can drive the stream without touching global state.
   *
   * Captured on first render; later changes to this option are ignored.
   */
  liveChannel?: OrderEventChannel;
}

interface RefreshOptions {
  force?: boolean;
}

const STORAGE_KEY = 'wafflefinance_transactions_v2';
const HISTORY_CACHE_PREFIX = 'wafflefinance_history_cache_v1';
const DEFAULT_STALE_MS = 60_000;
const MAX_CACHED_TRANSACTIONS = 100;

// Hash patterns that indicate fabricated/demo data, used to filter out legacy entries
// persisted by older builds. New entries can never match these because v2 only stores
// real on-chain hashes returned from the coordinator.
const KNOWN_FAKE_HASHES = new Set([
  '0x1234567890abcdef1234567890abcdef12345678',
  '0xabcdef1234567890abcdef1234567890abcdef12',
  '0x9876543210fedcba9876543210fedcba98765432',
  '0x0000000000000000000000000000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000000',
]);

function isRealHash(hash?: string): boolean {
  if (!hash) return true;
  if (KNOWN_FAKE_HASHES.has(hash)) return false;
  if (hash.startsWith('mock_')) return false;
  if (hash.startsWith('placeholder')) return false;
  if (/^0x0+$/.test(hash)) return false;
  return true;
}

function isRealTransaction(tx: Transaction): boolean {
  return isRealHash(tx.txHash) && isRealHash(tx.ethTxHash) && isRealHash(tx.stellarTxHash);
}

function normalizeAddress(address?: string): string {
  return address?.trim().toLowerCase() || '';
}

export function getTransactionHistoryCacheKey(ethAddress?: string, stellarAddress?: string): string {
  const eth = normalizeAddress(ethAddress);
  const stellar = normalizeAddress(stellarAddress);
  return `${HISTORY_CACHE_PREFIX}:${eth || '-'}:${stellar || '-'}`;
}

function parseTransactions(raw: string | null): Transaction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRealTransaction as (tx: unknown) => tx is Transaction);
  } catch (err) {
    console.warn('Could not parse stored transactions:', err);
    return [];
  }
}

function parseHistoryCache(raw: string | null): HistoryCachePayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HistoryCachePayload>;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.transactions)) {
      return null;
    }

    return {
      fetchedAt: parsed.fetchedAt,
      transactions: parsed.transactions.filter(isRealTransaction),
    };
  } catch (err) {
    console.warn('Could not parse history cache:', err);
    return null;
  }
}

function mergeTransactions(...sources: Transaction[][]): Transaction[] {
  const byId = new Map<string, Transaction>();

  for (const source of sources) {
    for (const tx of source) {
      if (isRealTransaction(tx)) {
        byId.set(tx.id, tx);
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.timestamp - a.timestamp);
}

export function useTransactionHistoryCache({
  ethAddress,
  stellarAddress,
  apiBase,
  staleMs = DEFAULT_STALE_MS,
  fetcher = fetch,
  liveChannel = orderEventChannel,
}: UseTransactionHistoryCacheOptions) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const inFlightRef = useRef(false);
  // Poll results are republished through the subscription contract rather than
  // being consumed only here, so every path that wants order updates — this
  // hook, the bridge form, anything added later — reads one event schema.
  const pollChannel = useMemo(() => createOrderEventChannel(), []);
  const walletCacheKey = useMemo(
    () => getTransactionHistoryCacheKey(ethAddress, stellarAddress),
    [ethAddress, stellarAddress],
  );

  const hasWalletAddress = Boolean(ethAddress || stellarAddress);

  const loadFromStorage = useCallback((): Transaction[] => {
    return parseTransactions(localStorage.getItem(STORAGE_KEY));
  }, []);

  const readWalletCache = useCallback((): HistoryCachePayload | null => {
    return parseHistoryCache(localStorage.getItem(walletCacheKey));
  }, [walletCacheKey]);

  const isCacheStale = useCallback(
    (fetchedAt: number | null): boolean => {
      if (!fetchedAt) return true;
      return Date.now() - fetchedAt >= staleMs;
    },
    [staleMs],
  );

  const writeWalletCache = useCallback(
    (nextTransactions: Transaction[]) => {
      const payload: HistoryCachePayload = {
        fetchedAt: Date.now(),
        transactions: nextTransactions.slice(0, MAX_CACHED_TRANSACTIONS),
      };

      localStorage.setItem(walletCacheKey, JSON.stringify(payload));
      setLastFetchedAt(payload.fetchedAt);
    },
    [walletCacheKey],
  );

  const refreshFromCoordinator = useCallback(
    async ({ force = false }: RefreshOptions = {}) => {
      const cache = readWalletCache();

      if (!hasWalletAddress) {
        const local = loadFromStorage();
        setTransactions(local);
        setLastFetchedAt(null);
        return;
      }

      if (!force && cache && !isCacheStale(cache.fetchedAt)) {
        setTransactions(cache.transactions);
        setLastFetchedAt(cache.fetchedAt);
        return;
      }

      if (inFlightRef.current) return;

      inFlightRef.current = true;
      const hasImmediateRows = Boolean(cache?.transactions.length || transactions.length);
      setIsLoading(!hasImmediateRows);
      setIsRefreshing(hasImmediateRows);

      try {
        const params = new URLSearchParams();
        if (ethAddress) params.set('eth', ethAddress);
        if (stellarAddress) params.set('stellar', stellarAddress);

        const res = await fetchWithRetry(`${apiBase}/api/orders/history?${params.toString()}`, {
          maxRetries: 2,
          retryDelayMs: 1000,
          fetcher,
        });
        if (!res.ok) throw new Error(`Coordinator returned ${res.status}`);

        const body = await res.json();
        const remote: Transaction[] = Array.isArray(body?.transactions)
          ? body.transactions.filter(isRealTransaction)
          : [];
        const merged = mergeTransactions(loadFromStorage(), remote);

        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        writeWalletCache(merged);
        setTransactions(merged);

        // Announce the poll result on the contract. The subscription core
        // diffs it against what the live channel has already reported, so a
        // status the bridge form pushed seconds ago does not re-fire here.
        pollChannel.publishAll(merged.map((tx) => orderEventFromHistoryRow(tx, 'poll')));
      } catch (err) {
        console.warn('Coordinator history unavailable, falling back to local cache:', err);
        setTransactions(cache?.transactions ?? loadFromStorage());
        setLastFetchedAt(cache?.fetchedAt ?? null);

        // Surface the outage on the stream without disturbing `transactions`:
        // the rows on screen are still the best information we have.
        pollChannel.fail(err);
      } finally {
        inFlightRef.current = false;
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [
      apiBase,
      ethAddress,
      fetcher,
      hasWalletAddress,
      isCacheStale,
      loadFromStorage,
      pollChannel,
      readWalletCache,
      stellarAddress,
      transactions.length,
      writeWalletCache,
    ],
  );

  const updateTransactions = useCallback(
    (updater: (previous: Transaction[]) => Transaction[]) => {
      setTransactions((previous) => {
        const next = updater(previous);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));

        if (hasWalletAddress) {
          writeWalletCache(next);
        }

        return next;
      });
    },
    [hasWalletAddress, writeWalletCache],
  );

  /**
   * Fold one contract event into the rendered rows.
   *
   * Only `status` events are acted on: the core has already suppressed no-op
   * transitions, so anything arriving here is a genuine change. Snapshots are
   * ignored because the poll path that produced them has already written the
   * rows, and errors are ignored because a broken stream must not disturb the
   * last known good state.
   *
   * Events for orders we have no row for are dropped rather than synthesised.
   * An event carries a status, not a renderable transaction — the producer has
   * already persisted the full row, and the next poll merges it in.
   */
  const applyOrderEvent = useCallback((event: OrderEvent) => {
    if (event.type !== 'status') return;
    const { order } = event;

    setTransactions((previous) => {
      const index = previous.findIndex((tx) => tx.id === order.orderId);
      if (index === -1) return previous;

      const current = previous[index];
      const status = order.status as Transaction['status'];

      // Undo the direction-aware src/dst mapping the payload builder applied.
      const isEthSource = current.direction.startsWith('eth');
      const ethTxHash = (isEthSource ? order.srcTxHash : order.dstTxHash) ?? current.ethTxHash;
      const stellarTxHash =
        (isEthSource ? order.dstTxHash : order.srcTxHash) ?? current.stellarTxHash;

      if (
        current.status === status &&
        current.ethTxHash === ethTxHash &&
        current.stellarTxHash === stellarTxHash
      ) {
        return previous;
      }

      const next = [...previous];
      next[index] = { ...current, status, ethTxHash, stellarTxHash };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // The live channel is captured on first render rather than tracked as a
  // dependency. Keying the transport on it means a caller who passes an inline
  // `createOrderEventChannel()` gets a new transport every render, and the
  // subscription effect then tears down and resubscribes in a loop. The channel
  // is a long-lived singleton in every real usage, so pinning it costs nothing
  // and removes a footgun that is very hard to diagnose from the symptom.
  const liveChannelRef = useRef(liveChannel);
  const orderEventTransport = useMemo(
    () => mergeTransports(pollChannel.transport, liveChannelRef.current.transport),
    [pollChannel],
  );

  const {
    error: streamError,
    consecutiveFailures: streamFailures,
    phase: streamPhase,
  } = useOrderSubscription({
    transport: orderEventTransport,
    onEvent: applyOrderEvent,
    // Never give up. A history view outlives any single coordinator outage, and
    // closing the subscription would also cut off the live bridge-form updates
    // that share this transport.
    maxConsecutiveFailures: 0,
  });

  useEffect(() => {
    const cache = readWalletCache();
    const immediate = hasWalletAddress ? cache?.transactions ?? loadFromStorage() : loadFromStorage();

    setTransactions(immediate);
    setLastFetchedAt(cache?.fetchedAt ?? null);

    if (hasWalletAddress) {
      void refreshFromCoordinator({ force: !cache || isCacheStale(cache.fetchedAt) });
    }
  }, [hasWalletAddress, isCacheStale, loadFromStorage, readWalletCache, refreshFromCoordinator]);

  useEffect(() => {
    if (!hasWalletAddress) return;

    const refreshIfStale = () => {
      const cache = readWalletCache();
      if (!cache || isCacheStale(cache.fetchedAt)) {
        void refreshFromCoordinator({ force: true });
      }
    };

    window.addEventListener('focus', refreshIfStale);
    const intervalId = window.setInterval(refreshIfStale, staleMs);

    return () => {
      window.removeEventListener('focus', refreshIfStale);
      window.clearInterval(intervalId);
    };
  }, [hasWalletAddress, isCacheStale, readWalletCache, refreshFromCoordinator, staleMs]);

  return {
    transactions,
    isLoading,
    isRefreshing,
    isStale: isCacheStale(lastFetchedAt),
    refreshFromCoordinator: () => refreshFromCoordinator({ force: true }),
    updateTransactions,
    loadFromStorage,
    /**
     * Health of the order-event subscription, distinct from the freshness of
     * the rows. `isStale` says the data is old; `streamError` says we have
     * temporarily lost the ability to learn that it is old.
     */
    streamError,
    streamFailures,
    streamPhase,
  };
}
