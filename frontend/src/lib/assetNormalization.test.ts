import { describe, it, expect } from 'vitest';
import { normalizeAsset, assetsAreEqual, getNativeAsset, type NormalizedAsset } from './assetNormalization';

// ── Native asset recognition ──────────────────────────────────────────────────

describe('normalizeAsset — native assets', () => {
  it('recognises ETH with no address as the canonical native Ethereum asset', () => {
    const asset = normalizeAsset({ chain: 'ethereum', symbol: 'ETH', name: 'Ethereum', decimals: 18 });
    expect(asset.isNative).toBe(true);
    expect(asset.canonicalId).toBe('ethereum:native:ETH');
    expect(asset.address).toBeUndefined();
    expect(asset.symbol).toBe('ETH');
  });

  it('recognises XLM with no address as the canonical native Stellar asset', () => {
    const asset = normalizeAsset({ chain: 'stellar', symbol: 'XLM', name: 'Stellar Lumens', decimals: 7 });
    expect(asset.isNative).toBe(true);
    expect(asset.canonicalId).toBe('stellar:native:XLM');
  });

  it('recognises SOL with no address as the canonical native Solana asset', () => {
    const asset = normalizeAsset({ chain: 'solana', symbol: 'SOL', name: 'Solana', decimals: 9 });
    expect(asset.isNative).toBe(true);
    expect(asset.canonicalId).toBe('solana:native:SOL');
  });

  it('treats ETH with a zero address (0x000...0) as native', () => {
    const asset = normalizeAsset({
      chain: 'ethereum',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      address: '0x0000000000000000000000000000000000000000',
    });
    expect(asset.isNative).toBe(true);
    expect(asset.canonicalId).toBe('ethereum:native:ETH');
  });

  it('treats ETH with an 0x0 shorthand as native', () => {
    const asset = normalizeAsset({ chain: 'ethereum', symbol: 'ETH', name: 'Ethereum', decimals: 18, address: '0x0' });
    expect(asset.isNative).toBe(true);
  });

  it('upper-cases lowercase symbol for native asset lookup', () => {
    const asset = normalizeAsset({ chain: 'ethereum', symbol: 'eth', name: 'Ethereum', decimals: 18 });
    expect(asset.symbol).toBe('ETH');
    expect(asset.isNative).toBe(true);
  });

  it('respects caller-provided logo override for native asset', () => {
    const asset = normalizeAsset({
      chain: 'ethereum',
      symbol: 'ETH',
      name: 'Ethereum',
      decimals: 18,
      logo: '/custom/eth.svg',
    });
    expect(asset.logo).toBe('/custom/eth.svg');
  });

  it('uses the built-in logo when caller omits it for native asset', () => {
    const asset = normalizeAsset({ chain: 'ethereum', symbol: 'ETH', name: 'Ethereum', decimals: 18 });
    expect(asset.logo).toBe('/images/eth.png');
  });
});

// ── Contract asset recognition ────────────────────────────────────────────────

describe('normalizeAsset — contract assets', () => {
  const USDC_ETH_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

  it('normalises a contract address to lowercase', () => {
    const asset = normalizeAsset({
      chain: 'ethereum',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: USDC_ETH_ADDRESS,
    });
    expect(asset.address).toBe(USDC_ETH_ADDRESS.toLowerCase());
    expect(asset.isNative).toBe(false);
  });

  it('builds a canonical id that includes the chain, symbol, and address', () => {
    const asset = normalizeAsset({
      chain: 'ethereum',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: USDC_ETH_ADDRESS,
    });
    expect(asset.canonicalId).toBe(`ethereum:contract:USDC:${USDC_ETH_ADDRESS.toLowerCase()}`);
  });

  it('produces a different canonicalId for USDC on Stellar vs Ethereum', () => {
    const usdcEth = normalizeAsset({
      chain: 'ethereum',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: USDC_ETH_ADDRESS,
    });
    const usdcXlm = normalizeAsset({
      chain: 'stellar',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });
    expect(usdcEth.canonicalId).not.toBe(usdcXlm.canonicalId);
    expect(usdcEth.chain).toBe('ethereum');
    expect(usdcXlm.chain).toBe('stellar');
  });

  it('treats WBTC as a contract asset on Ethereum', () => {
    const asset = normalizeAsset({
      chain: 'ethereum',
      symbol: 'WBTC',
      name: 'Wrapped Bitcoin',
      decimals: 8,
      address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    });
    expect(asset.isNative).toBe(false);
    expect(asset.symbol).toBe('WBTC');
  });

  it('treats a Soroban contract address as a contract asset', () => {
    const asset = normalizeAsset({
      chain: 'stellar',
      symbol: 'yXLM',
      name: 'Yield XLM',
      decimals: 7,
      address: 'GDLQY5ZKDPZWVHWCFSYCBWFPXQTDLJDKTRAOWJGZGQW5KGZFJ3IJIPT',
    });
    expect(asset.isNative).toBe(false);
    expect(asset.canonicalId).toContain('stellar:contract:YXLM:');
  });
});

// ── Symbol collision ──────────────────────────────────────────────────────────

describe('normalizeAsset — symbol collision across chains', () => {
  it('USDC on Ethereum and USDC on Stellar are not equal', () => {
    const a = normalizeAsset({
      chain: 'ethereum', symbol: 'USDC', name: 'USD Coin', decimals: 6,
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    });
    const b = normalizeAsset({
      chain: 'stellar', symbol: 'USDC', name: 'USD Coin', decimals: 6,
      address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });
    expect(assetsAreEqual(a, b)).toBe(false);
  });

  it('native ETH and contract-address ETH with zero address are equal', () => {
    const a = normalizeAsset({ chain: 'ethereum', symbol: 'ETH', name: 'Ethereum', decimals: 18 });
    const b = normalizeAsset({
      chain: 'ethereum', symbol: 'ETH', name: 'Ethereum', decimals: 18,
      address: '0x0000000000000000000000000000000000000000',
    });
    expect(assetsAreEqual(a, b)).toBe(true);
  });
});

// ── assetsAreEqual ────────────────────────────────────────────────────────────

describe('assetsAreEqual', () => {
  it('returns true for two identical normalised assets', () => {
    const a = normalizeAsset({ chain: 'ethereum', symbol: 'ETH', name: 'Ethereum', decimals: 18 });
    const b = normalizeAsset({ chain: 'ethereum', symbol: 'ETH', name: 'Ethereum', decimals: 18 });
    expect(assetsAreEqual(a, b)).toBe(true);
  });

  it('returns false for assets on different chains with the same symbol', () => {
    const a: NormalizedAsset = getNativeAsset('ethereum');
    const b: NormalizedAsset = getNativeAsset('solana');
    expect(assetsAreEqual(a, b)).toBe(false);
  });

  it('returns false for different contract tokens on the same chain', () => {
    const a = normalizeAsset({
      chain: 'ethereum', symbol: 'USDC', name: 'USD Coin', decimals: 6,
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    });
    const b = normalizeAsset({
      chain: 'ethereum', symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8,
      address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    });
    expect(assetsAreEqual(a, b)).toBe(false);
  });
});

// ── getNativeAsset ────────────────────────────────────────────────────────────

describe('getNativeAsset', () => {
  it('returns the canonical native descriptor for each supported chain', () => {
    expect(getNativeAsset('ethereum').canonicalId).toBe('ethereum:native:ETH');
    expect(getNativeAsset('stellar').canonicalId).toBe('stellar:native:XLM');
    expect(getNativeAsset('solana').canonicalId).toBe('solana:native:SOL');
  });

  it('returned assets are native', () => {
    expect(getNativeAsset('ethereum').isNative).toBe(true);
    expect(getNativeAsset('stellar').isNative).toBe(true);
    expect(getNativeAsset('solana').isNative).toBe(true);
  });
});
