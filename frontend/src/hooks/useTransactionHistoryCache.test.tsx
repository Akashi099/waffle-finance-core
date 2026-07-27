// @vitest-environment jsdom

import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createOrderEventChannel } from '../lib/orderEventStream';
import { orderEventFromHistoryRow } from '../lib/orderEvents';
import {
  getTransactionHistoryCacheKey,
  useTransactionHistoryCache,
  type Transaction,
} from './useTransactionHistoryCache';

const now = new Date('2026-06-21T00:00:00Z').getTime();

function makeTransaction(id: string, timestamp = now): Transaction {
  return {
    id,
    txHash: `0x${id}`,
    fromNetwork: 'Ethereum',
    toNetwork: 'Stellar',
    fromToken: 'ETH',
    toToken: 'XLM',
    amount: '1',
    estimatedAmount: '100',
    status: 'completed',
    timestamp,
    direction: 'eth-to-xlm',
  };
}

function writeWalletCache(
  ethAddress: string | undefined,
  stellarAddress: string | undefined,
  fetchedAt: number,
  transactions: Transaction[],
) {
  localStorage.setItem(
    getTransactionHistoryCacheKey(ethAddress, stellarAddress),
    JSON.stringify({ fetchedAt, transactions }),
  );
}

function responseWith(transactions: Transaction[]): Response {
  return {
    ok: true,
    json: async () => ({ transactions }),
  } as Response;
}

describe('useTransactionHistoryCache', () => {
  let currentTime = now;

  beforeEach(() => {
    currentTime = now;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  test('serves stale cached history immediately while refreshing in the background', async () => {
    const cached = makeTransaction('cached', now - 10);
    const remote = makeTransaction('remote', now + 10);
    let resolveFetch: (response: Response) => void = () => {};
    const fetcher = vi.fn(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    ) as unknown as typeof fetch;

    writeWalletCache('0xabc', undefined, now - 10_000, [cached]);

    const { result } = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xabc',
        apiBase: 'https://coordinator.example',
        staleMs: 1_000,
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['cached']);
    });
    expect(result.current.isRefreshing).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch(responseWith([remote]));
    });

    await waitFor(() => {
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['remote']);
    });
    expect(result.current.isRefreshing).toBe(false);
  });

  test('skips coordinator fetches while wallet cache is still fresh', async () => {
    const cached = makeTransaction('cached');
    const fetcher = vi.fn(async () => responseWith([])) as unknown as typeof fetch;

    writeWalletCache('0xabc', 'GABC', now, [cached]);

    const { result } = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xABC',
        stellarAddress: 'GABC',
        apiBase: 'https://coordinator.example',
        staleMs: 60_000,
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['cached']);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('refreshes on window focus after the cache turns stale', async () => {
    const cached = makeTransaction('cached');
    const remote = makeTransaction('remote', now + 100);
    const fetcher = vi.fn(async () => responseWith([remote])) as unknown as typeof fetch;

    writeWalletCache('0xabc', undefined, now, [cached]);

    const { result } = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xabc',
        apiBase: 'https://coordinator.example',
        staleMs: 1_000,
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['cached']);
    });
    expect(fetcher).not.toHaveBeenCalled();

    currentTime = now + 1_001;

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.current.transactions.map((tx) => tx.id)).toEqual(['remote']);
    });
  });
});

// ── Order-event subscription contract ────────────────────────────────────────

describe('useTransactionHistoryCache — order-event subscription', () => {
  let currentTime = now;

  beforeEach(() => {
    currentTime = now;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  /** Mount with a fresh cache so no coordinator fetch runs during the test. */
  function mountWithCachedRow(row: Transaction, liveChannel = createOrderEventChannel()) {
    const fetcher = vi.fn(async () => responseWith([])) as unknown as typeof fetch;
    writeWalletCache('0xabc', undefined, now, [row]);

    const rendered = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xabc',
        apiBase: 'https://coordinator.example',
        staleMs: 60_000,
        fetcher,
        liveChannel,
      }),
    );

    return { ...rendered, liveChannel, fetcher };
  }

  test('applies a live status event to the rendered row without refetching', async () => {
    const pending: Transaction = { ...makeTransaction('order-1'), status: 'pending' };
    const { result, liveChannel, fetcher } = mountWithCachedRow(pending);

    await waitFor(() => {
      expect(result.current.transactions.map((tx) => tx.status)).toEqual(['pending']);
    });

    // This is what the bridge form does the moment a swap completes, minutes
    // before the next poll would have noticed.
    act(() => {
      liveChannel.publish(
        orderEventFromHistoryRow(
          { ...pending, status: 'completed', stellarTxHash: 'stellar-hash' },
          'local',
        ),
      );
    });

    await waitFor(() => {
      expect(result.current.transactions[0].status).toBe('completed');
    });
    expect(result.current.transactions[0].stellarTxHash).toBe('stellar-hash');
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('persists the live update so a remount does not lose it', async () => {
    const pending: Transaction = { ...makeTransaction('order-2'), status: 'pending' };
    const { result, liveChannel } = mountWithCachedRow(pending);

    await waitFor(() => expect(result.current.transactions).toHaveLength(1));

    act(() => {
      liveChannel.publish(orderEventFromHistoryRow({ ...pending, status: 'failed' }, 'local'));
    });

    await waitFor(() => expect(result.current.transactions[0].status).toBe('failed'));

    const stored = JSON.parse(localStorage.getItem('wafflefinance_transactions_v2') ?? '[]');
    expect(stored[0]).toMatchObject({ id: 'order-2', status: 'failed' });
  });

  test('ignores events for orders it has no row for', async () => {
    const pending: Transaction = { ...makeTransaction('order-3'), status: 'pending' };
    const { result, liveChannel } = mountWithCachedRow(pending);

    await waitFor(() => expect(result.current.transactions).toHaveLength(1));

    // An event carries a status, not a renderable transaction; the producer has
    // persisted the full row and the next poll will merge it in.
    act(() => {
      liveChannel.publish(orderEventFromHistoryRow({ id: 'unknown', status: 'completed' }, 'local'));
    });

    expect(result.current.transactions).toHaveLength(1);
    expect(result.current.transactions[0].id).toBe('order-3');
  });

  test('normalises coordinator vocabulary arriving on the live channel', async () => {
    const pending: Transaction = { ...makeTransaction('order-4'), status: 'pending' };
    const { result, liveChannel } = mountWithCachedRow(pending);

    await waitFor(() => expect(result.current.transactions).toHaveLength(1));

    act(() => {
      // `dst_locked` is coordinator vocabulary; the row must end up `confirmed`,
      // which is what TransactionHistory knows how to render.
      liveChannel.publish(orderEventFromHistoryRow({ ...pending, status: 'dst_locked' }, 'live'));
    });

    await waitFor(() => expect(result.current.transactions[0].status).toBe('confirmed'));
  });

  test('reports a coordinator outage on the stream while keeping rows on screen', async () => {
    const cached = makeTransaction('cached');
    const fetcher = vi.fn(async () => {
      throw new Error('coordinator offline');
    }) as unknown as typeof fetch;

    writeWalletCache('0xabc', undefined, now - 10_000, [cached]);

    // Hoisted, not built inline: the hook pins the channel it sees on first
    // render, and a fresh one per render would be silently ignored anyway.
    const liveChannel = createOrderEventChannel();

    const { result } = renderHook(() =>
      useTransactionHistoryCache({
        ethAddress: '0xabc',
        apiBase: 'https://coordinator.example',
        staleMs: 1_000,
        fetcher,
        liveChannel,
      }),
    );

    await waitFor(() => {
      expect(result.current.streamError).not.toBeNull();
    });

    // The rows are still the best information available — losing sight of an
    // order is not the same as the order having gone away.
    expect(result.current.transactions.map((tx) => tx.id)).toEqual(['cached']);
    expect(result.current.streamFailures).toBeGreaterThan(0);
    expect(result.current.streamPhase).toBe('active');
  });

  test('pins the live channel so an unstable option cannot loop the subscription', async () => {
    const pending: Transaction = { ...makeTransaction('order-6'), status: 'pending' };
    const fetcher = vi.fn(async () => responseWith([])) as unknown as typeof fetch;
    writeWalletCache('0xabc', undefined, now, [pending]);

    const first = createOrderEventChannel();

    const { result, rerender } = renderHook(
      ({ channel }: { channel: ReturnType<typeof createOrderEventChannel> }) =>
        useTransactionHistoryCache({
          ethAddress: '0xabc',
          apiBase: 'https://coordinator.example',
          staleMs: 60_000,
          fetcher,
          liveChannel: channel,
        }),
      { initialProps: { channel: first } },
    );

    await waitFor(() => expect(result.current.transactions).toHaveLength(1));

    // A caller passing a fresh channel each render used to produce a fresh
    // transport each render, which resubscribed in a loop and hung the suite.
    const second = createOrderEventChannel();
    rerender({ channel: second });
    rerender({ channel: createOrderEventChannel() });

    expect(first.subscriberCount).toBe(1);
    expect(second.subscriberCount).toBe(0);

    // The channel captured on first render is still the one that drives updates.
    act(() => {
      first.publish(orderEventFromHistoryRow({ ...pending, status: 'completed' }, 'local'));
    });

    await waitFor(() => expect(result.current.transactions[0].status).toBe('completed'));
  });

  test('detaches from the live channel on unmount', async () => {
    const liveChannel = createOrderEventChannel();
    const pending: Transaction = { ...makeTransaction('order-5'), status: 'pending' };
    const { result, unmount } = mountWithCachedRow(pending, liveChannel);

    await waitFor(() => expect(result.current.transactions).toHaveLength(1));
    expect(liveChannel.subscriberCount).toBe(1);

    unmount();

    expect(liveChannel.subscriberCount).toBe(0);
    // A late publish must not reach a torn-down consumer.
    expect(() => liveChannel.publish(orderEventFromHistoryRow({ ...pending, status: 'completed' }))).not.toThrow();
  });
});
