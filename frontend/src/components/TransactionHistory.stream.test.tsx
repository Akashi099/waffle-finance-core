// @vitest-environment jsdom

/**
 * Component-level tests for how a degraded event stream is presented.
 *
 * The contract distinguishes an order that failed from a stream that failed;
 * these assert the UI keeps that distinction visible, because conflating them
 * would tell a user their swap broke when only our view of it did.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { OrderEventError } from '../lib/orderEvents';
import type { Transaction } from '../hooks/useTransactionHistoryCache';

vi.mock('../config/networks', () => ({
  isTestnet: () => true,
}));

vi.mock('../features/refund/RefundDialog', () => ({
  default: () => null,
}));

const cacheState = {
  transactions: [] as Transaction[],
  isLoading: false,
  isRefreshing: false,
  isStale: false,
  refreshFromCoordinator: vi.fn(),
  updateTransactions: vi.fn(),
  loadFromStorage: vi.fn(() => [] as Transaction[]),
  streamError: null as OrderEventError | null,
  streamFailures: 0,
  streamPhase: 'active' as const,
};

// Replaced wholesale rather than spread over the real module: the component
// uses nothing else from it at runtime (`Transaction` is a type-only import,
// erased at compile time).
vi.mock('../hooks/useTransactionHistoryCache', () => ({
  useTransactionHistoryCache: () => cacheState,
}));

// Imported dynamically so `cacheState` is initialised before the hoisted
// `vi.mock` factory above closes over it.
const { default: TransactionHistory } = await import('./TransactionHistory');

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'order-1',
    txHash: '0xrealhash',
    fromNetwork: 'ETH Sepolia',
    toNetwork: 'Stellar Testnet',
    fromToken: 'ETH',
    toToken: 'XLM',
    amount: '0.5',
    estimatedAmount: '5000',
    status: 'pending',
    timestamp: Date.now(),
    direction: 'eth-to-xlm',
    ...overrides,
  };
}

const OFFLINE: OrderEventError = {
  code: 'network',
  message: 'coordinator offline',
  retryable: true,
};

beforeEach(() => {
  cacheState.transactions = [];
  cacheState.isLoading = false;
  cacheState.isRefreshing = false;
  cacheState.isStale = false;
  cacheState.streamError = null;
  cacheState.streamFailures = 0;
});

describe('TransactionHistory — stream health', () => {
  test('says nothing about the stream while it is healthy', () => {
    cacheState.transactions = [makeTransaction()];

    render(<TransactionHistory ethAddress="0xabc" />);

    expect(screen.queryByText(/Live updates paused/i)).not.toBeInTheDocument();
  });

  test('announces a paused stream without disturbing the rows', () => {
    cacheState.transactions = [makeTransaction({ status: 'confirmed' })];
    cacheState.streamError = OFFLINE;
    cacheState.streamFailures = 1;

    render(<TransactionHistory ethAddress="0xabc" />);

    const notice = screen.getByText(/Live updates paused/i);
    expect(notice).toBeInTheDocument();
    // Politely announced, so a screen reader hears it without losing its place.
    expect(notice.getAttribute('aria-live')).toBe('polite');

    // The swap itself is untouched: still confirmed, still rendered.
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  test('does not present a stream outage as a failed swap', () => {
    cacheState.transactions = [makeTransaction({ status: 'pending' })];
    cacheState.streamError = OFFLINE;
    cacheState.streamFailures = 3;

    render(<TransactionHistory ethAddress="0xabc" />);

    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(screen.getByText(/Retrying automatically/i)).toBeInTheDocument();
  });

  test('mentions the attempt count only once it is worth mentioning', () => {
    cacheState.transactions = [makeTransaction()];
    cacheState.streamError = OFFLINE;
    cacheState.streamFailures = 1;

    const { unmount } = render(<TransactionHistory ethAddress="0xabc" />);
    expect(screen.queryByText(/failed attempts/i)).not.toBeInTheDocument();
    unmount();

    cacheState.streamFailures = 4;
    render(<TransactionHistory ethAddress="0xabc" />);
    expect(screen.getByText(/after 4 failed attempts/i)).toBeInTheDocument();
  });

  test('shows the outage notice even with no transactions to display', () => {
    cacheState.streamError = OFFLINE;
    cacheState.streamFailures = 2;

    render(<TransactionHistory ethAddress="0xabc" />);

    // The staleness line above is gated on having rows; this one is not, so a
    // user with an empty list still learns the connection is down.
    expect(screen.getByText(/Live updates paused/i)).toBeInTheDocument();
    expect(screen.getByText('No transactions yet')).toBeInTheDocument();
  });
});
