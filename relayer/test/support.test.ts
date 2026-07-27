import { describe, it, expect } from 'vitest';
import {
  buildSupportPolicy,
  classifyToken,
  decideOrderRoute,
  DIRECTION_ROUTES,
  supportSummary,
  type RelayerPolicyConfig,
} from '../src/support.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ETH_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const STELLAR_SECRET = 'SBBQ6HLNPBBXOFMKHZ7KVQSKGDMBVDLXXBIYSNDUDJUP7DKGFFP6JG2C';

function config(overrides: Partial<RelayerPolicyConfig> = {}): RelayerPolicyConfig {
  return {
    network: overrides.network ?? 'testnet',
    ethereum: {
      rpcUrl: 'https://sepolia.infura.io/v3/abc123',
      privateKey: ETH_KEY,
      escrowFactoryAddress: '0x0ABa862Da2F004bCa6ce2990EbC0f77184B6d3a8',
      ...(overrides.ethereum ?? {}),
    },
    stellar: {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      secretKey: STELLAR_SECRET,
      ...(overrides.stellar ?? {}),
    },
  };
}

/** The request body the frontend actually sends for an ETH→XLM swap. */
function ethToXlmRequest(overrides: Record<string, unknown> = {}) {
  return {
    direction: 'eth_to_xlm',
    fromChain: 'ethereum',
    toChain: 'stellar',
    fromToken: 'ETH',
    ...overrides,
  };
}

const POLICY = buildSupportPolicy(config());

// ── Direction mapping ─────────────────────────────────────────────────────────

describe('DIRECTION_ROUTES', () => {
  it('covers both directions the order handler implements', () => {
    expect(Object.keys(DIRECTION_ROUTES).sort()).toEqual(['eth_to_xlm', 'xlm_to_eth']);
    expect(DIRECTION_ROUTES.eth_to_xlm).toEqual({ from: 'ethereum', to: 'stellar' });
    expect(DIRECTION_ROUTES.xlm_to_eth).toEqual({ from: 'stellar', to: 'ethereum' });
  });
});

describe('classifyToken', () => {
  it('recognises each chain native asset', () => {
    expect(classifyToken('ethereum', 'ETH')).toBe('native');
    expect(classifyToken('stellar', 'XLM')).toBe('native');
    expect(classifyToken('solana', 'SOL')).toBe('native');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(classifyToken('ethereum', ' eth ')).toBe('native');
  });

  it('treats anything else as a contract-issued asset of that chain', () => {
    expect(classifyToken('ethereum', 'USDC')).toBe('erc20');
    expect(classifyToken('stellar', 'USDC')).toBe('stellar-asset');
    expect(classifyToken('solana', 'USDC')).toBe('spl');
  });
});

// ── Supported combinations ────────────────────────────────────────────────────

describe('decideOrderRoute — supported', () => {
  it('accepts the ETH→XLM request the frontend sends', () => {
    const decision = decideOrderRoute(POLICY, ethToXlmRequest());
    expect(decision.supported).toBe(true);
    expect(decision.from).toBe('ethereum');
    expect(decision.to).toBe('stellar');
    expect(decision.tokenClass).toBe('native');
  });

  it('accepts the XLM→ETH request the frontend sends', () => {
    const decision = decideOrderRoute(POLICY, {
      direction: 'xlm_to_eth',
      fromChain: 'stellar',
      toChain: 'ethereum',
      fromToken: 'XLM',
    });
    expect(decision.supported).toBe(true);
    expect(decision.from).toBe('stellar');
    expect(decision.to).toBe('ethereum');
  });

  it('accepts chain aliases, so "soroban" and "xlm" are not rejected on a technicality', () => {
    const decision = decideOrderRoute(POLICY, {
      direction: 'xlm_to_eth',
      fromChain: 'soroban',
      toChain: 'eth',
      fromToken: 'XLM',
    });
    expect(decision.supported).toBe(true);
  });

  it('defaults to the native asset class when fromToken is omitted', () => {
    const decision = decideOrderRoute(POLICY, {
      direction: 'eth_to_xlm',
      fromChain: 'ethereum',
      toChain: 'stellar',
    });
    expect(decision.supported).toBe(true);
    expect(decision.tokenClass).toBe('native');
  });

  it('accepts a request that omits the chain fields entirely', () => {
    // direction alone is enough to resolve the route; the chain fields are
    // cross-checks when present, not additional requirements.
    const decision = decideOrderRoute(POLICY, { direction: 'eth_to_xlm', fromToken: 'ETH' });
    expect(decision.supported).toBe(true);
  });
});

// ── Unsupported combinations ──────────────────────────────────────────────────

describe('decideOrderRoute — unsupported chains', () => {
  it('rejects a chain the bridge does not know', () => {
    const decision = decideOrderRoute(
      POLICY,
      ethToXlmRequest({ fromChain: 'bitcoin' })
    );
    expect(decision.supported).toBe(false);
    expect(decision.code).toBe('CHAIN_UNKNOWN');
    expect(decision.reason).toContain('bitcoin');
  });

  it('rejects a Solana source instead of settling it against Ethereum', () => {
    // This is the regression the support policy exists to prevent: before the
    // policy check, fromChain was required to be present and then ignored, so
    // this request was accepted and an Ethereum escrow was built regardless.
    const decision = decideOrderRoute(POLICY, {
      direction: 'eth_to_xlm',
      fromChain: 'solana',
      toChain: 'stellar',
      fromToken: 'SOL',
    });
    expect(decision.supported).toBe(false);
    expect(decision.code).toBe('ROUTE_INCONSISTENT');
    expect(decision.reason).toContain('contradicts direction');
  });

  it('rejects a destination that contradicts the direction', () => {
    const decision = decideOrderRoute(POLICY, ethToXlmRequest({ toChain: 'solana' }));
    expect(decision.supported).toBe(false);
    expect(decision.code).toBe('ROUTE_INCONSISTENT');
    expect(decision.reason).toContain('ends on stellar');
  });

  it('rejects an unknown destination chain', () => {
    const decision = decideOrderRoute(POLICY, ethToXlmRequest({ toChain: 'dogecoin' }));
    expect(decision.supported).toBe(false);
    expect(decision.code).toBe('CHAIN_UNKNOWN');
    expect(decision.reason).toContain('toChain');
  });
});

describe('decideOrderRoute — unsupported directions', () => {
  it.each([
    ['eth-to-xlm', 'the hyphenated spelling used in the history endpoint'],
    ['xlm_to_sol', 'a route with no code path'],
    ['', 'an empty direction'],
  ])('rejects %s (%s)', (direction) => {
    const decision = decideOrderRoute(POLICY, ethToXlmRequest({ direction }));
    expect(decision.supported).toBe(false);
    expect(decision.code).toBe('DIRECTION_UNSUPPORTED');
  });

  it('rejects a missing or non-string direction rather than assuming one', () => {
    for (const direction of [undefined, null, 42, {}]) {
      const decision = decideOrderRoute(POLICY, ethToXlmRequest({ direction }));
      expect(decision.supported).toBe(false);
      expect(decision.code).toBe('DIRECTION_UNSUPPORTED');
    }
  });

  it('lists the directions it does support, so the caller can correct itself', () => {
    const decision = decideOrderRoute(POLICY, ethToXlmRequest({ direction: 'nope' }));
    expect(decision.reason).toContain('eth_to_xlm');
    expect(decision.reason).toContain('xlm_to_eth');
  });
});

describe('decideOrderRoute — unsupported asset classes', () => {
  it('rejects an ERC-20 source instead of silently escrowing native ETH', () => {
    // The order path hard-codes token = address(0), so a USDC request would
    // previously have locked ETH.
    const decision = decideOrderRoute(POLICY, ethToXlmRequest({ fromToken: 'USDC' }));
    expect(decision.supported).toBe(false);
    expect(decision.code).toBe('TOKEN_CLASS_UNSUPPORTED');
    expect(decision.reason).toContain('erc20');
  });

  it('rejects a non-native Stellar asset', () => {
    const decision = decideOrderRoute(POLICY, {
      direction: 'xlm_to_eth',
      fromChain: 'stellar',
      toChain: 'ethereum',
      fromToken: 'yUSDC',
    });
    expect(decision.supported).toBe(false);
    expect(decision.code).toBe('TOKEN_CLASS_UNSUPPORTED');
  });
});

// ── Partially configured runtimes ─────────────────────────────────────────────

describe('decideOrderRoute — partially configured relayer', () => {
  it('refuses every route when the Ethereum signing key is absent', () => {
    const policy = buildSupportPolicy(
      config({
        ethereum: {
          rpcUrl: 'https://sepolia.infura.io/v3/abc123',
          privateKey: '',
          escrowFactoryAddress: '0x0ABa862Da2F004bCa6ce2990EbC0f77184B6d3a8',
        },
      })
    );

    const outbound = decideOrderRoute(policy, ethToXlmRequest());
    expect(outbound.supported).toBe(false);
    expect(outbound.reason).toContain('RELAYER_PRIVATE_KEY');

    const inbound = decideOrderRoute(policy, {
      direction: 'xlm_to_eth',
      fromChain: 'stellar',
      toChain: 'ethereum',
      fromToken: 'XLM',
    });
    expect(inbound.supported).toBe(false);
  });

  it('refuses every route when the escrow factory address is absent', () => {
    const policy = buildSupportPolicy(
      config({
        ethereum: {
          rpcUrl: 'https://sepolia.infura.io/v3/abc123',
          privateKey: ETH_KEY,
          escrowFactoryAddress: null,
        },
      })
    );
    expect(decideOrderRoute(policy, ethToXlmRequest()).supported).toBe(false);
    expect(supportSummary(policy).actionable).toBe(false);
  });

  it('refuses the Stellar leg when the Stellar secret is absent', () => {
    const policy = buildSupportPolicy(
      config({
        stellar: { horizonUrl: 'https://horizon-testnet.stellar.org', secretKey: '' },
      })
    );
    const decision = decideOrderRoute(policy, ethToXlmRequest());
    expect(decision.supported).toBe(false);
    expect(decision.reason).toContain('RELAYER_STELLAR_SECRET');
  });
});

// ── Observability ─────────────────────────────────────────────────────────────

describe('supportSummary', () => {
  it('reports the two supported routes and the refused pairs', () => {
    const summary = supportSummary(POLICY);
    expect(summary.runtime).toBe('relayer');
    expect(summary.actionable).toBe(true);
    expect(summary.routes.map((r) => r.id).sort()).toEqual([
      'ethereum→stellar',
      'stellar→ethereum',
    ]);
    expect(summary.unsupportedRoutes.length).toBe(4);
    for (const refused of summary.unsupportedRoutes) {
      expect(refused.from === 'solana' || refused.to === 'solana').toBe(true);
    }
  });

  it('never includes key material', () => {
    const json = JSON.stringify(supportSummary(POLICY));
    expect(json).not.toContain(ETH_KEY);
    expect(json).not.toContain(STELLAR_SECRET);
    expect(json).not.toContain('infura');
  });

  it('reports the Solana placeholder state so operators are not left guessing', () => {
    const policy = buildSupportPolicy(config(), 'PLACEHOLDER');
    const solana = supportSummary(policy).chains.find((c) => c.chain === 'solana');
    expect(solana?.level).toBe('unimplemented');
    expect(solana?.reason).toContain('placeholder');
  });
});
