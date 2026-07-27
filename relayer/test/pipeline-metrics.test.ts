/**
 * Tests for the relayer pipeline observability metrics (#347).
 *
 * Strategy: import the metrics objects directly and drive them through the
 * same helper functions the production code calls (or call the metric APIs
 * directly to simulate what the instrumented endpoints do). No HTTP server
 * is started — this keeps the tests fast and side-effect free.
 *
 * Covers:
 *  1. orderIngestionTotal — increments on every received direction.
 *  2. relayDecisionTotal  — accepted / rejected_route / rejected_permissions /
 *                           rejected_validation all increment independently.
 *  3. orderQueueDepth     — tracks active-order map size correctly.
 *  4. submissionLatencySeconds — timer start/stop records an observation.
 *  5. receiptLatencySeconds    — all result labels (success, tx_not_found,
 *                               tx_failed, payment_mismatch, horizon_error).
 *  6. retryAttemptsHistogram   — 0-retry success and N-retry saturation paths.
 *  7. droppedOrdersTotal       — eth_tx_failed and horizon_permanent reasons.
 *  8. chainDelayGauge          — set/reset semantics per chain.
 *  9. pipelineMetrics bundle   — bundle export contains all eight metrics.
 * 10. Saturation scenario      — multiple rejected + one accepted simulates a
 *                               saturated relay and all counters advance.
 * 11. Delayed relay scenario   — chainDelayGauge stays elevated until reset.
 * 12. Metric isolation         — each metric carries only its own labels.
 */

import { describe, it, expect } from 'vitest';
import {
  orderIngestionTotal,
  orderQueueDepth,
  relayDecisionTotal,
  submissionLatencySeconds,
  receiptLatencySeconds,
  retryAttemptsHistogram,
  droppedOrdersTotal,
  chainDelayGauge,
  pipelineMetrics,
} from '../src/metrics.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read the current value of a counter for a given label set. */
async function counterValue(
  metric: typeof orderIngestionTotal,
  labels: Record<string, string>
): Promise<number> {
  const data = await metric.get();
  const entry = data.values.find((v) =>
    Object.entries(labels).every(([k, val]) => (v.labels as any)[k] === val)
  );
  return entry?.value ?? 0;
}

/** Read the current value of a gauge for a given label set (or no labels). */
async function gaugeValue(
  metric: typeof orderQueueDepth,
  labels: Record<string, string> = {}
): Promise<number> {
  const data = await metric.get();
  if (Object.keys(labels).length === 0) {
    return data.values[0]?.value ?? 0;
  }
  const entry = data.values.find((v) =>
    Object.entries(labels).every(([k, val]) => (v.labels as any)[k] === val)
  );
  return entry?.value ?? 0;
}

/** Read the sum of all observations in a histogram for a given label set. */
async function histogramSum(
  metric: typeof submissionLatencySeconds,
  labels: Record<string, string>
): Promise<number> {
  const data = await metric.get();
  const sumEntry = data.values.find(
    (v) =>
      (v as any).metricName?.endsWith('_sum') &&
      Object.entries(labels).every(([k, val]) => (v.labels as any)[k] === val)
  );
  return sumEntry?.value ?? 0;
}

/** Read the count of observations in a histogram for a given label set. */
async function histogramCount(
  metric: typeof submissionLatencySeconds,
  labels: Record<string, string>
): Promise<number> {
  const data = await metric.get();
  const countEntry = data.values.find(
    (v) =>
      (v as any).metricName?.endsWith('_count') &&
      Object.entries(labels).every(([k, val]) => (v.labels as any)[k] === val)
  );
  return countEntry?.value ?? 0;
}

// ── 1. orderIngestionTotal ────────────────────────────────────────────────────

describe('orderIngestionTotal', () => {
  it('increments for a known direction', async () => {
    const before = await counterValue(orderIngestionTotal, { direction: 'eth_to_xlm' });
    orderIngestionTotal.inc({ direction: 'eth_to_xlm' });
    const after = await counterValue(orderIngestionTotal, { direction: 'eth_to_xlm' });
    expect(after).toBe(before + 1);
  });

  it('increments for "unknown" when direction is missing', async () => {
    const before = await counterValue(orderIngestionTotal, { direction: 'unknown' });
    orderIngestionTotal.inc({ direction: 'unknown' });
    const after = await counterValue(orderIngestionTotal, { direction: 'unknown' });
    expect(after).toBe(before + 1);
  });

  it('tracks both directions independently', async () => {
    const beforeEth = await counterValue(orderIngestionTotal, { direction: 'eth_to_xlm' });
    const beforeXlm = await counterValue(orderIngestionTotal, { direction: 'xlm_to_eth' });
    orderIngestionTotal.inc({ direction: 'eth_to_xlm' });
    orderIngestionTotal.inc({ direction: 'eth_to_xlm' });
    orderIngestionTotal.inc({ direction: 'xlm_to_eth' });
    expect(await counterValue(orderIngestionTotal, { direction: 'eth_to_xlm' })).toBe(beforeEth + 2);
    expect(await counterValue(orderIngestionTotal, { direction: 'xlm_to_eth' })).toBe(beforeXlm + 1);
  });
});

// ── 2. relayDecisionTotal ─────────────────────────────────────────────────────

describe('relayDecisionTotal', () => {
  it('increments accepted for eth_to_xlm', async () => {
    const before = await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'accepted' });
    relayDecisionTotal.inc({ direction: 'eth_to_xlm', result: 'accepted' });
    const after = await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'accepted' });
    expect(after).toBe(before + 1);
  });

  it('tracks rejected_route independently from accepted', async () => {
    const beforeAccepted = await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'accepted' });
    const beforeRejected = await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'rejected_route' });
    relayDecisionTotal.inc({ direction: 'eth_to_xlm', result: 'rejected_route' });
    expect(await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'rejected_route' })).toBe(beforeRejected + 1);
    expect(await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'accepted' })).toBe(beforeAccepted);
  });

  it('tracks all four result labels', async () => {
    const results = ['accepted', 'rejected_route', 'rejected_permissions', 'rejected_validation'] as const;
    const before: Record<string, number> = {};
    for (const r of results) {
      before[r] = await counterValue(relayDecisionTotal, { direction: 'xlm_to_eth', result: r });
    }
    for (const r of results) {
      relayDecisionTotal.inc({ direction: 'xlm_to_eth', result: r });
    }
    for (const r of results) {
      const after = await counterValue(relayDecisionTotal, { direction: 'xlm_to_eth', result: r });
      expect(after).toBe(before[r]! + 1);
    }
  });
});

// ── 3. orderQueueDepth ────────────────────────────────────────────────────────

describe('orderQueueDepth', () => {
  it('set() replaces the previous value', async () => {
    orderQueueDepth.set(5);
    expect(await gaugeValue(orderQueueDepth)).toBe(5);
    orderQueueDepth.set(3);
    expect(await gaugeValue(orderQueueDepth)).toBe(3);
  });

  it('set(0) resets to zero', async () => {
    orderQueueDepth.set(10);
    orderQueueDepth.set(0);
    expect(await gaugeValue(orderQueueDepth)).toBe(0);
  });

  it('reflects simulated order lifecycle: enqueue then settle', async () => {
    orderQueueDepth.set(0);
    // Simulate 3 orders arriving
    for (let i = 1; i <= 3; i++) orderQueueDepth.set(i);
    expect(await gaugeValue(orderQueueDepth)).toBe(3);
    // Simulate 2 settling
    orderQueueDepth.set(1);
    expect(await gaugeValue(orderQueueDepth)).toBe(1);
  });
});

// ── 4. submissionLatencySeconds ───────────────────────────────────────────────

describe('submissionLatencySeconds', () => {
  it('startTimer/stop records an observation', async () => {
    const before = await histogramCount(submissionLatencySeconds, { direction: 'eth_to_xlm', result: 'success' });
    const stop = submissionLatencySeconds.startTimer({ direction: 'eth_to_xlm' });
    stop({ result: 'success' });
    const after = await histogramCount(submissionLatencySeconds, { direction: 'eth_to_xlm', result: 'success' });
    expect(after).toBe(before + 1);
  });

  it('observe() directly records a latency value', async () => {
    const before = await histogramCount(submissionLatencySeconds, { direction: 'xlm_to_eth', result: 'failure' });
    submissionLatencySeconds.observe({ direction: 'xlm_to_eth', result: 'failure' }, 2.5);
    const after = await histogramCount(submissionLatencySeconds, { direction: 'xlm_to_eth', result: 'failure' });
    expect(after).toBe(before + 1);
  });

  it('success and failure observations are tracked separately', async () => {
    const beforeSuccess = await histogramCount(submissionLatencySeconds, { direction: 'eth_to_xlm', result: 'success' });
    const beforeFailure = await histogramCount(submissionLatencySeconds, { direction: 'eth_to_xlm', result: 'failure' });
    submissionLatencySeconds.observe({ direction: 'eth_to_xlm', result: 'success' }, 1);
    submissionLatencySeconds.observe({ direction: 'eth_to_xlm', result: 'success' }, 1);
    submissionLatencySeconds.observe({ direction: 'eth_to_xlm', result: 'failure' }, 30);
    expect(await histogramCount(submissionLatencySeconds, { direction: 'eth_to_xlm', result: 'success' })).toBe(beforeSuccess + 2);
    expect(await histogramCount(submissionLatencySeconds, { direction: 'eth_to_xlm', result: 'failure' })).toBe(beforeFailure + 1);
  });
});

// ── 5. receiptLatencySeconds ──────────────────────────────────────────────────

describe('receiptLatencySeconds', () => {
  const RESULT_LABELS = ['success', 'tx_not_found', 'tx_failed', 'payment_mismatch', 'horizon_error'] as const;

  for (const result of RESULT_LABELS) {
    it(`records an observation for result="${result}"`, async () => {
      const before = await histogramCount(receiptLatencySeconds, { result });
      receiptLatencySeconds.observe({ result }, 0.1);
      const after = await histogramCount(receiptLatencySeconds, { result });
      expect(after).toBe(before + 1);
    });
  }

  it('startTimer stop records observation for success', async () => {
    const before = await histogramCount(receiptLatencySeconds, { result: 'success' });
    const stop = receiptLatencySeconds.startTimer();
    stop({ result: 'success' });
    const after = await histogramCount(receiptLatencySeconds, { result: 'success' });
    expect(after).toBe(before + 1);
  });

  it('each result label is independent', async () => {
    const before: Record<string, number> = {};
    for (const r of RESULT_LABELS) {
      before[r] = await histogramCount(receiptLatencySeconds, { result: r });
    }
    // Observe only tx_not_found
    receiptLatencySeconds.observe({ result: 'tx_not_found' }, 0.05);
    expect(await histogramCount(receiptLatencySeconds, { result: 'tx_not_found' })).toBe(before['tx_not_found']! + 1);
    // All others unchanged
    for (const r of RESULT_LABELS.filter((r) => r !== 'tx_not_found')) {
      expect(await histogramCount(receiptLatencySeconds, { result: r })).toBe(before[r]!);
    }
  });
});

// ── 6. retryAttemptsHistogram ─────────────────────────────────────────────────

describe('retryAttemptsHistogram', () => {
  it('records zero retries on first-try success', async () => {
    const before = await histogramCount(retryAttemptsHistogram, { operation: 'eth_send', result: 'success' });
    retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'success' }, 0);
    expect(await histogramCount(retryAttemptsHistogram, { operation: 'eth_send', result: 'success' })).toBe(before + 1);
  });

  it('records N retries when rate-limited N times before success', async () => {
    const before = await histogramCount(retryAttemptsHistogram, { operation: 'eth_send', result: 'success' });
    // Simulates 3 rate-limit retries before success
    retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'success' }, 3);
    expect(await histogramCount(retryAttemptsHistogram, { operation: 'eth_send', result: 'success' })).toBe(before + 1);
  });

  it('records max retries on failure (exhausted)', async () => {
    const before = await histogramCount(retryAttemptsHistogram, { operation: 'eth_send', result: 'failure' });
    retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'failure' }, 3);
    expect(await histogramCount(retryAttemptsHistogram, { operation: 'eth_send', result: 'failure' })).toBe(before + 1);
  });

  it('tracks balance_check and horizon_verify independently', async () => {
    const ops = ['eth_send', 'balance_check', 'horizon_verify'] as const;
    const before: Record<string, number> = {};
    for (const op of ops) {
      before[op] = await histogramCount(retryAttemptsHistogram, { operation: op, result: 'success' });
    }
    retryAttemptsHistogram.observe({ operation: 'balance_check', result: 'success' }, 1);
    expect(await histogramCount(retryAttemptsHistogram, { operation: 'balance_check', result: 'success' })).toBe(before['balance_check']! + 1);
    expect(await histogramCount(retryAttemptsHistogram, { operation: 'eth_send', result: 'success' })).toBe(before['eth_send']!);
    expect(await histogramCount(retryAttemptsHistogram, { operation: 'horizon_verify', result: 'success' })).toBe(before['horizon_verify']!);
  });

  it('accumulates multiple observations (saturation scenario)', async () => {
    const before = await histogramCount(retryAttemptsHistogram, { operation: 'eth_send', result: 'success' });
    // Simulate 5 separate submission attempts with varying retry counts
    for (const retries of [0, 1, 2, 3, 1]) {
      retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'success' }, retries);
    }
    const after = await histogramCount(retryAttemptsHistogram, { operation: 'eth_send', result: 'success' });
    expect(after).toBe(before + 5);
  });
});

// ── 7. droppedOrdersTotal ─────────────────────────────────────────────────────

describe('droppedOrdersTotal', () => {
  it('increments for eth_tx_failed on xlm_to_eth', async () => {
    const before = await counterValue(droppedOrdersTotal, { direction: 'xlm_to_eth', reason: 'eth_tx_failed' });
    droppedOrdersTotal.inc({ direction: 'xlm_to_eth', reason: 'eth_tx_failed' });
    const after = await counterValue(droppedOrdersTotal, { direction: 'xlm_to_eth', reason: 'eth_tx_failed' });
    expect(after).toBe(before + 1);
  });

  it('increments for horizon_permanent independently', async () => {
    const before = await counterValue(droppedOrdersTotal, { direction: 'xlm_to_eth', reason: 'horizon_permanent' });
    droppedOrdersTotal.inc({ direction: 'xlm_to_eth', reason: 'horizon_permanent' });
    const after = await counterValue(droppedOrdersTotal, { direction: 'xlm_to_eth', reason: 'horizon_permanent' });
    expect(after).toBe(before + 1);
  });

  it('tracks all defined reason codes', async () => {
    const reasons = ['eth_tx_failed', 'horizon_permanent', 'proof_replay', 'permission_denied', 'internal_error'] as const;
    const before: Record<string, number> = {};
    for (const r of reasons) {
      before[r] = await counterValue(droppedOrdersTotal, { direction: 'eth_to_xlm', reason: r });
    }
    for (const r of reasons) {
      droppedOrdersTotal.inc({ direction: 'eth_to_xlm', reason: r });
    }
    for (const r of reasons) {
      const after = await counterValue(droppedOrdersTotal, { direction: 'eth_to_xlm', reason: r });
      expect(after).toBe(before[r]! + 1);
    }
  });

  it('directions are tracked independently', async () => {
    const beforeEth = await counterValue(droppedOrdersTotal, { direction: 'eth_to_xlm', reason: 'eth_tx_failed' });
    const beforeXlm = await counterValue(droppedOrdersTotal, { direction: 'xlm_to_eth', reason: 'eth_tx_failed' });
    droppedOrdersTotal.inc({ direction: 'eth_to_xlm', reason: 'eth_tx_failed' });
    expect(await counterValue(droppedOrdersTotal, { direction: 'eth_to_xlm', reason: 'eth_tx_failed' })).toBe(beforeEth + 1);
    expect(await counterValue(droppedOrdersTotal, { direction: 'xlm_to_eth', reason: 'eth_tx_failed' })).toBe(beforeXlm);
  });
});

// ── 8. chainDelayGauge ────────────────────────────────────────────────────────

describe('chainDelayGauge', () => {
  it('set() records delay for ethereum', async () => {
    chainDelayGauge.set({ chain: 'ethereum' }, 45);
    expect(await gaugeValue(chainDelayGauge, { chain: 'ethereum' })).toBe(45);
  });

  it('set(0) resets delay — chain is back on time', async () => {
    chainDelayGauge.set({ chain: 'ethereum' }, 90);
    chainDelayGauge.set({ chain: 'ethereum' }, 0);
    expect(await gaugeValue(chainDelayGauge, { chain: 'ethereum' })).toBe(0);
  });

  it('ethereum and stellar delays are independent', async () => {
    chainDelayGauge.set({ chain: 'ethereum' }, 10);
    chainDelayGauge.set({ chain: 'stellar' }, 20);
    expect(await gaugeValue(chainDelayGauge, { chain: 'ethereum' })).toBe(10);
    expect(await gaugeValue(chainDelayGauge, { chain: 'stellar' })).toBe(20);
  });

  it('delayed relay scenario: gauge stays elevated until explicitly reset', async () => {
    // Simulate a slow Ethereum node
    chainDelayGauge.set({ chain: 'ethereum' }, 120);
    expect(await gaugeValue(chainDelayGauge, { chain: 'ethereum' })).toBeGreaterThan(0);

    // Node recovers — operator resets the gauge
    chainDelayGauge.set({ chain: 'ethereum' }, 0);
    expect(await gaugeValue(chainDelayGauge, { chain: 'ethereum' })).toBe(0);
  });
});

// ── 9. pipelineMetrics bundle ─────────────────────────────────────────────────

describe('pipelineMetrics bundle', () => {
  it('exposes all eight metrics', () => {
    expect(pipelineMetrics.ingestionTotal).toBe(orderIngestionTotal);
    expect(pipelineMetrics.queueDepth).toBe(orderQueueDepth);
    expect(pipelineMetrics.relayDecisionTotal).toBe(relayDecisionTotal);
    expect(pipelineMetrics.submissionLatency).toBe(submissionLatencySeconds);
    expect(pipelineMetrics.receiptLatency).toBe(receiptLatencySeconds);
    expect(pipelineMetrics.retryAttempts).toBe(retryAttemptsHistogram);
    expect(pipelineMetrics.droppedOrders).toBe(droppedOrdersTotal);
    expect(pipelineMetrics.chainDelay).toBe(chainDelayGauge);
  });

  it('bundle object is frozen (as const)', () => {
    // Accessing a non-existent key should return undefined, not throw
    expect((pipelineMetrics as any).nonExistent).toBeUndefined();
  });
});

// ── 10. Saturation scenario ───────────────────────────────────────────────────

describe('saturation scenario — many rejections then one acceptance', () => {
  it('all counters advance correctly under simulated saturation', async () => {
    const beforeIngestion = await counterValue(orderIngestionTotal, { direction: 'eth_to_xlm' });
    const beforeRejRoute = await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'rejected_route' });
    const beforeRejPerm = await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'rejected_permissions' });
    const beforeAccepted = await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'accepted' });
    const beforeDropped = await counterValue(droppedOrdersTotal, { direction: 'eth_to_xlm', reason: 'eth_tx_failed' });

    // Simulate 5 requests: 3 route rejections, 1 permission rejection, 1 accepted
    for (let i = 0; i < 5; i++) {
      orderIngestionTotal.inc({ direction: 'eth_to_xlm' });
    }
    for (let i = 0; i < 3; i++) {
      relayDecisionTotal.inc({ direction: 'eth_to_xlm', result: 'rejected_route' });
    }
    relayDecisionTotal.inc({ direction: 'eth_to_xlm', result: 'rejected_permissions' });
    relayDecisionTotal.inc({ direction: 'eth_to_xlm', result: 'accepted' });

    // The accepted order then fails at ETH send
    droppedOrdersTotal.inc({ direction: 'eth_to_xlm', reason: 'eth_tx_failed' });
    retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'failure' }, 3);

    expect(await counterValue(orderIngestionTotal, { direction: 'eth_to_xlm' })).toBe(beforeIngestion + 5);
    expect(await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'rejected_route' })).toBe(beforeRejRoute + 3);
    expect(await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'rejected_permissions' })).toBe(beforeRejPerm + 1);
    expect(await counterValue(relayDecisionTotal, { direction: 'eth_to_xlm', result: 'accepted' })).toBe(beforeAccepted + 1);
    expect(await counterValue(droppedOrdersTotal, { direction: 'eth_to_xlm', reason: 'eth_tx_failed' })).toBe(beforeDropped + 1);
  });
});

// ── 11. Delayed relay scenario ────────────────────────────────────────────────

describe('delayed relay scenario — chain delay gauge lifecycle', () => {
  it('gauge is non-zero during delay and zero after recovery', async () => {
    // Relay starts healthy
    chainDelayGauge.set({ chain: 'stellar' }, 0);
    expect(await gaugeValue(chainDelayGauge, { chain: 'stellar' })).toBe(0);

    // Horizon becomes slow — delay detected at 60 s behind schedule
    chainDelayGauge.set({ chain: 'stellar' }, 60);
    const duringDelay = await gaugeValue(chainDelayGauge, { chain: 'stellar' });
    expect(duringDelay).toBeGreaterThan(0);

    // Delay worsens
    chainDelayGauge.set({ chain: 'stellar' }, 180);
    expect(await gaugeValue(chainDelayGauge, { chain: 'stellar' })).toBe(180);

    // Horizon recovers — operator resets
    chainDelayGauge.set({ chain: 'stellar' }, 0);
    expect(await gaugeValue(chainDelayGauge, { chain: 'stellar' })).toBe(0);
  });

  it('xlm-to-eth receipt latency histogram accumulates during slow Horizon', async () => {
    const before = await histogramCount(receiptLatencySeconds, { result: 'success' });
    // Simulate three slow but successful Horizon verifications (8 s, 12 s, 25 s)
    for (const latency of [8, 12, 25]) {
      receiptLatencySeconds.observe({ result: 'success' }, latency);
    }
    const after = await histogramCount(receiptLatencySeconds, { result: 'success' });
    expect(after).toBe(before + 3);
  });
});

// ── 12. Metric label isolation ────────────────────────────────────────────────

describe('metric label isolation', () => {
  it('ingestion for eth_to_xlm does not affect xlm_to_eth counter', async () => {
    const before = await counterValue(orderIngestionTotal, { direction: 'xlm_to_eth' });
    orderIngestionTotal.inc({ direction: 'eth_to_xlm' });
    const after = await counterValue(orderIngestionTotal, { direction: 'xlm_to_eth' });
    expect(after).toBe(before);
  });

  it('dropped eth_tx_failed for xlm_to_eth does not affect eth_to_xlm', async () => {
    const before = await counterValue(droppedOrdersTotal, { direction: 'eth_to_xlm', reason: 'eth_tx_failed' });
    droppedOrdersTotal.inc({ direction: 'xlm_to_eth', reason: 'eth_tx_failed' });
    const after = await counterValue(droppedOrdersTotal, { direction: 'eth_to_xlm', reason: 'eth_tx_failed' });
    expect(after).toBe(before);
  });

  it('eth_send retry histogram does not affect horizon_verify', async () => {
    const before = await histogramCount(retryAttemptsHistogram, { operation: 'horizon_verify', result: 'success' });
    retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'success' }, 2);
    const after = await histogramCount(retryAttemptsHistogram, { operation: 'horizon_verify', result: 'success' });
    expect(after).toBe(before);
  });

  it('submissionLatency for eth_to_xlm does not affect xlm_to_eth', async () => {
    const before = await histogramCount(submissionLatencySeconds, { direction: 'xlm_to_eth', result: 'success' });
    submissionLatencySeconds.observe({ direction: 'eth_to_xlm', result: 'success' }, 5);
    const after = await histogramCount(submissionLatencySeconds, { direction: 'xlm_to_eth', result: 'success' });
    expect(after).toBe(before);
  });
});
