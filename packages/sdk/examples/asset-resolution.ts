/**
 * Example: resolving the equivalent asset across a bridge path.
 *
 * The SDK's `Direction` type (@wafflefinance/sdk/types) enumerates six
 * possible pairings across the three supported chains, but the coordinator
 * currently only accepts four of them — `SUPPORTED_DIRECTIONS` from
 * @wafflefinance/sdk/coordinator is the single source of truth for what's
 * actually live:
 *
 *   | Direction    | Live on coordinator? | Resolver                          |
 *   |--------------|-----------------------|-----------------------------------|
 *   | eth_to_xlm   | yes                   | resolveStellarAsset               |
 *   | xlm_to_eth   | yes                   | resolveEthereumToken               |
 *   | eth_to_sol   | yes                   | resolveSolanaAsset                 |
 *   | sol_to_eth   | yes                   | resolveEthereumTokenFromSolana      |
 *   | xlm_to_sol   | not yet               | (no direct resolver — route via ETH)|
 *   | sol_to_xlm   | not yet               | (no direct resolver — route via ETH)|
 *
 * All asset resolvers pivot through Ethereum today, which is why there is no
 * `resolveStellarAssetFromSolana`-style helper: a Stellar<->Solana swap isn't
 * representable as a single coordinator-supported direction yet.
 */

import { SUPPORTED_DIRECTIONS, type CoordinatorDirection } from "../src/coordinator/index.js";
import type { Direction } from "../src/types/index.js";
import {
  resolveStellarAsset,
  resolveEthereumToken,
  resolveSolanaAsset,
  resolveEthereumTokenFromSolana,
  type AssetMappingNetwork,
} from "../src/assets/index.js";

export function isDirectionLive(direction: Direction): direction is CoordinatorDirection {
  return (SUPPORTED_DIRECTIONS as readonly string[]).includes(direction);
}

/**
 * Resolve the destination asset identifier for a given source asset and
 * direction, for the four directions the coordinator currently accepts.
 *
 * @throws {Error} if `direction` is not yet coordinator-supported — check
 *         `isDirectionLive()` first when the direction comes from user input.
 */
export function resolveDestinationAsset(
  direction: CoordinatorDirection,
  srcAsset: string,
  network: AssetMappingNetwork = "testnet"
): string {
  switch (direction) {
    case "eth_to_xlm": {
      const asset = resolveStellarAsset(srcAsset, network);
      return asset.issuer ? `${asset.code}:${asset.issuer}` : asset.code;
    }
    case "xlm_to_eth":
      return resolveEthereumToken(srcAsset, network);
    case "eth_to_sol":
      return resolveSolanaAsset(srcAsset, network).mint;
    case "sol_to_eth":
      return resolveEthereumTokenFromSolana(srcAsset, network);
  }
}
