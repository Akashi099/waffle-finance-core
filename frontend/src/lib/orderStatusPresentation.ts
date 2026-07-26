/**
 * Order status presentation layer (issue #317).
 *
 * This module is the single mapping between the bridge lifecycle's internal
 * state representation and what the user sees. The UI never performs raw
 * string comparisons against coordinator state names; instead it calls
 * `presentOrderStatus` and renders the stable UX fields it returns.
 *
 * `translateCoordinatorState` converts raw backend state strings (announced,
 * src_locked, dst_locked, etc.) into the normalised `OrderStatus` enum used
 * by the frontend Transaction model. This means the coordinator can move
 * between internal phases without the UI needing to enumerate every state.
 */

export type OrderStatus =
  | 'pending'
  | 'completed'
  | 'confirmed'
  | 'cancelled'
  | 'failed'
  | 'refunded'
  | 'expired'
  | 'timed_out';

/**
 * Stable, user-facing lifecycle phases.
 *
 * These phases are intentionally coarser than the coordinator's internal
 * state machine so that short-lived intermediary coordinator states (e.g.
 * dst_locked → secret_revealed) do not cause flicker in the UI.
 */
export type UxPhase =
  | 'initiated'
  | 'source_locked'
  | 'destination_locked'
  | 'settling'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'expired';

export interface OrderStatusPresentation {
  phase: UxPhase;
  /** Short label shown in the status badge (e.g. "Pending", "Completed"). */
  label: string;
  /** One-sentence description shown below the badge or in a tooltip. */
  description: string;
  /** Tailwind utility classes for the status badge color. */
  colorClass: string;
  /** Icon name — the component maps this to a Lucide icon. */
  iconName: 'clock' | 'check-circle' | 'x-circle' | 'undo' | 'alert-triangle';
  /** When true the order has reached a terminal state (no more transitions). */
  isTerminal: boolean;
  /** Optional guidance for the user when the order needs attention. */
  recoveryMessage?: string;
}

// ── Raw coordinator → normalised OrderStatus ──────────────────────────────────

const COORDINATOR_STATE_MAP: Record<string, OrderStatus> = {
  announced: 'pending',
  src_locked: 'pending',
  dst_locked: 'pending',
  secret_revealed: 'pending',
  processing: 'pending',
  pending: 'pending',
  completed: 'completed',
  confirmed: 'confirmed',
  cancelled: 'cancelled',
  failed: 'failed',
  expired: 'expired',
  timed_out: 'timed_out',
  refunded: 'refunded',
};

/**
 * Map a raw coordinator lifecycle state string to the normalised `OrderStatus`
 * value used by the frontend.
 *
 * Unknown states default to `'pending'` so partial or future coordinator
 * states never produce an undefined value in the UI.
 */
export function translateCoordinatorState(raw: string): OrderStatus {
  if (!raw || typeof raw !== 'string') return 'pending';
  return COORDINATOR_STATE_MAP[raw.toLowerCase()] ?? 'pending';
}

// ── OrderStatus → UX presentation ────────────────────────────────────────────

/**
 * Translate a normalised `OrderStatus` into a stable UX representation.
 *
 * This is the only place in the frontend that maps status values to colours,
 * labels, and recovery messages. All rendering surfaces (TransactionHistory,
 * order detail panels) must go through this function rather than performing
 * their own status-to-string translations.
 */
export function presentOrderStatus(status: OrderStatus): OrderStatusPresentation {
  switch (status) {
    case 'pending':
      return {
        phase: 'initiated',
        label: 'Pending',
        description: 'Your bridge transaction is being processed by the coordinator.',
        colorClass: 'text-yellow-400 bg-yellow-500/20',
        iconName: 'clock',
        isTerminal: false,
      };

    case 'confirmed':
      return {
        phase: 'completed',
        label: 'Confirmed',
        description: 'Your bridge transaction has been confirmed on both chains.',
        colorClass: 'text-green-400 bg-green-500/20',
        iconName: 'check-circle',
        isTerminal: true,
      };

    case 'completed':
      return {
        phase: 'completed',
        label: 'Completed',
        description: 'Your bridge transaction has been successfully settled.',
        colorClass: 'text-green-400 bg-green-500/20',
        iconName: 'check-circle',
        isTerminal: true,
      };

    case 'cancelled':
      return {
        phase: 'failed',
        label: 'Cancelled',
        description: 'This bridge transaction was cancelled before settlement.',
        colorClass: 'text-gray-400 bg-gray-500/20',
        iconName: 'x-circle',
        isTerminal: true,
      };

    case 'failed':
      return {
        phase: 'failed',
        label: 'Failed',
        description: 'This transaction encountered an error during processing.',
        colorClass: 'text-red-400 bg-red-500/20',
        iconName: 'x-circle',
        isTerminal: true,
        recoveryMessage: 'If funds were locked on-chain you may be eligible for a refund.',
      };

    case 'refunded':
      return {
        phase: 'refunded',
        label: 'Refunded',
        description: 'Your funds have been returned to your source wallet.',
        colorClass: 'text-emerald-400 bg-emerald-500/20',
        iconName: 'undo',
        isTerminal: true,
      };

    case 'expired':
      return {
        phase: 'expired',
        label: 'Expired',
        description: 'The timelock window for this transaction has expired without settlement.',
        colorClass: 'text-orange-400 bg-orange-500/20',
        iconName: 'clock',
        isTerminal: true,
        recoveryMessage: 'You may reclaim your locked funds using the Refund action below.',
      };

    case 'timed_out':
      return {
        phase: 'expired',
        label: 'Timed out',
        description: 'The coordinator did not complete settlement within the expected timelock window.',
        colorClass: 'text-orange-400 bg-orange-500/20',
        iconName: 'clock',
        isTerminal: true,
        recoveryMessage: 'You may reclaim your locked funds using the Refund action below.',
      };

    default: {
      // Exhaustive guard — unknown status from a future coordinator version.
      const _exhaustive: never = status;
      void _exhaustive;
      return {
        phase: 'initiated',
        label: 'Unknown',
        description: 'Transaction status is not yet available. Please refresh.',
        colorClass: 'text-gray-400 bg-gray-500/20',
        iconName: 'clock',
        isTerminal: false,
      };
    }
  }
}
