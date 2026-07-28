/**
 * Tests for the coordinator freshness policy contract.
 *
 * Covers:
 *  - classify() returns 'missing' for null fetchedAt.
 *  - classify() returns 'fresh' within freshTtlMs.
 *  - classify() returns 'stale' between freshTtlMs and staleTtlMs.
 *  - classify() returns 'expired' beyond staleTtlMs.
 *  - invalidate() forces the next classify() call to return 'expired'.
 *  - After the invalidated read, the key is no longer marked.
 *  - invalidatePrefix() invalidates all matching keys.
 *  - wrap() bundles data with correct freshness metadata.
 *  - Constructor throws when staleTtlMs < freshTtlMs.
 *  - Concurrent independent FreshnessPolicy instances do not share state.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { FreshnessPolicy } from '../src/services/freshness-policy.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('FreshnessPolicy.classify', () => {
  it('returns missing for null fetchedAt', () => {
    const policy = new FreshnessPolicy();
    const meta = policy.classify(null);
    expect(meta.freshness).toBe('missing');
    expect(meta.fetchedAt).toBeNull();
    expect(meta.ageMs).toBeNull();
    expect(meta.eventInvalidated).toBe(false);
  });

  it('returns fresh when data is within freshTtlMs', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    vi.setSystemTime(now + 10_000); // 10 seconds later — still fresh
    const meta = policy.classify(now);

    expect(meta.freshness).toBe('fresh');
    expect(meta.fetchedAt).toBe(now);
    expect(meta.ageMs).toBeGreaterThanOrEqual(10_000);
  });

  it('returns stale when data age is between freshTtlMs and staleTtlMs', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    vi.setSystemTime(now + 60_000); // 60 seconds — stale
    const meta = policy.classify(now);

    expect(meta.freshness).toBe('stale');
  });

  it('returns expired when data age exceeds staleTtlMs', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    vi.setSystemTime(now + 200_000); // 200 seconds — expired
    const meta = policy.classify(now);

    expect(meta.freshness).toBe('expired');
  });

  it('attaches correct ageMs to the metadata', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    vi.setSystemTime(now + 5_000);
    const meta = policy.classify(now);

    expect(meta.ageMs).toBeGreaterThanOrEqual(5_000);
    expect(meta.ageMs).toBeLessThan(6_000);
  });
});

describe('FreshnessPolicy.invalidate', () => {
  it('forces the next classify() to return expired regardless of age', () => {
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidate('key:addr1');
    // Data is brand new (age ≈ 0) but the key was invalidated
    const meta = policy.classify(now, 'key:addr1');

    expect(meta.freshness).toBe('expired');
    expect(meta.eventInvalidated).toBe(true);
  });

  it('clears the invalidation flag after it is consumed', () => {
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidate('key:addr1');
    policy.classify(now, 'key:addr1'); // consumes the flag

    const second = policy.classify(now, 'key:addr1');
    expect(second.freshness).toBe('fresh');
    expect(second.eventInvalidated).toBe(false);
  });

  it('does not affect a different key', () => {
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidate('key:addr1');
    const meta = policy.classify(now, 'key:addr2');

    expect(meta.freshness).toBe('fresh');
    expect(meta.eventInvalidated).toBe(false);
  });
});

describe('FreshnessPolicy.invalidatePrefix', () => {
  it('marks all keys with the given prefix as invalidated', () => {
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidatePrefix('0xAddr1:');

    expect(policy.isInvalidated('0xAddr1:50:first')).toBe(true);
    expect(policy.isInvalidated('0xAddr1:100:cursor1')).toBe(true);
    expect(policy.isInvalidated('0xAddr2:50:first')).toBe(false);
  });
});

describe('FreshnessPolicy.wrap', () => {
  it('bundles data with its freshness metadata', () => {
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    const result = policy.wrap({ value: 42 }, now, 'my-key');

    expect(result.data).toEqual({ value: 42 });
    expect(result.meta.freshness).toBe('fresh');
    expect(result.meta.fetchedAt).toBe(now);
  });

  it('wraps null data as a missing result', () => {
    const policy = new FreshnessPolicy();
    const result = policy.wrap<string>(null, null);

    expect(result.data).toBeNull();
    expect(result.meta.freshness).toBe('missing');
  });

  it('marks wrapped result as expired when key is invalidated', () => {
    const now = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 120_000 });

    policy.invalidate('my-key');
    const result = policy.wrap({ value: 1 }, now, 'my-key');

    expect(result.meta.freshness).toBe('expired');
    expect(result.meta.eventInvalidated).toBe(true);
  });
});

describe('FreshnessPolicy constructor validation', () => {
  it('throws when staleTtlMs < freshTtlMs', () => {
    expect(() => new FreshnessPolicy({ freshTtlMs: 60_000, staleTtlMs: 30_000 })).toThrow(RangeError);
  });

  it('accepts equal freshTtlMs and staleTtlMs', () => {
    expect(() => new FreshnessPolicy({ freshTtlMs: 30_000, staleTtlMs: 30_000 })).not.toThrow();
  });
});

describe('independent policy instances', () => {
  it('do not share invalidation state', () => {
    const now = Date.now();
    const policyA = new FreshnessPolicy();
    const policyB = new FreshnessPolicy();

    policyA.invalidate('shared-key');

    expect(policyA.classify(now, 'shared-key').freshness).toBe('expired');
    expect(policyB.classify(now, 'shared-key').freshness).toBe('fresh');
  });
});

describe('stale query re-query stability', () => {
  it('returns stale on first read then fresh after invalidation + re-read', () => {
    vi.useFakeTimers();
    const fetchedAt = Date.now();
    const policy = new FreshnessPolicy({ freshTtlMs: 10_000, staleTtlMs: 60_000 });

    // Advance to stale territory
    vi.setSystemTime(fetchedAt + 20_000);
    const first = policy.classify(fetchedAt, 'order:history:addr1');
    expect(first.freshness).toBe('stale');

    // Simulate a chain event triggering invalidation
    policy.invalidate('order:history:addr1');

    // Simulate a cache refresh: new data arrives and is classified
    const refreshedAt = Date.now();
    const second = policy.classify(refreshedAt, 'order:history:addr1');
    // After invalidation the flag is consumed on first classify; new data is fresh
    // The invalidated flag causes the FIRST classify to return expired...
    expect(second.freshness).toBe('expired'); // invalidation consumed
    expect(second.eventInvalidated).toBe(true);

    // Next classify with the refreshed timestamp (new data, same key) → fresh
    const third = policy.classify(refreshedAt, 'order:history:addr1');
    expect(third.freshness).toBe('fresh');
    expect(third.eventInvalidated).toBe(false);
  });
});
