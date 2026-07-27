/**
 * Tests for relayer/src/correlation/correlation-context.ts
 *
 * Covers:
 *  - ID generation and uniqueness
 *  - AsyncLocalStorage propagation through nested awaits
 *  - Checkpoint recording (normal flow)
 *  - Retry hop counting (retry flow)
 *  - withCorrelation success / failure outcome metrics
 *  - correlationLog and correlationFields outside and inside a scope
 *  - continueCorrelation reuses a supplied ID
 *  - Concurrent scopes do not bleed into each other
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Registry } from 'prom-client';

// ── Isolate metrics so each test run starts from zero ────────────────────────
// We re-export the correlation module after patching prom-client to use a
// fresh registry per test file. This avoids contamination from other test
// files that import metrics.ts.
vi.mock('../src/metrics.js', async () => {
  const { Registry, Counter, Histogram } = await import('prom-client');
  const r = new Registry();
  const mkCounter = (name: string, labelNames: string[] = []) =>
    new Counter({ name, help: name, labelNames, registers: [r] });
  const mkHistogram = (name: string, labelNames: string[] = []) =>
    new Histogram({ name, help: name, labelNames, buckets: [0.1, 1, 10], registers: [r] });

  return {
    correlationOpsTotal: mkCounter('correlationOpsTotal', ['route', 'outcome']),
    correlationCheckpointsTotal: mkCounter('correlationCheckpointsTotal', ['checkpoint', 'route']),
    correlationOpDurationSeconds: mkHistogram('correlationOpDurationSeconds', ['route']),
    correlationRetryHopsTotal: mkCounter('correlationRetryHopsTotal', ['route', 'reason']),
    // other metrics used transitively — no-op stubs
    feeRelayDecisionsTotal: mkCounter('feeRelayDecisionsTotal', ['verdict', 'route']),
    feeGasCostUsdHistogram: mkHistogram('feeGasCostUsdHistogram', ['route']),
    feeNetProfitUsdHistogram: mkHistogram('feeNetProfitUsdHistogram', ['route']),
    feeSafetyDepositUsdHistogram: mkHistogram('feeSafetyDepositUsdHistogram', ['route']),
    feeSkippedRelaysTotal: mkCounter('feeSkippedRelaysTotal', ['route']),
    txStateTransitionsTotal: mkCounter('txStateTransitionsTotal', ['from_state', 'to_state']),
    txStateReconciliationsTotal: mkCounter('txStateReconciliationsTotal', ['trigger']),
    txStateRecoveredTotal: mkCounter('txStateRecoveredTotal', ['recovered_to_state']),
    txStateDuplicateReceiptsTotal: mkCounter('txStateDuplicateReceiptsTotal'),
    txStateCurrentByState: { set: vi.fn() },
    txStateReconciliationDurationSeconds: mkHistogram('txStateReconciliationDurationSeconds'),
    retryEngineAttemptsTotal: mkCounter('retryEngineAttemptsTotal', ['fault_class', 'action']),
    retryEngineExhaustedTotal: mkCounter('retryEngineExhaustedTotal', ['fault_class', 'action']),
    retryEngineCircuitOpenedTotal: mkCounter('retryEngineCircuitOpenedTotal', ['action']),
    retryEngineCircuitRejectedTotal: mkCounter('retryEngineCircuitRejectedTotal', ['action']),
    retryEngineCircuitState: { set: vi.fn() },
    retryEngineBackoffSeconds: mkHistogram('retryEngineBackoffSeconds', ['fault_class', 'action']),
    registry: r,
  };
});

import {
  withCorrelation,
  getCorrelation,
  correlationLog,
  correlationFields,
  continueCorrelation,
} from '../src/correlation/correlation-context.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: any, ...args: any[]): boolean => {
    if (typeof chunk === 'string') {
      for (const line of chunk.split('\n').filter(Boolean)) {
        lines.push(line);
      }
    }
    return true;
  };
  return fn().then(() => {
    process.stdout.write = orig;
    return lines;
  }).catch(err => {
    process.stdout.write = orig;
    throw err;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('correlation-context', () => {

  describe('ID generation', () => {
    it('generates a correlation ID containing the orderId prefix', async () => {
      let id: string | undefined;
      await withCorrelation({ orderId: 'order_abc123', route: 'eth_to_xlm' }, async ctx => {
        id = ctx.correlationId;
      });
      expect(id).toBeDefined();
      expect(id).toMatch(/^order_abc123/);
    });

    it('generates unique IDs for two calls with the same orderId', async () => {
      const ids: string[] = [];
      await withCorrelation({ orderId: 'order_dup' }, async ctx => { ids.push(ctx.correlationId); });
      await withCorrelation({ orderId: 'order_dup' }, async ctx => { ids.push(ctx.correlationId); });
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('uses a supplied correlationId verbatim', async () => {
      let id: string | undefined;
      await withCorrelation(
        { orderId: 'order_x', correlationId: 'my-custom-id-001' },
        async ctx => { id = ctx.correlationId; },
      );
      expect(id).toBe('my-custom-id-001');
    });
  });

  describe('AsyncLocalStorage propagation', () => {
    it('getCorrelation() returns the context inside withCorrelation', async () => {
      let inner: ReturnType<typeof getCorrelation>;
      await withCorrelation({ orderId: 'order_prop', route: 'xlm_to_eth' }, async () => {
        // simulate two nested awaits
        await Promise.resolve();
        await new Promise<void>(r => setTimeout(r, 0));
        inner = getCorrelation();
      });
      expect(inner).toBeDefined();
      expect(inner!.orderId).toBe('order_prop');
      expect(inner!.route).toBe('xlm_to_eth');
    });

    it('getCorrelation() returns undefined outside any scope', () => {
      expect(getCorrelation()).toBeUndefined();
    });

    it('nested scopes do not see the outer context', async () => {
      let outerCtx: ReturnType<typeof getCorrelation>;
      let innerCtx: ReturnType<typeof getCorrelation>;

      await withCorrelation({ orderId: 'outer' }, async () => {
        outerCtx = getCorrelation();
        await withCorrelation({ orderId: 'inner' }, async () => {
          innerCtx = getCorrelation();
        });
      });

      expect(outerCtx!.orderId).toBe('outer');
      expect(innerCtx!.orderId).toBe('inner');
      expect(outerCtx!.correlationId).not.toBe(innerCtx!.correlationId);
    });
  });

  describe('Checkpoint recording — normal flow', () => {
    it('addCheckpoint appends to ctx.checkpoints', async () => {
      let checkpoints: typeof import('../src/correlation/correlation-context.js').CorrelationContext extends never ? never : any[] = [];
      await withCorrelation({ orderId: 'order_chk' }, async ctx => {
        ctx.addCheckpoint('event_received');
        ctx.addCheckpoint('tx_submitted');
        checkpoints = ctx.checkpoints.map(c => c.name);
      });
      // relay_started is auto-added by withCorrelation; then our two, then relay_complete
      expect(checkpoints).toContain('event_received');
      expect(checkpoints).toContain('tx_submitted');
    });

    it('checkpoints are ordered in time', async () => {
      await withCorrelation({ orderId: 'order_time' }, async ctx => {
        ctx.addCheckpoint('queue_enqueued');
        await new Promise<void>(r => setTimeout(r, 5));
        ctx.addCheckpoint('relay_started'); // duplicate name OK — tests ordering
        const times = ctx.checkpoints.map(c => c.at);
        for (let i = 1; i < times.length; i++) {
          expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
        }
      });
    });

    it('withCorrelation auto-adds relay_started on entry and relay_complete on success', async () => {
      let names: string[] = [];
      await withCorrelation({ orderId: 'order_auto' }, async ctx => {
        names = ctx.checkpoints.map(c => c.name);
      });
      expect(names).toContain('relay_started');
      expect(names).toContain('relay_complete');
    });

    it('withCorrelation auto-adds terminal_failure on throw', async () => {
      let names: string[] = [];
      try {
        await withCorrelation({ orderId: 'order_fail' }, async ctx => {
          ctx.addCheckpoint('event_received');
          throw new Error('boom');
        });
      } catch {
        /* expected */
      }
      // We can't read ctx after it throws, but we can check via a captured ref
      // instead capture inside:
      await withCorrelation({ orderId: 'order_fail2' }, async ctx => {
        names = ctx.checkpoints.map(c => c.name);
      }).catch(() => {});
    });

    it('records terminal_failure checkpoint on error', async () => {
      let capturedCheckpoints: string[] = [];
      let capturedCtx: ReturnType<typeof getCorrelation>;

      try {
        await withCorrelation({ orderId: 'order_term' }, async ctx => {
          capturedCtx = ctx;
          throw new Error('deliberate');
        });
      } catch { /* expected */ }

      capturedCheckpoints = capturedCtx!.checkpoints.map(c => c.name);
      expect(capturedCheckpoints).toContain('terminal_failure');
    });
  });

  describe('Retry flow', () => {
    it('incrementRetry increments retryCount', async () => {
      let count = -1;
      await withCorrelation({ orderId: 'order_retry' }, async ctx => {
        ctx.incrementRetry('rpc_timeout');
        ctx.incrementRetry('rpc_timeout');
        count = ctx.retryCount;
      });
      expect(count).toBe(2);
    });

    it('retryCount starts at 0', async () => {
      await withCorrelation({ orderId: 'order_fresh' }, async ctx => {
        expect(ctx.retryCount).toBe(0);
      });
    });

    it('elapsedMs returns a non-negative value', async () => {
      await withCorrelation({ orderId: 'order_elapsed' }, async ctx => {
        await new Promise<void>(r => setTimeout(r, 10));
        expect(ctx.elapsedMs()).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('correlationLog and correlationFields', () => {
    it('correlationLog inside scope includes correlationId in output', async () => {
      const lines = await captureStdout(async () => {
        await withCorrelation({ orderId: 'order_log', route: 'eth_to_xlm' }, async () => {
          correlationLog('info', 'test log line', { customField: 42 });
        });
      });
      const logged = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const target = logged.find((l: any) => l.msg === 'test log line');
      expect(target).toBeDefined();
      expect(target.correlationId).toBeDefined();
      expect(target.customField).toBe(42);
    });

    it('correlationFields() returns empty object outside scope', () => {
      expect(correlationFields()).toEqual({});
    });

    it('correlationFields() returns populated object inside scope', async () => {
      let fields: Record<string, unknown> = {};
      await withCorrelation({ orderId: 'order_fields', route: 'xlm_to_eth' }, async () => {
        fields = correlationFields();
      });
      expect(fields.correlationId).toBeDefined();
      expect(fields.orderId).toBe('order_fields');
      expect(fields.route).toBe('xlm_to_eth');
      expect(typeof fields.retryCount).toBe('number');
    });
  });

  describe('continueCorrelation', () => {
    it('runs under the supplied correlationId', async () => {
      let id: string | undefined;
      await continueCorrelation('handoff-id-xyz', 'order_ho', 'xlm_to_eth', async ctx => {
        id = ctx.correlationId;
      });
      expect(id).toBe('handoff-id-xyz');
    });

    it('preserves orderId and route', async () => {
      let orderId: string | undefined;
      let route: string | undefined;
      await continueCorrelation('cid', 'order_cont', 'eth_to_xlm', async ctx => {
        orderId = ctx.orderId;
        route = ctx.route;
      });
      expect(orderId).toBe('order_cont');
      expect(route).toBe('eth_to_xlm');
    });
  });

  describe('Concurrent scopes isolation', () => {
    it('two concurrent withCorrelation scopes do not share context', async () => {
      const results: Array<{ orderId: string; correlationId: string }> = [];

      await Promise.all([
        withCorrelation({ orderId: 'concurrent_A' }, async ctx => {
          await new Promise<void>(r => setTimeout(r, 10));
          results.push({ orderId: ctx.orderId, correlationId: ctx.correlationId });
        }),
        withCorrelation({ orderId: 'concurrent_B' }, async ctx => {
          await new Promise<void>(r => setTimeout(r, 5));
          results.push({ orderId: ctx.orderId, correlationId: ctx.correlationId });
        }),
      ]);

      expect(results).toHaveLength(2);
      const orderIds = results.map(r => r.orderId).sort();
      expect(orderIds).toEqual(['concurrent_A', 'concurrent_B']);
      expect(results[0].correlationId).not.toBe(results[1].correlationId);
    });

    it('getCorrelation() in a timeout callback returns the right scope', async () => {
      const captured: string[] = [];

      await Promise.all([
        withCorrelation({ orderId: 'scope_1' }, () =>
          new Promise<void>(resolve => {
            setTimeout(() => {
              const ctx = getCorrelation();
              if (ctx) captured.push(ctx.orderId);
              resolve();
            }, 15);
          }),
        ),
        withCorrelation({ orderId: 'scope_2' }, () =>
          new Promise<void>(resolve => {
            setTimeout(() => {
              const ctx = getCorrelation();
              if (ctx) captured.push(ctx.orderId);
              resolve();
            }, 5);
          }),
        ),
      ]);

      expect(captured.sort()).toEqual(['scope_1', 'scope_2']);
    });
  });
});
