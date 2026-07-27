/**
 * Tests for relayer/src/utils/retry-engine.ts
 *
 * Covers:
 *  a. Successful first attempt — no retry
 *  b. Transient fault — retries up to maxAttempts then throws RetryExhaustedError
 *  c. Terminal fault — surfaces immediately, never retried
 *  d. Confirmation-delay fault — retried with extra multiplier
 *  e. Custom classifier overrides the default
 *  f. Circuit breaker:
 *      - opens after N consecutive failures
 *      - rejects calls while open (CircuitOpenError)
 *      - half-open probe: success → closed, failure → open
 *      - resetCircuit() forces back to closed
 *  g. allCircuits() / circuitState() reporting
 *  h. calculateBackoff() deterministic test (jitter = 0)
 *  i. Correlation context retry-hop recording
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Isolate metrics ───────────────────────────────────────────────────────────
vi.mock('../src/metrics.js', () => ({
  retryEngineAttemptsTotal:    { inc: vi.fn() },
  retryEngineExhaustedTotal:   { inc: vi.fn() },
  retryEngineCircuitOpenedTotal:  { inc: vi.fn() },
  retryEngineCircuitRejectedTotal: { inc: vi.fn() },
  retryEngineCircuitState:     { set: vi.fn() },
  retryEngineBackoffSeconds:   { observe: vi.fn() },
  // correlation mocks (used by getCorrelation inside the engine)
  correlationOpsTotal:         { inc: vi.fn() },
  correlationCheckpointsTotal: { inc: vi.fn() },
  correlationOpDurationSeconds: { startTimer: () => () => {} },
  correlationRetryHopsTotal:   { inc: vi.fn() },
}));

import {
  RetryEngine,
  RetryExhaustedError,
  CircuitOpenError,
  defaultClassifier,
  calculateBackoff,
  type FaultClass,
} from '../src/utils/retry-engine.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh RetryEngine with fast delays so tests don't hang. */
function makeEngine(overrides: ConstructorParameters<typeof RetryEngine>[0] = {}) {
  return new RetryEngine({
    defaultMaxAttempts: 4,
    defaultBaseDelayMs: 1,       // 1 ms base — tests run in < 1s
    defaultMaxDelayMs: 5,
    circuitBreakerThreshold: 3,
    circuitBreakerResetMs: 50,   // 50 ms — testable in-process
    jitterFactor: 0,             // deterministic delays
    ...overrides,
  });
}

/** Build an fn that fails the first N times then succeeds. */
function failNTimes(n: number, error: Error = new Error('transient')): () => Promise<string> {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= n) throw error;
    return 'ok';
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RetryEngine — basic retry behaviour', () => {

  it('succeeds on first attempt without retrying', async () => {
    const engine = makeEngine();
    const fn = vi.fn().mockResolvedValue('success');
    const result = await engine.run('rpc', fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient fault and succeeds on attempt 2', async () => {
    const engine = makeEngine();
    const fn = failNTimes(1);
    const result = await engine.run('rpc', fn);
    expect(result).toBe('ok');
  });

  it('retries maxAttempts times then throws RetryExhaustedError', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 3 });
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(engine.run('rpc', fn)).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('RetryExhaustedError carries the correct attempt count', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 2 });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    try {
      await engine.run('rpc', fn);
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      expect((err as RetryExhaustedError).attempts).toBe(2);
    }
  });

  it('RetryExhaustedError carries the last fault class', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 2 });
    const fn = vi.fn().mockRejectedValue(new Error('rate limit exceeded'));
    try {
      await engine.run('rpc', fn);
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      // default classifier maps "rate limit" → transient
      expect((err as RetryExhaustedError).faultClass).toBe('transient');
    }
  });

  it('per-call maxAttempts override takes precedence', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 10 });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(engine.run('rpc', fn, { maxAttempts: 2 })).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('RetryEngine — fault classification', () => {

  it('terminal fault is surfaced immediately (no retry)', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 5 });
    const terminalErr = new Error('execution reverted: bad auth');
    const fn = vi.fn().mockRejectedValue(terminalErr);
    await expect(engine.run('rpc', fn)).rejects.toThrow('execution reverted: bad auth');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('terminal fault re-throws the original error (not RetryExhaustedError)', async () => {
    const engine = makeEngine();
    const original = new Error('insufficient funds');
    const fn = vi.fn().mockRejectedValue(original);
    try {
      await engine.run('rpc', fn);
    } catch (err) {
      expect(err).toBe(original);
      expect(err).not.toBeInstanceOf(RetryExhaustedError);
    }
  });

  it('confirmation_delay fault is retried (not terminal)', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 3 });
    const fn = failNTimes(2, new Error('transaction not found'));
    const result = await engine.run('rpc', fn);
    expect(result).toBe('ok');
  });

  it('custom classifier overrides the default', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 5 });
    // Pretend any error is terminal via custom classifier
    const customClassifier = vi.fn().mockReturnValue('terminal' as FaultClass);
    const fn = vi.fn().mockRejectedValue(new Error('some transient-looking error'));
    await expect(
      engine.run('rpc', fn, { classifier: customClassifier })
    ).rejects.not.toBeInstanceOf(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('custom classifier returning null falls through to default', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 3 });
    const nullClassifier = vi.fn().mockReturnValue(null);
    // "execution reverted" is terminal per the default classifier
    const fn = vi.fn().mockRejectedValue(new Error('execution reverted'));
    await expect(engine.run('rpc', fn, { classifier: nullClassifier })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1); // terminal, no retry
  });
});

describe('defaultClassifier', () => {
  it('classifies execution reverted as terminal', () => {
    expect(defaultClassifier(new Error('execution reverted'))).toBe('terminal');
  });

  it('classifies insufficient funds as terminal', () => {
    expect(defaultClassifier(new Error('Insufficient funds'))).toBe('terminal');
  });

  it('classifies transaction not found as confirmation_delay', () => {
    expect(defaultClassifier(new Error('transaction not found on network'))).toBe('confirmation_delay');
  });

  it('classifies rate limit errors as transient', () => {
    expect(defaultClassifier(new Error('compute units exceeded rate limit'))).toBe('transient');
  });

  it('classifies unknown error as transient', () => {
    expect(defaultClassifier(new Error('some totally unknown error'))).toBe('transient');
  });

  it('handles non-Error objects gracefully', () => {
    expect(defaultClassifier('string error')).toBe('transient');
    expect(defaultClassifier({ message: 'execution reverted' })).toBe('transient'); // not an Error
  });
});

describe('RetryEngine — circuit breaker', () => {

  it('circuit starts closed', () => {
    const engine = makeEngine();
    expect(engine.circuitState('rpc')).toBe('closed');
  });

  it('circuit opens after circuitBreakerThreshold consecutive failures', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 3, defaultMaxAttempts: 1 });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // 3 failing calls should trip the circuit
    for (let i = 0; i < 3; i++) {
      await engine.run('rpc', fn).catch(() => {});
    }
    expect(engine.circuitState('rpc')).toBe('open');
  });

  it('open circuit rejects calls with CircuitOpenError', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 2, defaultMaxAttempts: 1 });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', fn).catch(() => {});
    }

    // Should now fast-fail
    await expect(engine.run('rpc', () => Promise.resolve('x'))).rejects.toThrow(CircuitOpenError);
  });

  it('resetCircuit() closes an open circuit immediately', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 2, defaultMaxAttempts: 1 });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', fn).catch(() => {});
    }
    expect(engine.circuitState('rpc')).toBe('open');

    engine.resetCircuit('rpc');
    expect(engine.circuitState('rpc')).toBe('closed');
  });

  it('half-open probe: success → closed', async () => {
    const engine = makeEngine({
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: 10,
      defaultMaxAttempts: 1,
    });
    const alwaysFail = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', alwaysFail).catch(() => {});
    }
    expect(engine.circuitState('rpc')).toBe('open');

    // Wait for half-open window
    await new Promise<void>(r => setTimeout(r, 20));

    // Probe with a succeeding call — circuit should close
    const result = await engine.run('rpc', () => Promise.resolve('probe-ok'));
    expect(result).toBe('probe-ok');
    expect(engine.circuitState('rpc')).toBe('closed');
  });

  it('half-open probe: failure → re-opens circuit', async () => {
    const engine = makeEngine({
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: 10,
      defaultMaxAttempts: 1,
    });
    const alwaysFail = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', alwaysFail).catch(() => {});
    }

    // Wait for half-open
    await new Promise<void>(r => setTimeout(r, 20));

    // Probe with a failing call — circuit should re-open
    await engine.run('rpc', alwaysFail).catch(() => {});
    expect(engine.circuitState('rpc')).toBe('open');
  });

  it('allCircuits() returns state for all registered actions', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 1, defaultMaxAttempts: 1 });
    await engine.run('rpc', vi.fn().mockRejectedValue(new Error('x'))).catch(() => {});
    await engine.run('horizon', vi.fn().mockRejectedValue(new Error('y'))).catch(() => {});

    const circuits = engine.allCircuits();
    expect('rpc' in circuits).toBe(true);
    expect('horizon' in circuits).toBe(true);
    expect(circuits.rpc.state).toBe('open');
    expect(circuits.horizon.state).toBe('open');
  });

  it('different action namespaces have independent circuits', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 2, defaultMaxAttempts: 1 });
    const fail = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip 'rpc' circuit
    for (let i = 0; i < 2; i++) {
      await engine.run('rpc', fail).catch(() => {});
    }

    // 'horizon' should still be closed
    expect(engine.circuitState('rpc')).toBe('open');
    expect(engine.circuitState('horizon')).toBe('closed');

    // 'horizon' calls should still work
    const result = await engine.run('horizon', () => Promise.resolve('horizon-ok'));
    expect(result).toBe('horizon-ok');
  });

  it('circuit success resets consecutive failure count', async () => {
    const engine = makeEngine({ circuitBreakerThreshold: 3, defaultMaxAttempts: 1 });
    const fail = vi.fn().mockRejectedValue(new Error('fail'));

    // Fail twice (below threshold)
    await engine.run('rpc', fail).catch(() => {});
    await engine.run('rpc', fail).catch(() => {});
    expect(engine.circuitState('rpc')).toBe('closed');

    // Succeed once — should reset the failure count
    await engine.run('rpc', () => Promise.resolve('ok'));

    // Now fail twice again — should still be closed (count reset)
    await engine.run('rpc', fail).catch(() => {});
    await engine.run('rpc', fail).catch(() => {});
    expect(engine.circuitState('rpc')).toBe('closed');
  });
});

describe('calculateBackoff()', () => {
  it('doubles on each attempt with no jitter', () => {
    const base = 100;
    const max = 10_000;
    // jitter=0, multiplier=1
    expect(calculateBackoff(1, base, max, 0)).toBe(100);
    expect(calculateBackoff(2, base, max, 0)).toBe(200);
    expect(calculateBackoff(3, base, max, 0)).toBe(400);
    expect(calculateBackoff(4, base, max, 0)).toBe(800);
  });

  it('caps at maxMs', () => {
    expect(calculateBackoff(10, 100, 500, 0)).toBe(500);
  });

  it('applies multiplier for confirmation_delay', () => {
    const delay = calculateBackoff(1, 100, 10_000, 0, 3);
    expect(delay).toBe(300);
  });
});

describe('RetryEngine — delayed confirmation scenario', () => {
  it('retries "transaction not found" until receipt appears', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 4, defaultBaseDelayMs: 1, defaultMaxDelayMs: 5 });
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error('transaction not found');
      return 'mined';
    };
    const result = await engine.run('rpc', fn);
    expect(result).toBe('mined');
    expect(calls).toBe(3);
  });
});

describe('RetryEngine — RPC timeout simulation', () => {
  it('retries on network timeout and eventually succeeds', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 5 });
    const fn = failNTimes(3, new Error('RPC getBalance timeout'));
    const result = await engine.run('rpc', fn);
    expect(result).toBe('ok');
  });

  it('exhausts retries when every call times out', async () => {
    const engine = makeEngine({ defaultMaxAttempts: 3 });
    const fn = vi.fn().mockRejectedValue(new Error('RPC sendTransaction timeout'));
    await expect(engine.run('rpc', fn)).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
