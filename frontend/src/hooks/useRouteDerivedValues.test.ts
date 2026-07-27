// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  useRouteDerivedValues,
  type BridgeDirection,
  type RoutePrices,
} from './useRouteDerivedValues';

const PRICES: RoutePrices = { ethUsd: 3500, xlmUsd: 0.35, solUsd: 150 };
const NULL_PRICES: RoutePrices = { ethUsd: null, xlmUsd: null, solUsd: null };

const ETH = '0x1111111111111111111111111111111111111111';
const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const SOL = '11111111111111111111111111111111';

function renderValues(
  direction: BridgeDirection,
  amount: string,
  eth = ETH,
  stellar = XLM,
  solana = '',
  prices = PRICES,
) {
  return renderHook(
    (props: { d: BridgeDirection; a: string; e: string; s: string; sol: string; p: RoutePrices }) =>
      useRouteDerivedValues({
        direction: props.d,
        amount: props.a,
        ethAddress: props.e,
        stellarAddress: props.s,
        solanaAddress: props.sol,
        prices: props.p,
      }),
    { initialProps: { d: direction, a: amount, e: eth, s: stellar, sol: solana, p: prices } },
  );
}

describe('useRouteDerivedValues — token pair', () => {
  it('returns ETH → XLM for eth_to_xlm', () => {
    const { result } = renderValues('eth_to_xlm', '1');
    expect(result.current.fromToken.symbol).toBe('ETH');
    expect(result.current.toToken.symbol).toBe('XLM');
  });

  it('returns XLM → ETH for xlm_to_eth', () => {
    const { result } = renderValues('xlm_to_eth', '100');
    expect(result.current.fromToken.symbol).toBe('XLM');
    expect(result.current.toToken.symbol).toBe('ETH');
  });

  it('returns ETH → SOL for eth_to_sol', () => {
    const { result } = renderValues('eth_to_sol', '1', ETH, '', SOL);
    expect(result.current.fromToken.symbol).toBe('ETH');
    expect(result.current.toToken.symbol).toBe('SOL');
  });

  it('returns SOL → ETH for sol_to_eth', () => {
    const { result } = renderValues('sol_to_eth', '10', ETH, '', SOL);
    expect(result.current.fromToken.symbol).toBe('SOL');
    expect(result.current.toToken.symbol).toBe('ETH');
  });

  it('fromToken/toToken references are stable across amount changes', () => {
    const { result, rerender } = renderValues('eth_to_xlm', '1');
    const ft = result.current.fromToken;
    const tt = result.current.toToken;

    rerender({ d: 'eth_to_xlm', a: '2', e: ETH, s: XLM, sol: '', p: PRICES });
    expect(result.current.fromToken).toBe(ft);
    expect(result.current.toToken).toBe(tt);
  });
});

describe('useRouteDerivedValues — estimatedAmount', () => {
  it('computes ETH → XLM correctly: 1 ETH at $3500, 1 XLM at $0.35 → 10000 XLM', () => {
    const { result } = renderValues('eth_to_xlm', '1');
    expect(result.current.estimatedAmount).toBe('10000.00');
  });

  it('computes XLM → ETH correctly: 10000 XLM → ~1 ETH', () => {
    const { result } = renderValues('xlm_to_eth', '10000');
    expect(parseFloat(result.current.estimatedAmount)).toBeCloseTo(1, 3);
  });

  it('computes ETH → SOL correctly: 1 ETH at $3500, SOL at $150 → ~23.333 SOL', () => {
    const { result } = renderValues('eth_to_sol', '1', ETH, '', SOL);
    expect(parseFloat(result.current.estimatedAmount)).toBeCloseTo(3500 / 150, 3);
  });

  it('returns empty string when amount is empty', () => {
    const { result } = renderValues('eth_to_xlm', '');
    expect(result.current.estimatedAmount).toBe('');
  });

  it('returns empty string when amount is zero', () => {
    const { result } = renderValues('eth_to_xlm', '0');
    expect(result.current.estimatedAmount).toBe('');
  });

  it('returns empty string when prices are not yet available', () => {
    const { result } = renderValues('eth_to_xlm', '1', ETH, XLM, '', NULL_PRICES);
    expect(result.current.estimatedAmount).toBe('');
  });

  it('updates synchronously when amount changes without re-fetching prices', () => {
    const { result, rerender } = renderValues('eth_to_xlm', '1');
    expect(result.current.estimatedAmount).toBe('10000.00');

    rerender({ d: 'eth_to_xlm', a: '2', e: ETH, s: XLM, sol: '', p: PRICES });
    expect(result.current.estimatedAmount).toBe('20000.00');
  });

  it('updates when prices change without an amount change', () => {
    const { result, rerender } = renderValues('eth_to_xlm', '1');
    expect(result.current.estimatedAmount).toBe('10000.00');

    // ETH rises to $4000
    const newPrices: RoutePrices = { ethUsd: 4000, xlmUsd: 0.35, solUsd: 150 };
    rerender({ d: 'eth_to_xlm', a: '1', e: ETH, s: XLM, sol: '', p: newPrices });
    expect(parseFloat(result.current.estimatedAmount)).toBeCloseTo(4000 / 0.35, 0);
  });
});

describe('useRouteDerivedValues — walletsReady', () => {
  it('is true when ETH + Stellar connected for eth_to_xlm', () => {
    const { result } = renderValues('eth_to_xlm', '1', ETH, XLM);
    expect(result.current.walletsReady).toBe(true);
  });

  it('is false when Stellar wallet is missing for eth_to_xlm', () => {
    const { result } = renderValues('eth_to_xlm', '1', ETH, '');
    expect(result.current.walletsReady).toBe(false);
  });

  it('is true when ETH + Solana connected for eth_to_sol', () => {
    const { result } = renderValues('eth_to_sol', '1', ETH, '', SOL);
    expect(result.current.walletsReady).toBe(true);
  });

  it('is false when ETH is missing for any route', () => {
    const { result } = renderValues('eth_to_xlm', '1', '', XLM);
    expect(result.current.walletsReady).toBe(false);
  });
});

describe('useRouteDerivedValues — unsupportedReasonsByRoute', () => {
  it('includes a reason for routes that require a missing wallet', () => {
    const { result } = renderValues('eth_to_xlm', '1', ETH, '');
    // eth_to_xlm and xlm_to_eth both need Stellar
    expect(result.current.unsupportedReasonsByRoute['eth_to_xlm']).toBeTruthy();
    expect(result.current.unsupportedReasonsByRoute['xlm_to_eth']).toBeTruthy();
  });

  it('is empty when all wallets are connected', () => {
    const { result } = renderValues('eth_to_xlm', '1', ETH, XLM, SOL);
    expect(Object.keys(result.current.unsupportedReasonsByRoute)).toHaveLength(0);
  });

  it('reference is stable across amount changes (addresses unchanged)', () => {
    const { result, rerender } = renderValues('eth_to_xlm', '1');
    const first = result.current.unsupportedReasonsByRoute;

    rerender({ d: 'eth_to_xlm', a: '5', e: ETH, s: XLM, sol: '', p: PRICES });
    expect(result.current.unsupportedReasonsByRoute).toBe(first);
  });

  it('reference changes when an address changes', () => {
    const { result, rerender } = renderValues('eth_to_xlm', '1', ETH, '');
    const first = result.current.unsupportedReasonsByRoute;

    rerender({ d: 'eth_to_xlm', a: '1', e: ETH, s: XLM, sol: '', p: PRICES });
    expect(result.current.unsupportedReasonsByRoute).not.toBe(first);
  });
});
