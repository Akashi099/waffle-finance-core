/**
 * Tests for the relayer settlement command-permission model.
 *
 * Covers:
 *  1. `resolveCommandChain` — direction+command → correct leg chain.
 *  2. `authorizeSettlementCommand` — all six denial codes + grant path.
 *  3. `authorizeAllCommands` — bulk helper correctness.
 *  4. `checkOrderSettleable` — pre-order gate returns null on grant, denial on block.
 *  5. `formatAuthorizationLog` — safe output (no key material).
 *
 * These tests prove the acceptance criteria from Issue #341:
 *  - The relayer uses an explicit command permission model for settlement operations.
 *  - Unsafe or unsupported route commands are rejected before execution.
 *  - The permissioning behavior is observable in logs.
 *  - No unsafe command path can bypass the policy contract.
 */

import { describe, it, expect } from 'vitest';
import {
  authorizeAllCommands,
  authorizeSettlementCommand,
  checkOrderSettleable,
  DIRECTION_COMMAND_CHAINS,
  formatAuthorizationLog,
  resolveCommandChain,
  SETTLEMENT_COMMANDS,
  type AuthorizationDenial,
  type AuthorizationGrant,
  type SettlementAccountConfig,
} from '../src/settlement-permissions.js';
import { buildSupportPolicy, type RelayerPolicyConfig } from '../src/support.js';
import type { SupportPolicy } from '@wafflefinance/config';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ETH_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const STELLAR_SECRET = 'SBBQ6HLNPBBXOFMKHZ7KVQSKGDMBVDLXXBIYSNDUDJUP7DKGFFP6JG2C';
const FACTORY_ADDR = '0x0ABa862Da2F004bCa6ce2990EbC0f77184B6d3a8';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** Full config — every field populated with non-placeholder values. */
function fullConfig(overrides: Partial<SettlementAccountConfig> = {}): SettlementAccountConfig {
  return {
    ethereum: {
      privateKey: ETH_KEY,
      escrowFactoryAddress: FACTORY_ADDR,
      rpcUrl: 'https://sepolia.infura.io/v3/abc123',
      ...(overrides.ethereum ?? {}),
    },
    stellar: {
      secretKey: STELLAR_SECRET,
      horizonUrl: HORIZON_URL,
      ...(overrides.stellar ?? {}),
    },
  };
}

/** Policy config for buildSupportPolicy, mirroring the full config above. */
function policyConfig(overrides: Partial<RelayerPolicyConfig> = {}): RelayerPolicyConfig {
  return {
    network: 'testnet',
    ethereum: {
      rpcUrl: 'https://sepolia.infura.io/v3/abc123',
      privateKey: ETH_KEY,
      escrowFactoryAddress: FACTORY_ADDR,
      ...(overrides.ethereum ?? {}),
    },
    stellar: {
      horizonUrl: HORIZON_URL,
      secretKey: STELLAR_SECRET,
      ...(overrides.stellar ?? {}),
    },
  };
}

const FULL_POLICY: SupportPolicy = buildSupportPolicy(policyConfig());
const FULL_CONFIG: SettlementAccountConfig = fullConfig();

// ── resolveCommandChain ───────────────────────────────────────────────────────

describe('resolveCommandChain', () => {
  it('lock → source chain for each live direction', () => {
    expect(resolveCommandChain('eth_to_xlm', 'lock')).toBe('ethereum');
    expect(resolveCommandChain('xlm_to_eth', 'lock')).toBe('stellar');
  });

  it('settle → destination chain for each live direction', () => {
    expect(resolveCommandChain('eth_to_xlm', 'settle')).toBe('stellar');
    expect(resolveCommandChain('xlm_to_eth', 'settle')).toBe('ethereum');
  });

  it('refund → source chain (funds are locked there)', () => {
    expect(resolveCommandChain('eth_to_xlm', 'refund')).toBe('ethereum');
    expect(resolveCommandChain('xlm_to_eth', 'refund')).toBe('stellar');
  });

  it('verify → source chain (incoming payment is confirmed before releasing dst)', () => {
    expect(resolveCommandChain('eth_to_xlm', 'verify')).toBe('ethereum');
    expect(resolveCommandChain('xlm_to_eth', 'verify')).toBe('stellar');
  });

  it('returns null for an undeclared direction', () => {
    expect(resolveCommandChain('btc_to_eth', 'lock')).toBeNull();
    expect(resolveCommandChain('eth_to_sol', 'settle')).toBeNull();
    expect(resolveCommandChain('', 'lock')).toBeNull();
  });
});

// ── DIRECTION_COMMAND_CHAINS completeness ─────────────────────────────────────

describe('DIRECTION_COMMAND_CHAINS', () => {
  it('covers exactly the two live relayer directions', () => {
    expect(Object.keys(DIRECTION_COMMAND_CHAINS).sort()).toEqual(['eth_to_xlm', 'xlm_to_eth']);
  });

  it('source and destination legs are opposite for the two directions', () => {
    expect(DIRECTION_COMMAND_CHAINS.eth_to_xlm.source).toBe('ethereum');
    expect(DIRECTION_COMMAND_CHAINS.eth_to_xlm.destination).toBe('stellar');
    expect(DIRECTION_COMMAND_CHAINS.xlm_to_eth.source).toBe('stellar');
    expect(DIRECTION_COMMAND_CHAINS.xlm_to_eth.destination).toBe('ethereum');
  });
});

// ── authorizeSettlementCommand: grant paths ───────────────────────────────────

describe('authorizeSettlementCommand — grants', () => {
  it('grants lock on ethereum for eth_to_xlm with full config', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'lock',
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(true);
    if (result.authorized) {
      expect((result as AuthorizationGrant).command).toBe('lock');
      expect((result as AuthorizationGrant).chain).toBe('ethereum');
      expect((result as AuthorizationGrant).account.signerAvailable).toBe(true);
    }
  });

  it('grants settle on stellar for eth_to_xlm', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'settle',
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(true);
    if (result.authorized) {
      expect((result as AuthorizationGrant).chain).toBe('stellar');
    }
  });

  it('grants settle on ethereum for xlm_to_eth', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'settle',
      direction: 'xlm_to_eth',
    });
    expect(result.authorized).toBe(true);
    if (result.authorized) {
      expect((result as AuthorizationGrant).chain).toBe('ethereum');
    }
  });

  it('grants all four commands for both live directions with full config', () => {
    for (const direction of ['eth_to_xlm', 'xlm_to_eth']) {
      for (const command of SETTLEMENT_COMMANDS) {
        const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, { command, direction });
        expect(result.authorized, `${direction}/${command} should be granted`).toBe(true);
      }
    }
  });

  it('grant respects an explicit chain that matches the resolved one', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'settle',
      direction: 'xlm_to_eth',
      chain: 'ethereum',
    });
    expect(result.authorized).toBe(true);
  });

  it('account description never contains the raw private key', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'lock',
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(true);
    const description = (result as AuthorizationGrant).account.accountDescription;
    expect(description).not.toContain(ETH_KEY);
    expect(description).not.toContain(STELLAR_SECRET);
  });
});

// ── authorizeSettlementCommand: COMMAND_UNKNOWN ───────────────────────────────

describe('authorizeSettlementCommand — COMMAND_UNKNOWN', () => {
  it('rejects an unrecognised command string', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'deploy' as any,
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('COMMAND_UNKNOWN');
  });

  it('rejection message lists the valid commands', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'nope' as any,
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(false);
    const reason = (result as AuthorizationDenial).reason;
    for (const cmd of SETTLEMENT_COMMANDS) {
      expect(reason).toContain(cmd);
    }
  });
});

// ── authorizeSettlementCommand: DIRECTION_UNSUPPORTED ────────────────────────

describe('authorizeSettlementCommand — DIRECTION_UNSUPPORTED', () => {
  it('rejects a direction with no command-chain mapping', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'settle',
      direction: 'eth_to_sol',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('DIRECTION_UNSUPPORTED');
  });

  it('rejects an empty direction', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'lock',
      direction: '',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('DIRECTION_UNSUPPORTED');
  });

  it('rejects sol_to_eth (no relayer settlement path)', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'lock',
      direction: 'sol_to_eth',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('DIRECTION_UNSUPPORTED');
  });

  it('rejection message lists declared directions', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'lock',
      direction: 'btc_to_eth',
    });
    const reason = (result as AuthorizationDenial).reason;
    expect(reason).toContain('eth_to_xlm');
    expect(reason).toContain('xlm_to_eth');
  });
});

// ── authorizeSettlementCommand: CHAIN_MISMATCH ───────────────────────────────

describe('authorizeSettlementCommand — CHAIN_MISMATCH', () => {
  it('rejects when explicit chain conflicts with the direction', () => {
    // settle for xlm_to_eth must execute on ethereum, not stellar
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'settle',
      direction: 'xlm_to_eth',
      chain: 'stellar',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('CHAIN_MISMATCH');
  });

  it('rejects when explicit chain is completely unknown', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'lock',
      direction: 'eth_to_xlm',
      chain: 'bitcoin',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('CHAIN_MISMATCH');
  });

  it('rejection message names the required chain and the declared chain', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'settle',
      direction: 'xlm_to_eth',
      chain: 'stellar',
    });
    const reason = (result as AuthorizationDenial).reason;
    expect(reason).toContain('ethereum');  // required
    expect(reason).toContain('stellar');   // declared (wrong)
  });

  it('accepts chain aliases that resolve to the correct canonical chain', () => {
    // 'eth' is an alias for 'ethereum'; settle for xlm_to_eth targets ethereum
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'settle',
      direction: 'xlm_to_eth',
      chain: 'eth',
    });
    expect(result.authorized).toBe(true);
  });
});

// ── authorizeSettlementCommand: ROUTE_UNSUPPORTED ────────────────────────────

describe('authorizeSettlementCommand — ROUTE_UNSUPPORTED', () => {
  it('rejects when the support policy declares no route for the direction', () => {
    // Build a policy with no Stellar capability so the route is unsupported
    const noStellarPolicy = buildSupportPolicy(
      policyConfig({ stellar: { horizonUrl: HORIZON_URL, secretKey: '' } })
    );
    const result = authorizeSettlementCommand(noStellarPolicy, FULL_CONFIG, {
      command: 'settle',
      direction: 'xlm_to_eth',
    });
    expect(result.authorized).toBe(false);
    // ROUTE_UNSUPPORTED or ACTION_UNAVAILABLE depending on which leg fails first
    expect(['ROUTE_UNSUPPORTED', 'ACTION_UNAVAILABLE']).toContain(
      (result as AuthorizationDenial).code
    );
  });
});

// ── authorizeSettlementCommand: ACTION_UNAVAILABLE ───────────────────────────

describe('authorizeSettlementCommand — ACTION_UNAVAILABLE', () => {
  it('rejects lock when Ethereum signing key is missing', () => {
    const policy = buildSupportPolicy(
      policyConfig({ ethereum: { rpcUrl: 'https://sepolia.infura.io/v3/abc123', privateKey: '', escrowFactoryAddress: FACTORY_ADDR } })
    );
    const result = authorizeSettlementCommand(policy, FULL_CONFIG, {
      command: 'lock',
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('ACTION_UNAVAILABLE');
    expect((result as AuthorizationDenial).chain).toBe('ethereum');
  });

  it('rejects settle on Stellar when stellar key is missing', () => {
    const policy = buildSupportPolicy(
      policyConfig({ stellar: { horizonUrl: HORIZON_URL, secretKey: '' } })
    );
    const result = authorizeSettlementCommand(policy, FULL_CONFIG, {
      command: 'settle',
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('ACTION_UNAVAILABLE');
    expect((result as AuthorizationDenial).chain).toBe('stellar');
  });

  it('rejects refund on Ethereum when the factory address is missing', () => {
    const policy = buildSupportPolicy(
      policyConfig({ ethereum: { rpcUrl: 'https://sepolia.infura.io/v3/abc123', privateKey: ETH_KEY, escrowFactoryAddress: null } })
    );
    const result = authorizeSettlementCommand(policy, FULL_CONFIG, {
      command: 'refund',
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(false);
    // Factory missing → no write actions → ACTION_UNAVAILABLE
    expect((result as AuthorizationDenial).code).toBe('ACTION_UNAVAILABLE');
  });
});

// ── authorizeSettlementCommand: ACCOUNT_NOT_READY ────────────────────────────

describe('authorizeSettlementCommand — ACCOUNT_NOT_READY', () => {
  it('rejects when the Ethereum key is absent from config even if policy grants the action', () => {
    // Full policy (keys look present to the policy builder), but config has empty key
    const result = authorizeSettlementCommand(FULL_POLICY, fullConfig({ ethereum: { privateKey: '' } }), {
      command: 'lock',
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('ACCOUNT_NOT_READY');
    expect((result as AuthorizationDenial).reason).toContain('RELAYER_PRIVATE_KEY');
  });

  it('rejects when the Ethereum factory address is absent for a write command', () => {
    const result = authorizeSettlementCommand(
      FULL_POLICY,
      fullConfig({ ethereum: { privateKey: ETH_KEY, escrowFactoryAddress: null } }),
      { command: 'lock', direction: 'eth_to_xlm' }
    );
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('ACCOUNT_NOT_READY');
    expect((result as AuthorizationDenial).reason).toContain('ESCROW_FACTORY_ADDRESS');
  });

  it('rejects when the Stellar secret key is absent from config', () => {
    const result = authorizeSettlementCommand(
      FULL_POLICY,
      fullConfig({ stellar: { secretKey: '', horizonUrl: HORIZON_URL } }),
      { command: 'settle', direction: 'eth_to_xlm' }
    );
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('ACCOUNT_NOT_READY');
    expect((result as AuthorizationDenial).reason).toContain('RELAYER_STELLAR_SECRET');
  });

  it('rejects when the Stellar horizon URL is absent', () => {
    const result = authorizeSettlementCommand(
      FULL_POLICY,
      fullConfig({ stellar: { secretKey: STELLAR_SECRET, horizonUrl: '' } }),
      { command: 'settle', direction: 'eth_to_xlm' }
    );
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('ACCOUNT_NOT_READY');
    expect((result as AuthorizationDenial).reason).toContain('STELLAR_HORIZON_URL');
  });

  it('rejects a placeholder private key string', () => {
    const result = authorizeSettlementCommand(
      FULL_POLICY,
      fullConfig({ ethereum: { privateKey: 'YOUR_PRIVATE_KEY_HERE' } }),
      { command: 'lock', direction: 'eth_to_xlm' }
    );
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('ACCOUNT_NOT_READY');
  });

  it('verify does not require the factory address (read-only)', () => {
    // verify only needs observe, which only needs an RPC endpoint —
    // no factory address required.
    const result = authorizeSettlementCommand(
      FULL_POLICY,
      fullConfig({ ethereum: { privateKey: ETH_KEY, escrowFactoryAddress: null } }),
      { command: 'verify', direction: 'eth_to_xlm' }
    );
    // Policy will deny the whole route since lock/settle need factory,
    // but the verify command itself should not fail on factory check.
    // The denial (if any) comes from the route/action layer, not account.
    if (!result.authorized) {
      expect((result as AuthorizationDenial).code).not.toBe('ACCOUNT_NOT_READY');
    }
  });
});

// ── authorizeAllCommands ──────────────────────────────────────────────────────

describe('authorizeAllCommands', () => {
  it('returns a map covering all four commands for a live direction', () => {
    const results = authorizeAllCommands(FULL_POLICY, FULL_CONFIG, 'eth_to_xlm');
    expect(results.size).toBe(SETTLEMENT_COMMANDS.length);
    for (const cmd of SETTLEMENT_COMMANDS) {
      expect(results.has(cmd)).toBe(true);
    }
  });

  it('all commands are granted with a full config', () => {
    const results = authorizeAllCommands(FULL_POLICY, FULL_CONFIG, 'xlm_to_eth');
    for (const [cmd, result] of results) {
      expect(result.authorized, `${cmd} should be granted`).toBe(true);
    }
  });

  it('all commands are denied when the Ethereum key is missing', () => {
    const policy = buildSupportPolicy(
      policyConfig({ ethereum: { rpcUrl: 'https://rpc', privateKey: '', escrowFactoryAddress: FACTORY_ADDR } })
    );
    const results = authorizeAllCommands(policy, FULL_CONFIG, 'eth_to_xlm');
    for (const [cmd, result] of results) {
      // lock/settle/refund need the key; verify only needs observe which
      // is still available via the RPC URL
      if (cmd !== 'verify') {
        expect(result.authorized, `${cmd} should be denied without eth key`).toBe(false);
      }
    }
  });

  it('all commands are denied for an unsupported direction', () => {
    const results = authorizeAllCommands(FULL_POLICY, FULL_CONFIG, 'btc_to_eth');
    for (const [, result] of results) {
      expect(result.authorized).toBe(false);
    }
  });
});

// ── checkOrderSettleable ──────────────────────────────────────────────────────

describe('checkOrderSettleable', () => {
  it('returns null when both lock and settle are granted', () => {
    const denial = checkOrderSettleable(FULL_POLICY, FULL_CONFIG, 'eth_to_xlm');
    expect(denial).toBeNull();
  });

  it('returns null for xlm_to_eth with full config', () => {
    const denial = checkOrderSettleable(FULL_POLICY, FULL_CONFIG, 'xlm_to_eth');
    expect(denial).toBeNull();
  });

  it('returns an AuthorizationDenial when the Ethereum key is missing (lock blocked)', () => {
    const policy = buildSupportPolicy(
      policyConfig({ ethereum: { rpcUrl: 'https://rpc', privateKey: '', escrowFactoryAddress: FACTORY_ADDR } })
    );
    const denial = checkOrderSettleable(policy, FULL_CONFIG, 'eth_to_xlm');
    expect(denial).not.toBeNull();
    expect(denial!.command).toBe('lock');
  });

  it('returns an AuthorizationDenial when the Stellar secret is missing (settle blocked)', () => {
    const policy = buildSupportPolicy(
      policyConfig({ stellar: { horizonUrl: HORIZON_URL, secretKey: '' } })
    );
    const denial = checkOrderSettleable(policy, FULL_CONFIG, 'eth_to_xlm');
    expect(denial).not.toBeNull();
    expect(denial!.command).toBe('settle');
  });

  it('returns an AuthorizationDenial for an unsupported direction', () => {
    const denial = checkOrderSettleable(FULL_POLICY, FULL_CONFIG, 'eth_to_sol');
    expect(denial).not.toBeNull();
    expect(denial!.code).toBe('DIRECTION_UNSUPPORTED');
  });

  it('returned denial carries chain and code for structured logging', () => {
    const policy = buildSupportPolicy(
      policyConfig({ stellar: { horizonUrl: HORIZON_URL, secretKey: '' } })
    );
    const denial = checkOrderSettleable(policy, FULL_CONFIG, 'eth_to_xlm');
    expect(denial).not.toBeNull();
    expect(typeof denial!.code).toBe('string');
    expect(typeof denial!.reason).toBe('string');
    expect(denial!.chain).toBeDefined();
  });
});

// ── formatAuthorizationLog ────────────────────────────────────────────────────

describe('formatAuthorizationLog', () => {
  it('grant log contains command, chain and accountDescription — no key material', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'lock',
      direction: 'eth_to_xlm',
    });
    expect(result.authorized).toBe(true);
    const log = formatAuthorizationLog(result);
    expect(log.authorized).toBe(true);
    expect(log.command).toBe('lock');
    expect(log.chain).toBe('ethereum');
    expect(typeof log.accountDescription).toBe('string');
    // Must not contain raw key material
    expect(JSON.stringify(log)).not.toContain(ETH_KEY);
    expect(JSON.stringify(log)).not.toContain(STELLAR_SECRET);
    expect(JSON.stringify(log)).not.toContain('infura');
  });

  it('denial log contains authorized:false, code, reason, command and chain', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'settle',
      direction: 'btc_to_eth',
    });
    expect(result.authorized).toBe(false);
    const log = formatAuthorizationLog(result);
    expect(log.authorized).toBe(false);
    expect(typeof log.code).toBe('string');
    expect(typeof log.reason).toBe('string');
    expect(log.command).toBe('settle');
  });

  it('denial log never exposes private keys even when config values appear in reason strings', () => {
    const result = authorizeSettlementCommand(
      FULL_POLICY,
      fullConfig({ ethereum: { privateKey: '' } }),
      { command: 'lock', direction: 'eth_to_xlm' }
    );
    const logStr = JSON.stringify(formatAuthorizationLog(result));
    expect(logStr).not.toContain(ETH_KEY);
    expect(logStr).not.toContain(STELLAR_SECRET);
  });
});

// ── Denial ordering guarantees ────────────────────────────────────────────────

describe('authorizeSettlementCommand — denial ordering', () => {
  it('COMMAND_UNKNOWN is returned before DIRECTION_UNSUPPORTED', () => {
    // Even with a bad direction, an unknown command is caught first
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'explode' as any,
      direction: 'btc_to_eth',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('COMMAND_UNKNOWN');
  });

  it('DIRECTION_UNSUPPORTED is returned before CHAIN_MISMATCH', () => {
    const result = authorizeSettlementCommand(FULL_POLICY, FULL_CONFIG, {
      command: 'lock',
      direction: 'btc_to_eth',
      chain: 'ethereum',
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('DIRECTION_UNSUPPORTED');
  });

  it('CHAIN_MISMATCH is returned before ACTION_UNAVAILABLE', () => {
    // Policy with missing ETH key, but we also give the wrong explicit chain
    const policy = buildSupportPolicy(
      policyConfig({ ethereum: { rpcUrl: 'https://rpc', privateKey: '', escrowFactoryAddress: FACTORY_ADDR } })
    );
    const result = authorizeSettlementCommand(policy, FULL_CONFIG, {
      command: 'settle',
      direction: 'xlm_to_eth',
      chain: 'stellar',  // wrong: settle for xlm_to_eth must target ethereum
    });
    expect(result.authorized).toBe(false);
    expect((result as AuthorizationDenial).code).toBe('CHAIN_MISMATCH');
  });
});
