/**
 * Transforms coordinator wire types to canonical SDK types.
 *
 * The coordinator's `serialiseOrder` projection and the SDK's `Order` type
 * have overlapping but distinct shapes. This module owns the mapping so it
 * lives in exactly one place and is easy to update when either side evolves.
 *
 * Key differences resolved here:
 *   coordinator `id`         → SDK `publicId`
 *   coordinator `secret`     → SDK `preimage` (flattened)
 *   coordinator `ChainLeg`   → SDK `ChainLeg` (lockBlock dropped, safetyDeposit hoisted)
 *   coordinator `resolver`   → dropped (not in SDK Order; available via raw CoordinatorOrder)
 *   coordinator `createdAt`  → dropped (not in SDK Order; available via raw CoordinatorOrder)
 */

import type { Order, ChainLeg } from "../types/index.js";
import type { CoordinatorOrder, CoordinatorChainLeg } from "./contract.js";

/**
 * Map a coordinator chain-leg wire object to the SDK's `ChainLeg` type.
 * `lockBlock` is coordinator-internal (block number) and not surfaced in the
 * SDK type; all other fields are forwarded as-is.
 */
function toLeg(wire: CoordinatorChainLeg): ChainLeg {
  return {
    chain: wire.chain,
    address: wire.address,
    asset: wire.asset,
    amount: wire.amount,
    safetyDeposit: wire.safetyDeposit,
    orderId: wire.orderId,
    lockTx: wire.lockTx,
    timelock: wire.timelock,
  };
}

/**
 * Convert a coordinator order (as returned by any `/api/orders/*` endpoint)
 * into the SDK's canonical `Order` type.
 *
 * The `preimage` field is set from `secret.preimage` when present.
 * Callers that need the full coordinator payload (resolver address, createdAt,
 * updatedAt, lockBlock) should keep the `CoordinatorOrder` alongside the SDK
 * `Order` — this transform is intentionally lossy for fields the SDK doesn't
 * expose.
 */
export function toOrder(wire: CoordinatorOrder): Order {
  return {
    publicId: wire.id,
    direction: wire.direction,
    status: wire.status,
    hashlock: wire.hashlock as `0x${string}`,
    src: toLeg(wire.src),
    dst: toLeg(wire.dst),
    preimage: (wire.secret.preimage as `0x${string}` | null) ?? null,
  };
}

/** Convert an array of coordinator orders to SDK orders. */
export function toOrders(wires: CoordinatorOrder[]): Order[] {
  return wires.map(toOrder);
}
