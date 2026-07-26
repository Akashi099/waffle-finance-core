/**
 * Bridge form submission state machine (issue #314).
 *
 * Represents the complete bridge form submission lifecycle as an explicit
 * finite state machine. Using a machine rather than ad hoc boolean flags:
 *
 *  - Prevents illegal state combinations (e.g. "submitting" and "completed" at
 *    the same time).
 *  - Provides a durable, serializable snapshot that survives a page reload so
 *    the form can detect and surface an orphaned in-flight submission.
 *  - Makes retry deduplication trivial: only idle or recovery_needed states
 *    accept a new SUBMIT event.
 *
 * The machine is intentionally pure: `transition` has no side effects. Callers
 * are responsible for persisting state via `persistState` and recovering it via
 * `recoverState`.
 */

export type SubmissionPhase =
  /** No submission in progress. Initial and post-reset state. */
  | 'idle'
  /** User triggered submit; waiting for wallet signature or coordinator call. */
  | 'pending_submission'
  /** Coordinator has accepted the order intent and returned an orderId. */
  | 'coordinator_accepted'
  /** The on-chain lock transaction has been confirmed by receipt polling. */
  | 'on_chain_lock_detected'
  /** Cross-chain settlement is in progress on the destination chain. */
  | 'chain_settle_pending'
  /** Bridge lifecycle completed successfully. Terminal state. */
  | 'completed'
  /** Submission failed; user can inspect the error and optionally retry. */
  | 'recovery_needed';

export type SubmissionEvent =
  | { type: 'SUBMIT' }
  | { type: 'COORDINATOR_ACCEPTED'; orderId: string }
  | { type: 'CHAIN_LOCK_DETECTED'; txHash: string }
  | { type: 'SETTLE_PENDING' }
  | { type: 'COMPLETED'; orderId: string; txHash: string }
  | { type: 'FAILURE'; errorCode: string; message: string; retryable: boolean }
  | { type: 'RESET' };

export interface SubmissionState {
  phase: SubmissionPhase;
  orderId?: string;
  txHash?: string;
  statusMessage: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  /** Unix-ms timestamp when the submission was first initiated. */
  submittedAt?: number;
}

const STORAGE_KEY = 'wafflefinance_submission_state_v1';

// Recovered states older than 10 minutes are discarded — the order is almost
// certainly resolved by then and the form should not show a stale notice.
const MAX_RECOVERY_AGE_MS = 10 * 60 * 1000;

export function createIdleState(): SubmissionState {
  return { phase: 'idle', statusMessage: '' };
}

/**
 * Pure transition function.
 *
 * Returns the same `state` reference (no change) for events that are not
 * applicable in the current phase. This makes the machine safe to call even
 * when racing async callbacks arrive out of order.
 */
export function transition(state: SubmissionState, event: SubmissionEvent): SubmissionState {
  switch (event.type) {
    case 'SUBMIT': {
      if (state.phase !== 'idle' && state.phase !== 'recovery_needed') return state;
      return {
        phase: 'pending_submission',
        statusMessage: 'Preparing...',
        submittedAt: Date.now(),
      };
    }

    case 'COORDINATOR_ACCEPTED': {
      if (state.phase !== 'pending_submission') return state;
      return {
        ...state,
        phase: 'coordinator_accepted',
        orderId: event.orderId,
        statusMessage: 'Order accepted...',
      };
    }

    case 'CHAIN_LOCK_DETECTED': {
      if (state.phase !== 'coordinator_accepted') return state;
      return {
        ...state,
        phase: 'on_chain_lock_detected',
        txHash: event.txHash,
        statusMessage: 'On-chain lock confirmed...',
      };
    }

    case 'SETTLE_PENDING': {
      if (state.phase !== 'on_chain_lock_detected') return state;
      return { ...state, phase: 'chain_settle_pending', statusMessage: 'Bridging...' };
    }

    case 'COMPLETED': {
      return {
        phase: 'completed',
        orderId: event.orderId,
        txHash: event.txHash,
        statusMessage: 'Completed ✅',
        submittedAt: state.submittedAt,
      };
    }

    case 'FAILURE': {
      return {
        ...state,
        phase: 'recovery_needed',
        statusMessage: event.message,
        errorCode: event.errorCode,
        errorMessage: event.message,
        retryable: event.retryable,
      };
    }

    case 'RESET': {
      return createIdleState();
    }

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

// ── Derived helpers ───────────────────────────────────────────────────────────

/** True while the submission is actively in-flight (any non-idle, non-terminal phase). */
export function isSubmitting(state: SubmissionState): boolean {
  return (
    state.phase === 'pending_submission' ||
    state.phase === 'coordinator_accepted' ||
    state.phase === 'on_chain_lock_detected' ||
    state.phase === 'chain_settle_pending'
  );
}

/** True when the machine has reached the successful terminal state. */
export function isComplete(state: SubmissionState): boolean {
  return state.phase === 'completed';
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Persist the current state to sessionStorage.
 *
 * Idle and completed states are cleared (there is nothing to recover).
 * All other states are written so a page reload can detect an orphaned
 * in-flight submission and surface a recovery notice.
 */
export function persistState(state: SubmissionState): void {
  try {
    if (state.phase === 'idle' || state.phase === 'completed') {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, submittedAt: state.submittedAt ?? Date.now() }),
    );
  } catch {
    // sessionStorage may be unavailable
  }
}

/**
 * Attempt to recover a persisted in-flight submission from a previous session.
 *
 * Returns null when:
 *  - Nothing is stored.
 *  - The stored data is malformed.
 *  - The stored state is older than MAX_RECOVERY_AGE_MS (10 minutes).
 *  - The stored state is idle or completed (nothing to recover).
 */
export function recoverState(): SubmissionState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SubmissionState>;

    if (!parsed.phase || typeof parsed.submittedAt !== 'number') return null;
    if (parsed.phase === 'idle' || parsed.phase === 'completed') return null;

    if (Date.now() - parsed.submittedAt > MAX_RECOVERY_AGE_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return parsed as SubmissionState;
  } catch {
    return null;
  }
}
