/**
 * @file settlement-permissions.ts
 *
 * Typed command-permission model for relayer settlement operations.
 *
 * ## Why this file exists
 *
 * The relayer operates in a privileged position: it holds signing keys for
 * both Ethereum and Stellar, and it executes irreversible on-chain
 * transactions on behalf of users. Until now the only explicit authorization
 * gate was `requireAdminAuth` on admin endpoints. The main settlement paths
 * (`POST /api/orders/create`, `/api/orders/process`, `/api/orders/xlm-to-eth`)
 * made implicit trust decisions by branching on `direction` strings without a
 * formal model for:
 *
 *   - Which settlement *commands* are valid (e.g. `lock`, `settle`, `refund`).
 *   - Which *chains* each command applies to in a given direction.
 *   - Whether the relayer's *account* (key + contract) can actually execute
 *     the command right now (config present, not placeholder).
 *   - Whether the *route* being settled is one the policy allows.
 *
 * A settlement command that bypasses these checks can:
 *   - Lock funds on the source chain for a route the destination can never
 *     settle (e.g. a Solana leg with no program deployed).
 *   - Attempt to sign a transaction with a missing or placeholder key.
 *   - Execute a `refund` on the wrong chain because the direction was assumed
 *     rather than validated.
 *
 * This module makes every one of those decisions explicit and typed.
 *
 * ## The model
 *
 * A **settlement command** is the atomic unit of relayer work:
 *
 *   lock    — create / fund the source-side escrow (value moves in).
 *   settle  — deliver the destination-side asset to the beneficiary.
 *   refund  — return funds to the depositor after timelock expiry.
 *   verify  — confirm an incoming payment without moving funds (read-only).
 *
 * A **command authorization** is the answer to: "can the relayer execute
 * *this* command on *this* chain for *this* direction right now?"
 *
 * Authorization is the intersection of three independent facts:
 *
 *   1. **Route capability** — the active `SupportPolicy` says both legs are
 *      operational (chains configured, actions available).
 *   2. **Command–chain binding** — the command makes sense for the chain in
 *      this direction (you `lock` on the source chain, `settle` on the
 *      destination chain).
 *   3. **Account readiness** — the signing key and contract address for that
 *      chain are present and not placeholder values.
 *
 * `authorizeSettlementCommand` evaluates all three and returns either an
 * `AuthorizationGrant` (with the resolved chain and account details) or an
 * `AuthorizationDenial` (with a stable `code` and a human-readable `reason`).
 *
 * ## Usage
 *
 * ```ts
 * const grant = authorizeSettlementCommand(policy, config, {
 *   command: "settle",
 *   direction: "xlm_to_eth",
 *   chain: "ethereum",
 * });
 * if (!grant.authorized) {
 *   log.warn({ code: grant.code, reason: grant.reason }, "settlement command denied");
 *   return res.status(403).json({ error: "settlement_permission_denied", ...grant });
 * }
 * // proceed with grant.account
 * ```
 *
 * ## Observability
 *
 * Every authorization result carries enough information for structured
 * logging: `code` for metrics, `reason` for operator-readable log lines,
 * `command` and `chain` so the log entry is self-contained without needing
 * additional context fields.
 */

import {
  supportsAction,
  supportsRoute,
  normaliseChain,
  type SupportPolicy,
  type SupportedChain,
  type SupportedAction,
} from "@wafflefinance/config";
import { DIRECTION_ROUTES } from "./support.js";

// ── Command types ─────────────────────────────────────────────────────────────

/**
 * The settlement commands the relayer can execute.
 *
 *   lock    — fund the source-side escrow (value moves from user into escrow).
 *   settle  — deliver the destination-side asset to the beneficiary.
 *   refund  — return source-side funds to the depositor after timelock expiry.
 *   verify  — confirm an incoming payment (read-only; no funds move).
 */
export type SettlementCommand = "lock" | "settle" | "refund" | "verify";

/** All declared settlement commands, in a stable order. */
export const SETTLEMENT_COMMANDS: readonly SettlementCommand[] = [
  "lock",
  "settle",
  "refund",
  "verify",
] as const;

/**
 * Map each settlement command to the `SupportedAction` it requires on the
 * executing chain.  `verify` is a read-only operation that needs only
 * `observe` capability — it never moves funds.
 */
const COMMAND_REQUIRED_ACTION: Readonly<Record<SettlementCommand, SupportedAction>> = {
  lock: "lock",
  settle: "settle",
  refund: "refund",
  verify: "observe",
} as const;

// ── Direction–command–chain contract ─────────────────────────────────────────

/**
 * For each direction, which command applies to which leg.
 *
 * The relayer `lock`s on the source chain and `settle`s on the destination
 * chain. `refund` is always on the source chain (that is where the user's
 * funds are held). `verify` is a read-only check and can be applied to either
 * leg, but in practice the relayer verifies incoming payments on the source
 * chain (e.g. confirming a Stellar payment via Horizon before releasing ETH).
 */
export interface DirectionCommandChains {
  /** The chain where `lock` and `refund` commands execute. */
  source: SupportedChain;
  /** The chain where `settle` commands execute. */
  destination: SupportedChain;
}

/**
 * Canonical command–chain assignments per direction.
 *
 * Only directions with a live relayer code path are listed here. Attempting to
 * authorize a settlement command for an unlisted direction is an
 * `DIRECTION_UNSUPPORTED` denial regardless of the supporting chain config.
 */
export const DIRECTION_COMMAND_CHAINS: Readonly<
  Record<string, DirectionCommandChains>
> = {
  eth_to_xlm: { source: "ethereum", destination: "stellar" },
  xlm_to_eth: { source: "stellar", destination: "ethereum" },
} as const;

/**
 * Resolve which chain a command targets for a given direction.
 *
 * Returns `null` when the direction is not declared or when the command does
 * not have a clear chain binding (which should not happen for well-formed
 * inputs, but callers must handle it).
 */
export function resolveCommandChain(
  direction: string,
  command: SettlementCommand
): SupportedChain | null {
  const entry = DIRECTION_COMMAND_CHAINS[direction];
  if (!entry) return null;
  switch (command) {
    case "lock":
    case "refund":
      return entry.source;
    case "settle":
      return entry.destination;
    case "verify":
      // verify is applied on the source chain — the relayer confirms incoming
      // payments before executing any write on the destination.
      return entry.source;
    default:
      return null;
  }
}

// ── Account readiness ─────────────────────────────────────────────────────────

/**
 * The account details the relayer uses to execute a command on a chain.
 * Populated on a successful authorization grant so the caller can proceed
 * without re-reading config.
 */
export interface ChainAccount {
  chain: SupportedChain;
  /**
   * True when the signing key for this chain is present and non-placeholder.
   * Always true on a grant — a missing key produces a denial.
   */
  signerAvailable: boolean;
  /**
   * Human-readable description of the account (address prefix or network
   * identifier). Never contains the raw key material.
   */
  accountDescription: string;
}

/**
 * The config fields the permission check reads to verify account readiness.
 *
 * Structurally compatible with `RELAYER_CONFIG` so callers can pass it
 * directly while tests can supply a minimal literal.
 */
export interface SettlementAccountConfig {
  ethereum: {
    privateKey?: string | null;
    escrowFactoryAddress?: string | null;
    rpcUrl?: string | null;
  };
  stellar: {
    secretKey?: string | null;
    horizonUrl?: string | null;
  };
}

/**
 * Placeholder-detection heuristics.
 *
 * Mirrors the logic in `@wafflefinance/config`'s `isPlaceholderValue` but
 * kept local so this module has no build-time import from config for this
 * single helper.  The canonical `isPlaceholderValue` is used by the policy
 * builders; here we only need to detect the most common sentinels.
 */
function isAbsentOrPlaceholder(value: string | null | undefined): boolean {
  if (!value || value.trim() === "") return true;
  const v = value.trim().toUpperCase();
  return (
    v.startsWith("YOUR_") ||
    v.startsWith("REPLACE_") ||
    v === "0X0000000000000000000000000000000000000000000000000000000000000001" ||
    /^0+$/.test(v.replace(/^0X/, ""))
  );
}

/**
 * Build an account description without exposing key material.
 * Returns a short, log-safe string like "ethereum (key: 0x59c6…)".
 */
function describeAccount(
  chain: SupportedChain,
  keyOrSecret: string | null | undefined
): string {
  if (!keyOrSecret || isAbsentOrPlaceholder(keyOrSecret)) {
    return `${chain} (no signer)`;
  }
  const prefix = keyOrSecret.length > 6 ? keyOrSecret.slice(0, 6) : keyOrSecret;
  return `${chain} (key: ${prefix}…)`;
}

// ── Denial types ──────────────────────────────────────────────────────────────

/**
 * Why an authorization was denied. Stable identifiers — safe to use as metric
 * labels and to branch on in caller logic.
 *
 *   DIRECTION_UNSUPPORTED   — the direction is not in the command-chain table.
 *   COMMAND_UNKNOWN         — the command is not a recognized settlement command.
 *   CHAIN_MISMATCH          — the requested chain conflicts with the direction.
 *   ROUTE_UNSUPPORTED       — the support policy does not carry this route.
 *   ACTION_UNAVAILABLE      — the required action is not available on the chain.
 *   ACCOUNT_NOT_READY       — signing key or contract address is absent/placeholder.
 */
export type PermissionDenialCode =
  | "DIRECTION_UNSUPPORTED"
  | "COMMAND_UNKNOWN"
  | "CHAIN_MISMATCH"
  | "ROUTE_UNSUPPORTED"
  | "ACTION_UNAVAILABLE"
  | "ACCOUNT_NOT_READY";

/** A settlement-permission refusal. */
export interface AuthorizationDenial {
  authorized: false;
  code: PermissionDenialCode;
  /** Human-readable explanation for log lines and HTTP responses. */
  reason: string;
  /** The command that was denied, for log correlation. */
  command: SettlementCommand;
  /** The chain the command targeted, if it could be resolved. */
  chain: SupportedChain | null;
}

/** A settlement-permission grant. */
export interface AuthorizationGrant {
  authorized: true;
  command: SettlementCommand;
  chain: SupportedChain;
  /** Resolved account details ready for the caller to use. */
  account: ChainAccount;
}

/** The result of a settlement-permission check. */
export type SettlementAuthorization = AuthorizationGrant | AuthorizationDenial;

function denyPermission(
  code: PermissionDenialCode,
  reason: string,
  command: SettlementCommand,
  chain: SupportedChain | null = null
): AuthorizationDenial {
  return { authorized: false, code, reason, command, chain };
}

// ── Authorization query ───────────────────────────────────────────────────────

/**
 * The input to a settlement-permission check.
 */
export interface SettlementCommandRequest {
  /** The settlement command to authorize (lock, settle, refund, verify). */
  command: SettlementCommand;
  /**
   * The direction of the order being settled (e.g. `"eth_to_xlm"`).
   * Used to determine which chain the command targets.
   */
  direction: string;
  /**
   * The chain the caller *intends* to execute on. When supplied, it is
   * cross-checked against the direction to catch mismatches early. When
   * omitted, the chain is resolved from the direction + command binding.
   */
  chain?: string | null;
}

/**
 * Authorize a settlement command for a given direction and chain.
 *
 * The function is a pure policy evaluation — it never executes any transaction
 * or side-effect. It returns a grant or denial synchronously so callers can
 * branch on the result before touching any chain SDK.
 *
 * Checks, in order:
 *  1. `command` is a recognized settlement command.
 *  2. `direction` is declared in the command–chain table.
 *  3. The resolved chain matches `chain` when the caller supplies one.
 *  4. The support policy confirms the route is operational.
 *  5. The required action for the command is available on the chain.
 *  6. The account (key + contract) is present and non-placeholder.
 *
 * @param policy   The relayer's active support policy (from `buildSupportPolicy`).
 * @param config   The relayer config fields the permission check reads.
 * @param request  The command, direction, and optional explicit chain.
 */
export function authorizeSettlementCommand(
  policy: SupportPolicy,
  config: SettlementAccountConfig,
  request: SettlementCommandRequest
): SettlementAuthorization {
  const { command, direction } = request;

  // ── 1. Command must be recognized ─────────────────────────────────────────
  if (!(SETTLEMENT_COMMANDS as readonly string[]).includes(command)) {
    return denyPermission(
      "COMMAND_UNKNOWN",
      `"${command}" is not a recognized settlement command ` +
        `(expected one of: ${SETTLEMENT_COMMANDS.join(", ")})`,
      command as SettlementCommand
    );
  }

  // ── 2. Direction must be declared ─────────────────────────────────────────
  const commandChains = DIRECTION_COMMAND_CHAINS[direction];
  if (!commandChains) {
    const declared = Object.keys(DIRECTION_COMMAND_CHAINS).join(", ");
    return denyPermission(
      "DIRECTION_UNSUPPORTED",
      `direction "${direction}" has no settlement command mapping ` +
        `(declared directions: ${declared})`,
      command
    );
  }

  // ── 3. Resolve and cross-check the target chain ────────────────────────────
  const resolvedChain = resolveCommandChain(direction, command);
  if (!resolvedChain) {
    return denyPermission(
      "DIRECTION_UNSUPPORTED",
      `cannot resolve target chain for command "${command}" on direction "${direction}"`,
      command
    );
  }

  // When the caller names an explicit chain, verify it matches the resolved one.
  if (request.chain !== undefined && request.chain !== null) {
    const canonical = normaliseChain(String(request.chain));
    if (!canonical) {
      return denyPermission(
        "CHAIN_MISMATCH",
        `chain "${String(request.chain)}" is not a known chain identifier`,
        command,
        resolvedChain
      );
    }
    if (canonical !== resolvedChain) {
      return denyPermission(
        "CHAIN_MISMATCH",
        `command "${command}" for direction "${direction}" must execute on ` +
          `${resolvedChain}, but the request specifies ${canonical} — ` +
          `the chain is inconsistent with the direction`,
        command,
        resolvedChain
      );
    }
  }

  // ── 4. Support policy must carry the route ─────────────────────────────────
  const directionRouteEntry = DIRECTION_ROUTES[direction];
  if (directionRouteEntry) {
    const routeVerdict = supportsRoute(policy, {
      from: directionRouteEntry.from,
      to: directionRouteEntry.to,
    });
    if (!routeVerdict.supported) {
      return denyPermission(
        "ROUTE_UNSUPPORTED",
        `settlement command "${command}" denied: route ${directionRouteEntry.from}→` +
          `${directionRouteEntry.to} is not supported by the current policy — ` +
          routeVerdict.reason,
        command,
        resolvedChain
      );
    }
  }

  // ── 5. Required action must be available on the resolved chain ─────────────
  const requiredAction = COMMAND_REQUIRED_ACTION[command];
  const actionVerdict = supportsAction(policy, resolvedChain, requiredAction);
  if (!actionVerdict.supported) {
    return denyPermission(
      "ACTION_UNAVAILABLE",
      `settlement command "${command}" requires action "${requiredAction}" on ` +
        `${resolvedChain}, which is not available: ${actionVerdict.reason}`,
      command,
      resolvedChain
    );
  }

  // ── 6. Account readiness — key and contract must be present ───────────────
  let signerKey: string | null | undefined;
  let contractOrEndpoint: string | null | undefined;
  let accountMissingDetail: string | null = null;

  if (resolvedChain === "ethereum") {
    signerKey = config.ethereum.privateKey;
    contractOrEndpoint = config.ethereum.escrowFactoryAddress;
    if (isAbsentOrPlaceholder(signerKey)) {
      accountMissingDetail = "RELAYER_PRIVATE_KEY is absent or placeholder";
    } else if (command !== "verify" && isAbsentOrPlaceholder(contractOrEndpoint)) {
      accountMissingDetail = "ESCROW_FACTORY_ADDRESS is absent or placeholder";
    }
  } else if (resolvedChain === "stellar") {
    signerKey = config.stellar.secretKey;
    contractOrEndpoint = config.stellar.horizonUrl;
    if (isAbsentOrPlaceholder(signerKey)) {
      accountMissingDetail = "RELAYER_STELLAR_SECRET is absent or placeholder";
    } else if (isAbsentOrPlaceholder(contractOrEndpoint)) {
      accountMissingDetail = "STELLAR_HORIZON_URL is absent or placeholder";
    }
  } else {
    // Any other chain (e.g. solana) has no account config in the relayer.
    accountMissingDetail = `no account configuration exists for chain "${resolvedChain}" in the relayer`;
  }

  if (accountMissingDetail) {
    return denyPermission(
      "ACCOUNT_NOT_READY",
      `settlement command "${command}" on ${resolvedChain} cannot proceed: ` +
        accountMissingDetail,
      command,
      resolvedChain
    );
  }

  // ── All checks passed — build the grant ───────────────────────────────────
  return {
    authorized: true,
    command,
    chain: resolvedChain,
    account: {
      chain: resolvedChain,
      signerAvailable: true,
      accountDescription: describeAccount(resolvedChain, signerKey),
    },
  };
}

// ── Bulk authorization helpers ────────────────────────────────────────────────

/**
 * Authorize all settlement commands for a direction at once.
 *
 * Returns a map from command to its authorization result. Useful at order-
 * creation time to verify that both the `lock` and `settle` commands are
 * available before any escrow is built — catching a partially-configured
 * relayer before value moves.
 *
 * @example
 * ```ts
 * const auths = authorizeAllCommands(policy, config, "eth_to_xlm");
 * const lock = auths.get("lock");
 * const settle = auths.get("settle");
 * if (!lock?.authorized || !settle?.authorized) {
 *   return reject("settlement_permission_denied", lock ?? settle);
 * }
 * ```
 */
export function authorizeAllCommands(
  policy: SupportPolicy,
  config: SettlementAccountConfig,
  direction: string
): Map<SettlementCommand, SettlementAuthorization> {
  const results = new Map<SettlementCommand, SettlementAuthorization>();
  for (const command of SETTLEMENT_COMMANDS) {
    results.set(
      command,
      authorizeSettlementCommand(policy, config, { command, direction })
    );
  }
  return results;
}

/**
 * Quick check: can the relayer both lock funds and settle the destination leg
 * for a given direction?
 *
 * This is the minimum bar for accepting an order into the pipeline — if either
 * leg is not authorized the order should be refused before any escrow is built.
 * Returns the first denial found, or `null` when both are granted.
 */
export function checkOrderSettleable(
  policy: SupportPolicy,
  config: SettlementAccountConfig,
  direction: string
): AuthorizationDenial | null {
  for (const command of ["lock", "settle"] as const) {
    const result = authorizeSettlementCommand(policy, config, { command, direction });
    if (!result.authorized) return result;
  }
  return null;
}

// ── Observability helpers ─────────────────────────────────────────────────────

/**
 * Format an authorization result as a structured log object.
 *
 * Safe to pass directly to `log.info` / `log.warn` — contains no key
 * material, only chain names, command names, and the denial reason when
 * applicable.
 *
 * @example
 * ```ts
 * log.info(formatAuthorizationLog(grant), "settlement command authorized");
 * log.warn(formatAuthorizationLog(denial), "settlement command denied");
 * ```
 */
export function formatAuthorizationLog(
  result: SettlementAuthorization
): Record<string, unknown> {
  if (result.authorized) {
    return {
      authorized: true,
      command: result.command,
      chain: result.chain,
      accountDescription: result.account.accountDescription,
    };
  }
  return {
    authorized: false,
    code: result.code,
    reason: result.reason,
    command: result.command,
    chain: result.chain,
  };
}
