import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createQuote,
  validateQuote,
  serializeQuote,
  deserializeQuote,
  clearPersistedQuote,
  type BridgeQuote,
  type SupportedChain,
} from './quoteModel';

const ETH_ASSET = { chain: 'ethereum' as SupportedChain, symbol: 'ETH', decimals: 18 };
const XLM_ASSET = { chain: 'stellar' as SupportedChain, symbol: 'XLM', decimals: 7 };

function makeQuote(overrides: Partial<BridgeQuote> = {}): BridgeQuote {
  return {
    ...createQuote({
      srcChain: 'ethereum',
      dstChain: 'stellar',
      fromAsset: ETH_ASSET,
      toAsset: XLM_ASSET,
      fromAmount: '0.1',
      estimatedToAmount: '2916.60',
      exchangeRate: 29166,
      priceStateness: 'fresh',
    }),
    ...overrides,
  };
}

// ── createQuote ───────────────────────────────────────────────────────────────

describe('createQuote', () => {
  it('sets quotedAt to approximately now', () => {
    const before = Date.now();
    const q = makeQuote();
    expect(q.quotedAt).toBeGreaterThanOrEqual(before);
    expect(q.quotedAt).toBeLessThanOrEqual(Date.now());
  });

  it('sets expiresAt 60 s after quotedAt', () => {
    const q = makeQuote();
    expect(q.expiresAt - q.quotedAt).toBe(60_000);
  });

  it('uses the provided timelockSeconds when given', () => {
    const q = createQuote({
      srcChain: 'ethereum',
      dstChain: 'stellar',
      fromAsset: ETH_ASSET,
      toAsset: XLM_ASSET,
      fromAmount: '1',
      estimatedToAmount: '29166',
      exchangeRate: 29166,
      priceStateness: 'fresh',
      timelockSeconds: 7200,
    });
    expect(q.timelockSeconds).toBe(7200);
  });

  it('defaults timelockSeconds to 3600', () => {
    const q = makeQuote();
    expect(q.timelockSeconds).toBe(3600);
  });

  it('defaults feeEstimate and safetyDeposit to "0"', () => {
    const q = makeQuote();
    expect(q.feeEstimate).toBe('0');
    expect(q.safetyDeposit).toBe('0');
  });
});

// ── validateQuote — valid ─────────────────────────────────────────────────────

describe('validateQuote — valid cases', () => {
  it('returns valid for a fresh quote matching chain and amount', () => {
    const q = makeQuote();
    const result = validateQuote(q, 'ethereum', 'stellar', '0.1');
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('accepts a fallback-staleness quote when chains and amount match', () => {
    const q = makeQuote({ priceStateness: 'fallback' });
    expect(validateQuote(q, 'ethereum', 'stellar', '0.1').valid).toBe(true);
  });
});

// ── validateQuote — null ──────────────────────────────────────────────────────

describe('validateQuote — null quote', () => {
  it('returns invalid with reason "missing" for null quote', () => {
    const result = validateQuote(null, 'ethereum', 'stellar', '0.1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing');
    expect(result.message).toMatch(/no quote/i);
  });
});

// ── validateQuote — expiration ────────────────────────────────────────────────

describe('validateQuote — expiration', () => {
  it('returns invalid with reason "expired" when expiresAt is in the past', () => {
    const q = makeQuote({ expiresAt: Date.now() - 1 });
    const result = validateQuote(q, 'ethereum', 'stellar', '0.1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
    expect(result.message).toMatch(/expired/i);
  });

  it('accepts a quote whose expiresAt is exactly now (boundary)', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const q = makeQuote({ expiresAt: now });
    expect(validateQuote(q, 'ethereum', 'stellar', '0.1').valid).toBe(true);
    vi.useRealTimers();
  });
});

// ── validateQuote — chain mismatch ────────────────────────────────────────────

describe('validateQuote — chain mismatch', () => {
  it('returns invalid when srcChain differs', () => {
    const q = makeQuote({ srcChain: 'ethereum' });
    const result = validateQuote(q, 'solana', 'stellar', '0.1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('chain_mismatch');
    expect(result.message).toMatch(/route changed/i);
  });

  it('returns invalid when dstChain differs', () => {
    const q = makeQuote({ dstChain: 'stellar' });
    const result = validateQuote(q, 'ethereum', 'solana', '0.1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('chain_mismatch');
  });

  it('returns invalid when both chains differ', () => {
    const q = makeQuote();
    const result = validateQuote(q, 'stellar', 'ethereum', '0.1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('chain_mismatch');
  });
});

// ── validateQuote — amount mismatch ───────────────────────────────────────────

describe('validateQuote — amount mismatch', () => {
  it('returns invalid when fromAmount has changed', () => {
    const q = makeQuote({ fromAmount: '0.1' });
    const result = validateQuote(q, 'ethereum', 'stellar', '0.2');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('amount_mismatch');
    expect(result.message).toMatch(/amount changed/i);
  });

  it('is valid when amount is string-identical', () => {
    const q = makeQuote({ fromAmount: '1.50' });
    expect(validateQuote(q, 'ethereum', 'stellar', '1.50').valid).toBe(true);
  });
});

// ── serialization roundtrip ───────────────────────────────────────────────────

describe('serializeQuote / deserializeQuote', () => {
  const mockStorage: Record<string, string> = {};

  beforeEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: {
        getItem: (k: string) => mockStorage[k] ?? null,
        setItem: (k: string, v: string) => { mockStorage[k] = v; },
        removeItem: (k: string) => { delete mockStorage[k]; },
      },
      writable: true,
      configurable: true,
    });
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  });

  it('round-trips a valid quote through sessionStorage', () => {
    const q = makeQuote();
    serializeQuote(q);
    const recovered = deserializeQuote();
    expect(recovered).not.toBeNull();
    expect(recovered!.srcChain).toBe('ethereum');
    expect(recovered!.dstChain).toBe('stellar');
    expect(recovered!.fromAmount).toBe('0.1');
    expect(recovered!.quotedAt).toBe(q.quotedAt);
    expect(recovered!.expiresAt).toBe(q.expiresAt);
  });

  it('returns null when sessionStorage is empty', () => {
    expect(deserializeQuote()).toBeNull();
  });

  it('returns null for malformed stored data', () => {
    mockStorage['wafflefinance_active_quote_v1'] = 'not-json';
    expect(deserializeQuote()).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    mockStorage['wafflefinance_active_quote_v1'] = JSON.stringify({ srcChain: 'ethereum' });
    expect(deserializeQuote()).toBeNull();
  });

  it('clearPersistedQuote removes the entry', () => {
    const q = makeQuote();
    serializeQuote(q);
    clearPersistedQuote();
    expect(deserializeQuote()).toBeNull();
  });
});
