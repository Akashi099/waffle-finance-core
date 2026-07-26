/**
 * Example: announce a swap order and track it to completion.
 *
 * This walks through the full lifecycle that is identical across every
 * coordinator-supported bridge path (`eth_to_xlm`, `xlm_to_eth`, `eth_to_sol`,
 * `sol_to_eth` — see SUPPORTED_DIRECTIONS in @wafflefinance/sdk/coordinator):
 *
 *   1. Announce the order to the coordinator.
 *   2. Subscribe to status changes (the coordinator has no push transport
 *      today, so OrderSubscriber polls under the hood).
 *   3. React to the secret being revealed and to terminal settlement.
 *
 * The chain-specific steps — locking funds with EthereumHTLCAdapter /
 * SorobanHTLCAdapter / SolanaHTLCAdapter and generating/verifying the
 * preimage with generateSecret/hashSecret — are omitted here because they
 * are already documented per-chain in the top-level README. This example
 * focuses on the coordinator/subscription contract, which is shared by
 * every bridge path.
 *
 * `packages/sdk/test/examples.test.ts` exercises this function against a
 * fake fetch so it keeps compiling and behaving as documented in CI.
 */

import { CoordinatorClient, type CoordinatorAnnounceRequest } from "../src/coordinator/index.js";
import { OrderSubscriber } from "../src/coordinator/index.js";
import type { HistoryRecord } from "../src/coordinator/index.js";

export interface TrackOrderResult {
  publicId: string;
  finalStatus: string;
  secretRevealed: boolean;
}

/**
 * Announce `request` and resolve once the order reaches a terminal status
 * (completed/refunded/failed) or the subscriber is stopped.
 *
 * @param coordinatorBaseUrl Base URL of a running coordinator instance.
 * @param request            Announce payload for one of the supported directions.
 * @param pollIntervalMs     How often to poll for status changes (defaults to the subscriber's own default).
 */
export async function announceAndTrackOrder(
  coordinatorBaseUrl: string,
  request: CoordinatorAnnounceRequest,
  pollIntervalMs?: number
): Promise<TrackOrderResult> {
  const coordinatorClient = new CoordinatorClient({ baseUrl: coordinatorBaseUrl });

  // Local validation runs before the network call — a malformed hashlock or
  // an unsupported direction throws CoordinatorValidationError here rather
  // than surfacing as an opaque 400 from the network.
  const order = await coordinatorClient.announceOrder(request);

  let secretRevealed = false;

  return new Promise<TrackOrderResult>((resolve, reject) => {
    const sub = new OrderSubscriber({
      coordinatorClient,
      orderId: order.id,
      pollIntervalMs,
    });

    sub.on("secretRevealed", () => {
      secretRevealed = true;
    });

    sub.on("settled", (event) => {
      sub.stop();
      resolve({ publicId: order.id, finalStatus: event.finalStatus, secretRevealed });
    });

    sub.on("error", (event) => {
      // Transient poll failures don't stop the subscriber automatically;
      // this example treats repeated failures as fatal for simplicity.
      if (event.consecutiveFailures >= 5) {
        sub.stop();
        reject(event.error);
      }
    });

    sub.start();
  });
}

/** Extract the fields the UI actually needs from a HistoryRecord. */
export function summarizeHistoryRecord(record: HistoryRecord) {
  return {
    id: record.id,
    direction: record.direction,
    status: record.status,
    srcChain: record.src.chain,
    dstChain: record.dst.chain,
  };
}
