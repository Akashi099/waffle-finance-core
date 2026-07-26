import { describe, it, expect, beforeEach } from 'vitest';
import {
  createIdleState,
  transition,
  isSubmitting,
  isComplete,
  persistState,
  recoverState,
  type SubmissionState,
  type SubmissionEvent,
} from './submissionStateMachine';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockStorage: Record<string, string> = {};
const STORAGE_KEY = 'wafflefinance_submission_state_v1';

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

function apply(state: SubmissionState, ...events: SubmissionEvent[]): SubmissionState {
  return events.reduce((s, e) => transition(s, e), state);
}

// ── createIdleState ───────────────────────────────────────────────────────────

describe('createIdleState', () => {
  it('returns idle phase with empty status message', () => {
    const s = createIdleState();
    expect(s.phase).toBe('idle');
    expect(s.statusMessage).toBe('');
    expect(s.orderId).toBeUndefined();
    expect(s.txHash).toBeUndefined();
  });
});

// ── Valid transitions ─────────────────────────────────────────────────────────

describe('transition — valid sequence', () => {
  it('idle → pending_submission on SUBMIT', () => {
    const s = transition(createIdleState(), { type: 'SUBMIT' });
    expect(s.phase).toBe('pending_submission');
    expect(s.submittedAt).toBeDefined();
  });

  it('pending_submission → coordinator_accepted on COORDINATOR_ACCEPTED', () => {
    const s = apply(
      createIdleState(),
      { type: 'SUBMIT' },
      { type: 'COORDINATOR_ACCEPTED', orderId: 'ord-123' },
    );
    expect(s.phase).toBe('coordinator_accepted');
    expect(s.orderId).toBe('ord-123');
  });

  it('coordinator_accepted → on_chain_lock_detected on CHAIN_LOCK_DETECTED', () => {
    const s = apply(
      createIdleState(),
      { type: 'SUBMIT' },
      { type: 'COORDINATOR_ACCEPTED', orderId: 'ord-123' },
      { type: 'CHAIN_LOCK_DETECTED', txHash: '0xabc' },
    );
    expect(s.phase).toBe('on_chain_lock_detected');
    expect(s.txHash).toBe('0xabc');
  });

  it('on_chain_lock_detected → chain_settle_pending on SETTLE_PENDING', () => {
    const s = apply(
      createIdleState(),
      { type: 'SUBMIT' },
      { type: 'COORDINATOR_ACCEPTED', orderId: 'ord-123' },
      { type: 'CHAIN_LOCK_DETECTED', txHash: '0xabc' },
      { type: 'SETTLE_PENDING' },
    );
    expect(s.phase).toBe('chain_settle_pending');
  });

  it('any in-flight state → completed on COMPLETED', () => {
    const pending = transition(createIdleState(), { type: 'SUBMIT' });
    const s = transition(pending, { type: 'COMPLETED', orderId: 'ord-999', txHash: '0xfff' });
    expect(s.phase).toBe('completed');
    expect(s.orderId).toBe('ord-999');
    expect(s.txHash).toBe('0xfff');
  });

  it('any state → recovery_needed on FAILURE', () => {
    const pending = transition(createIdleState(), { type: 'SUBMIT' });
    const s = transition(pending, {
      type: 'FAILURE',
      errorCode: 'network_timeout',
      message: 'Network error',
      retryable: true,
    });
    expect(s.phase).toBe('recovery_needed');
    expect(s.errorCode).toBe('network_timeout');
    expect(s.retryable).toBe(true);
  });

  it('recovery_needed → pending_submission on SUBMIT (retry path)', () => {
    const failed = apply(createIdleState(), { type: 'SUBMIT' }, {
      type: 'FAILURE', errorCode: 'network_timeout', message: 'err', retryable: true,
    });
    const retried = transition(failed, { type: 'SUBMIT' });
    expect(retried.phase).toBe('pending_submission');
  });

  it('any state → idle on RESET', () => {
    const inFlight = transition(createIdleState(), { type: 'SUBMIT' });
    expect(transition(inFlight, { type: 'RESET' }).phase).toBe('idle');
  });
});

// ── Invalid transitions (no-op) ───────────────────────────────────────────────

describe('transition — invalid (no-op) transitions', () => {
  it('SUBMIT is ignored when already pending_submission (deduplication)', () => {
    const s = transition(createIdleState(), { type: 'SUBMIT' });
    const s2 = transition(s, { type: 'SUBMIT' });
    expect(s2).toBe(s); // same reference — no change
  });

  it('COORDINATOR_ACCEPTED is ignored when not in pending_submission', () => {
    const idle = createIdleState();
    const s = transition(idle, { type: 'COORDINATOR_ACCEPTED', orderId: 'x' });
    expect(s).toBe(idle);
  });

  it('CHAIN_LOCK_DETECTED is ignored when not in coordinator_accepted', () => {
    const pending = transition(createIdleState(), { type: 'SUBMIT' });
    const s = transition(pending, { type: 'CHAIN_LOCK_DETECTED', txHash: '0x1' });
    expect(s).toBe(pending);
  });

  it('SETTLE_PENDING is ignored when not in on_chain_lock_detected', () => {
    const pending = transition(createIdleState(), { type: 'SUBMIT' });
    const s = transition(pending, { type: 'SETTLE_PENDING' });
    expect(s).toBe(pending);
  });

  it('SUBMIT is ignored when already completed', () => {
    const completed = apply(
      createIdleState(),
      { type: 'SUBMIT' },
      { type: 'COMPLETED', orderId: 'o', txHash: 'h' },
    );
    const s = transition(completed, { type: 'SUBMIT' });
    expect(s).toBe(completed);
  });
});

// ── isSubmitting / isComplete ─────────────────────────────────────────────────

describe('isSubmitting', () => {
  it('is false for idle state', () => {
    expect(isSubmitting(createIdleState())).toBe(false);
  });

  it('is true for all in-flight phases', () => {
    const phases: SubmissionState['phase'][] = [
      'pending_submission', 'coordinator_accepted', 'on_chain_lock_detected', 'chain_settle_pending',
    ];
    for (const phase of phases) {
      expect(isSubmitting({ phase, statusMessage: '' })).toBe(true);
    }
  });

  it('is false for completed and recovery_needed', () => {
    expect(isSubmitting({ phase: 'completed', statusMessage: '' })).toBe(false);
    expect(isSubmitting({ phase: 'recovery_needed', statusMessage: '' })).toBe(false);
  });
});

describe('isComplete', () => {
  it('is true only for completed phase', () => {
    expect(isComplete({ phase: 'completed', statusMessage: '' })).toBe(true);
  });

  it('is false for all other phases', () => {
    const otherPhases: SubmissionState['phase'][] = [
      'idle', 'pending_submission', 'coordinator_accepted',
      'on_chain_lock_detected', 'chain_settle_pending', 'recovery_needed',
    ];
    for (const phase of otherPhases) {
      expect(isComplete({ phase, statusMessage: '' })).toBe(false);
    }
  });
});

// ── persistState / recoverState ───────────────────────────────────────────────

describe('persistState', () => {
  it('writes in-flight states to sessionStorage', () => {
    const s: SubmissionState = {
      phase: 'coordinator_accepted',
      orderId: 'ord-42',
      statusMessage: 'Order accepted...',
      submittedAt: Date.now(),
    };
    persistState(s);
    expect(mockStorage[STORAGE_KEY]).toBeDefined();
    const parsed = JSON.parse(mockStorage[STORAGE_KEY]);
    expect(parsed.phase).toBe('coordinator_accepted');
    expect(parsed.orderId).toBe('ord-42');
  });

  it('removes the key for idle state', () => {
    mockStorage[STORAGE_KEY] = '{"phase":"pending_submission"}';
    persistState(createIdleState());
    expect(mockStorage[STORAGE_KEY]).toBeUndefined();
  });

  it('removes the key for completed state', () => {
    mockStorage[STORAGE_KEY] = '{"phase":"coordinator_accepted"}';
    persistState({ phase: 'completed', statusMessage: 'done', orderId: 'x', txHash: 'h' });
    expect(mockStorage[STORAGE_KEY]).toBeUndefined();
  });

  it('writes submittedAt if not already set on the state', () => {
    const s: SubmissionState = { phase: 'pending_submission', statusMessage: 'P' };
    persistState(s);
    const parsed = JSON.parse(mockStorage[STORAGE_KEY]);
    expect(typeof parsed.submittedAt).toBe('number');
  });
});

describe('recoverState', () => {
  it('returns null when sessionStorage is empty', () => {
    expect(recoverState()).toBeNull();
  });

  it('returns null for malformed data', () => {
    mockStorage[STORAGE_KEY] = 'not-json';
    expect(recoverState()).toBeNull();
  });

  it('returns null when phase is missing', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify({ submittedAt: Date.now() });
    expect(recoverState()).toBeNull();
  });

  it('returns null for idle stored state', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify({ phase: 'idle', statusMessage: '', submittedAt: Date.now() });
    expect(recoverState()).toBeNull();
  });

  it('returns null for completed stored state', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify({ phase: 'completed', statusMessage: '', submittedAt: Date.now() });
    expect(recoverState()).toBeNull();
  });

  it('returns the stored state when it is a recent in-flight submission', () => {
    const state: SubmissionState = {
      phase: 'coordinator_accepted',
      orderId: 'ord-77',
      statusMessage: 'In flight',
      submittedAt: Date.now() - 30_000, // 30 seconds ago — within 10 min limit
    };
    mockStorage[STORAGE_KEY] = JSON.stringify(state);
    const recovered = recoverState();
    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe('coordinator_accepted');
    expect(recovered!.orderId).toBe('ord-77');
  });

  it('returns null and clears storage when state is older than 10 minutes', () => {
    const oldSubmittedAt = Date.now() - 11 * 60 * 1000; // 11 minutes ago
    mockStorage[STORAGE_KEY] = JSON.stringify({
      phase: 'pending_submission',
      statusMessage: 'old',
      submittedAt: oldSubmittedAt,
    });
    expect(recoverState()).toBeNull();
    expect(mockStorage[STORAGE_KEY]).toBeUndefined();
  });

  it('recovers recovery_needed state so user can see prior error on reload', () => {
    const state: SubmissionState = {
      phase: 'recovery_needed',
      statusMessage: 'Network error',
      errorCode: 'network_timeout',
      retryable: true,
      submittedAt: Date.now() - 60_000,
    };
    mockStorage[STORAGE_KEY] = JSON.stringify(state);
    const recovered = recoverState();
    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe('recovery_needed');
    expect(recovered!.errorCode).toBe('network_timeout');
  });
});

// ── Full round-trip: persist → recover ───────────────────────────────────────

describe('persist + recover round-trip', () => {
  it('round-trips a coordinator_accepted state through storage', () => {
    const state: SubmissionState = {
      phase: 'coordinator_accepted',
      orderId: 'ord-round',
      statusMessage: 'In flight',
      submittedAt: Date.now() - 5_000,
    };
    persistState(state);
    const recovered = recoverState();
    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe('coordinator_accepted');
    expect(recovered!.orderId).toBe('ord-round');
  });

  it('reset clears persisted state so recovery returns null', () => {
    const state: SubmissionState = {
      phase: 'pending_submission',
      statusMessage: 'P',
      submittedAt: Date.now(),
    };
    persistState(state);
    persistState(transition(state, { type: 'RESET' }));
    expect(recoverState()).toBeNull();
  });
});
