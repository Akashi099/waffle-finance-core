/**
 * Chain-aware asset normalization layer (issue #316).
 *
 * `NormalizedAsset` is the stable descriptor that the bridge flow and quote
 * pipeline receive for every token the user can select. It is produced by
 * `normalizeAsset`, which resolves native vs contract identity, normalises the
 * symbol casing, and attaches a `canonicalId` that uniquely identifies the
 * asset across all supported chains.
 *
 * Design goals:
 *  - Deterministic: same input always produces the same `canonicalId`.
 *  - No symbol collisions: USDC on Ethereum and USDC on Stellar get distinct ids.
 *  - Native-asset aware: ETH with no address and ETH with the zero address both
 *    resolve to the canonical native ETH descriptor.
 *  - Extensible: adding Soroban or Solana contract tokens is additive.
 */

export type SupportedChain = 'ethereum' | 'stellar' | 'solana';

export interface NormalizedAsset {
  chain: SupportedChain;
  symbol: string;
  name: string;
  decimals: number;
  /** Contract address for non-native assets; undefined for native assets. */
  address?: string;
  isNative: boolean;
  logo?: string;
  /** Stable unique id: `chain:native:SYMBOL` or `chain:contract:SYMBOL:address`. */
  canonicalId: string;
}

// Well-known native assets. These are returned verbatim (modulo optional logo)
// when a token with a matching chain + symbol has no address.
const NATIVE_ASSETS: Record<SupportedChain, NormalizedAsset> = {
  ethereum: {
    chain: 'ethereum',
    symbol: 'ETH',
    name: 'Ethereum',
    decimals: 18,
    isNative: true,
    logo: '/images/eth.png',
    canonicalId: 'ethereum:native:ETH',
  },
  stellar: {
    chain: 'stellar',
    symbol: 'XLM',
    name: 'Stellar Lumens',
    decimals: 7,
    isNative: true,
    logo: '/images/xlm.png',
    canonicalId: 'stellar:native:XLM',
  },
  solana: {
    chain: 'solana',
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    isNative: true,
    logo: '/images/sol.svg',
    canonicalId: 'solana:native:SOL',
  },
};

function isZeroAddress(address: string): boolean {
  return /^0x0+$/i.test(address) || address === '0x0000000000000000000000000000000000000000';
}

function buildCanonicalId(
  chain: SupportedChain,
  symbol: string,
  address: string | undefined,
): string {
  if (!address) return `${chain}:native:${symbol}`;
  return `${chain}:contract:${symbol}:${address.toLowerCase()}`;
}

/**
 * Produce a normalised, stable asset descriptor from a raw token record.
 *
 * Rules applied in order:
 *  1. Symbol is upper-cased.
 *  2. If the address is absent or zero and the symbol matches the chain's
 *     native asset, the canonical native descriptor is returned.
 *  3. If the address is absent or zero but the symbol does NOT match the known
 *     native asset, the token is still treated as native (isNative: true) with
 *     no address.
 *  4. Otherwise the token is a contract asset; the address is lower-cased to
 *     ensure consistent canonicalId construction.
 */
export function normalizeAsset(raw: {
  chain: SupportedChain;
  symbol: string;
  name: string;
  decimals: number;
  address?: string;
  logo?: string;
}): NormalizedAsset {
  const symbol = raw.symbol.toUpperCase();
  const hasNoAddress = !raw.address || raw.address.trim() === '' || isZeroAddress(raw.address);

  if (hasNoAddress) {
    const nativeCandidate = NATIVE_ASSETS[raw.chain];
    if (nativeCandidate && nativeCandidate.symbol === symbol) {
      return { ...nativeCandidate, logo: raw.logo ?? nativeCandidate.logo };
    }
    // Non-standard native asset (e.g. wrapped native with no address)
    return {
      chain: raw.chain,
      symbol,
      name: raw.name,
      decimals: raw.decimals,
      address: undefined,
      isNative: true,
      logo: raw.logo,
      canonicalId: buildCanonicalId(raw.chain, symbol, undefined),
    };
  }

  const normalizedAddress = raw.address!.toLowerCase();
  return {
    chain: raw.chain,
    symbol,
    name: raw.name,
    decimals: raw.decimals,
    address: normalizedAddress,
    isNative: false,
    logo: raw.logo,
    canonicalId: buildCanonicalId(raw.chain, symbol, normalizedAddress),
  };
}

/** Returns true iff two assets represent the same token on the same chain. */
export function assetsAreEqual(a: NormalizedAsset, b: NormalizedAsset): boolean {
  return a.canonicalId === b.canonicalId;
}

/** Returns the canonical native asset descriptor for the given chain. */
export function getNativeAsset(chain: SupportedChain): NormalizedAsset {
  return NATIVE_ASSETS[chain];
}
