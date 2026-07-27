/**
 * Resolver-side adapter for the shared support-policy contract.
 *
 * The typed contract itself lives in `@wafflefinance/config` so the relayer and
 * resolver answer capability questions the same way.  This module holds only
 * what is resolver-specific: building the policy from the loaded config, and
 * mapping canonical policy chain ids onto the metric/telemetry label strings
 * the resolver has always emitted.
 */

import {
  buildResolverSupportPolicy,
  describeSupportPolicy,
  formatSupportPolicy,
  validateSupportPolicy,
  type SupportedChain,
  type SupportPolicy,
} from "@wafflefinance/config";
import type { Logger } from "pino";
import type { ResolverConfig } from "./config.js";

/**
 * Metric and telemetry label for each canonical chain id.
 *
 * The policy's canonical id for the Stellar network is `"stellar"`, but the
 * resolver has always labelled its Prometheus series and `/telemetry` chains
 * `"soroban"`.  Renaming those would break existing dashboards and alert rules,
 * so the label set is held stable here and translated at the boundary.
 */
const CHAIN_LABELS: Readonly<Record<SupportedChain, string>> = {
  ethereum: "ethereum",
  stellar: "soroban",
  solana: "solana",
};

/** The metric/telemetry label for a canonical policy chain id. */
export function chainLabel(chain: SupportedChain): string {
  return CHAIN_LABELS[chain];
}

/** Build the resolver's support policy from its loaded configuration. */
export function buildSupportPolicy(cfg: ResolverConfig): SupportPolicy {
  return buildResolverSupportPolicy({
    network: cfg.network,
    ethereum: {
      rpcUrl: cfg.ethereum.rpcUrl,
      htlcEscrow: cfg.ethereum.htlcEscrow,
      resolverRegistry: cfg.ethereum.resolverRegistry,
      resolverPrivateKey: cfg.ethereum.resolverPrivateKey,
    },
    soroban: {
      rpcUrl: cfg.soroban.rpcUrl,
      htlc: cfg.soroban.htlc,
      resolverRegistry: cfg.soroban.resolverRegistry,
      resolverSecret: cfg.soroban.resolverSecret,
    },
  });
}

/**
 * Log the policy's warnings and its full capability description.
 *
 * Called during startup so the first thing an operator sees is what this
 * process can actually do, rather than a hard-coded chain list that may not
 * reflect the deployment.  The description contains no secrets.
 */
export function logSupportPolicy(policy: SupportPolicy, log: Logger): void {
  const validation = validateSupportPolicy(policy);

  for (const warning of validation.warnings) {
    log.warn(
      { code: warning.code, subject: warning.subject },
      `support policy: ${warning.message}`
    );
  }

  log.info(
    { support: describeSupportPolicy(policy) },
    `resolver capabilities:\n${formatSupportPolicy(policy)}`
  );
}
