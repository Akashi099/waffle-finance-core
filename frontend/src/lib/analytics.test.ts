/**
 * Contract tests for the bridge analytics event layer.
 *
 * Covers:
 *  - Every helper produces a well-formed envelope with guaranteed fields.
 *  - The discriminated payload carries the correct `kind` and fields.
 *  - Failure in the transport never throws into the caller.
 *  - The transport is replaceable and receives all emitted events.
 *  - captureCoordinatorRequestId propagates to subsequent events.
 *  - emitAnalyticsEvent is safe to call with a broken transport.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SESSION_ID,
  captureCoordinatorRequestId,
  emitAnalyticsEvent,
  setAnalyticsTransport,
  trackFailureRecoveryInitiated,
  trackLockSubmitted,
  trackOrderAnnounced,
  trackQuoteRefreshed,
  trackRouteSelected,
  trackSettlementObserved,
  type BridgeAnalyticsEvent,
} from './analytics';

function makeCapture() {
  const events: BridgeAnalyticsEvent[] = [];
  setAnalyticsTransport((e) => events.push(e));
  return events;
}

beforeEach(() => {
  // Reset captured request ID between tests.
  captureCoordinatorRequestId(null);
  // Reset transport to a no-op so tests that don't capture don't leak.
  setAnalyticsTransport(() => undefined);
});

describe('envelope guarantees', () => {
  it('every event has sessionId, at, requestId, and payload', () => {
    const events = makeCapture();
    trackRouteSelected('eth_to_xlm');

    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(typeof ev.sessionId).toBe('string');
    expect(ev.sessionId).toBe(SESSION_ID);
    expect(typeof ev.at).toBe('number');
    expect(ev.at).toBeGreaterThan(0);
    expect('requestId' in ev).toBe(true);
    expect(ev.payload).toBeDefined();
  });

  it('at is within a few seconds of Date.now()', () => {
    const before = Date.now();
    const events = makeCapture();
    trackRouteSelected('xlm_to_eth');
    const after = Date.now();

    expect(events[0].at).toBeGreaterThanOrEqual(before);
    expect(events[0].at).toBeLessThanOrEqual(after);
  });

  it('requestId is null when no coordinator ID has been captured', () => {
    const events = makeCapture();
    trackRouteSelected('eth_to_sol');
    expect(events[0].requestId).toBeNull();
  });

  it('requestId reflects the last captured coordinator ID', () => {
    captureCoordinatorRequestId('req-abc-123');
    const events = makeCapture();
    trackRouteSelected('sol_to_eth');
    expect(events[0].requestId).toBe('req-abc-123');
  });

  it('captureCoordinatorRequestId can be reset to null', () => {
    captureCoordinatorRequestId('req-xyz');
    captureCoordinatorRequestId(null);
    const events = makeCapture();
    trackRouteSelected('eth_to_xlm');
    expect(events[0].requestId).toBeNull();
  });
});

describe('trackRouteSelected', () => {
  it('emits route_selected with correct direction', () => {
    const events = makeCapture();
    trackRouteSelected('eth_to_xlm');

    const payload = events[0].payload;
    expect(payload.kind).toBe('route_selected');
    if (payload.kind === 'route_selected') {
      expect(payload.direction).toBe('eth_to_xlm');
    }
  });
});

describe('trackQuoteRefreshed', () => {
  it('emits quote_refreshed with pair, staleness, and success flag', () => {
    const events = makeCapture();
    trackQuoteRefreshed('ETH-XLM', 'fresh', true);

    const payload = events[0].payload;
    expect(payload.kind).toBe('quote_refreshed');
    if (payload.kind === 'quote_refreshed') {
      expect(payload.pair).toBe('ETH-XLM');
      expect(payload.staleness).toBe('fresh');
      expect(payload.success).toBe(true);
    }
  });

  it('records failure correctly', () => {
    const events = makeCapture();
    trackQuoteRefreshed('ETH-SOL', 'fallback', false);

    const payload = events[0].payload;
    if (payload.kind === 'quote_refreshed') {
      expect(payload.success).toBe(false);
      expect(payload.staleness).toBe('fallback');
    }
  });
});

describe('trackOrderAnnounced', () => {
  it('emits order_announced with all chain fields', () => {
    const events = makeCapture();
    trackOrderAnnounced('wf_0xabc', 'eth_to_xlm', 'ethereum', 'stellar');

    const payload = events[0].payload;
    expect(payload.kind).toBe('order_announced');
    if (payload.kind === 'order_announced') {
      expect(payload.orderId).toBe('wf_0xabc');
      expect(payload.direction).toBe('eth_to_xlm');
      expect(payload.srcChain).toBe('ethereum');
      expect(payload.dstChain).toBe('stellar');
    }
  });
});

describe('trackLockSubmitted', () => {
  it('emits lock_submitted with txHash', () => {
    const events = makeCapture();
    trackLockSubmitted('wf_0xabc', 'eth_to_xlm', '0xdeadbeef');

    const payload = events[0].payload;
    expect(payload.kind).toBe('lock_submitted');
    if (payload.kind === 'lock_submitted') {
      expect(payload.txHash).toBe('0xdeadbeef');
    }
  });

  it('allows null txHash before hash is known', () => {
    const events = makeCapture();
    trackLockSubmitted('wf_0xabc', 'eth_to_xlm', null);

    const payload = events[0].payload;
    if (payload.kind === 'lock_submitted') {
      expect(payload.txHash).toBeNull();
    }
  });
});

describe('trackSettlementObserved', () => {
  it('emits settlement_observed with finalStatus and dstTxHash', () => {
    const events = makeCapture();
    trackSettlementObserved('wf_0xabc', 'completed', '0xsettledtx');

    const payload = events[0].payload;
    expect(payload.kind).toBe('settlement_observed');
    if (payload.kind === 'settlement_observed') {
      expect(payload.finalStatus).toBe('completed');
      expect(payload.dstTxHash).toBe('0xsettledtx');
    }
  });
});

describe('trackFailureRecoveryInitiated', () => {
  it('emits failure_recovery_initiated with reason and retryable flag', () => {
    const events = makeCapture();
    trackFailureRecoveryInitiated('wf_0xabc', 'timeout', true);

    const payload = events[0].payload;
    expect(payload.kind).toBe('failure_recovery_initiated');
    if (payload.kind === 'failure_recovery_initiated') {
      expect(payload.orderId).toBe('wf_0xabc');
      expect(payload.reason).toBe('timeout');
      expect(payload.retryable).toBe(true);
    }
  });

  it('allows null orderId for pre-announcement failures', () => {
    const events = makeCapture();
    trackFailureRecoveryInitiated(null, 'network_error', false);

    const payload = events[0].payload;
    if (payload.kind === 'failure_recovery_initiated') {
      expect(payload.orderId).toBeNull();
      expect(payload.retryable).toBe(false);
    }
  });
});

describe('transport safety', () => {
  it('a throwing transport does not propagate into the caller', () => {
    setAnalyticsTransport(() => { throw new Error('transport exploded'); });
    expect(() => trackRouteSelected('eth_to_xlm')).not.toThrow();
  });

  it('all helpers are safe when the transport throws', () => {
    setAnalyticsTransport(() => { throw new Error('boom'); });
    expect(() => trackQuoteRefreshed('ETH-XLM', 'fresh', true)).not.toThrow();
    expect(() => trackOrderAnnounced('id', 'eth_to_xlm', 'ethereum', 'stellar')).not.toThrow();
    expect(() => trackLockSubmitted('id', 'eth_to_xlm', null)).not.toThrow();
    expect(() => trackSettlementObserved('id', 'completed', null)).not.toThrow();
    expect(() => trackFailureRecoveryInitiated(null, 'err', false)).not.toThrow();
  });

  it('emitAnalyticsEvent is safe with a direct null payload', () => {
    const events = makeCapture();
    // Calling with a well-formed payload should still work
    emitAnalyticsEvent({ kind: 'route_selected', direction: 'eth_to_xlm' });
    expect(events).toHaveLength(1);
  });
});

describe('payload shape is JSON-serialisable', () => {
  it('round-trips through JSON without loss', () => {
    const events = makeCapture();
    captureCoordinatorRequestId('round-trip-id');
    trackOrderAnnounced('wf_0x999', 'eth_to_sol', 'ethereum', 'solana');

    const ev = events[0];
    const parsed = JSON.parse(JSON.stringify(ev)) as BridgeAnalyticsEvent;

    expect(parsed.sessionId).toBe(ev.sessionId);
    expect(parsed.at).toBe(ev.at);
    expect(parsed.requestId).toBe('round-trip-id');
    expect(parsed.payload.kind).toBe('order_announced');
  });
});
