/**
 * @file support-policy.ts
 *
 * Typed support-policy contract for the WaffleFinance relayer and resolver.
 *
 * ## Why this file exists
 *
 * Both long-running runtimes need to answer one question before they do any
 * work: *"can I actually do this, on this chain, for this asset?"*  Until now
 * that answer was assembled from assumptions scattered across the codebase:
 *
 *  - `resolver/src/commands/run.ts` hard-coded `"ethereum"` and `"soroban"` as
 *    string constants and started both listeners unconditionally, whether or
 *    not the chain was usable.
 *  - `resolver/src/commands/register.ts` re-derived "can I stake?" from two
 *    ad-hoc null checks, and picked its viem chain with a
 *    `chainId === 1 ? mainnet : sepolia` heuristic.
 *  - `resolver/src/health.ts` reported `missing_htlc_escrow` when *either* the
 *    escrow address or the signing key was absent — the detail string did not
 *    describe the actual defect.
 *  - `relayer/src/index.ts` required `fromChain` / `toChain` to be *present* on
 *    `POST /api/orders/create` and then ignored their values entirely, branching
 *    only on `direction`.  A request naming an unsupported source chain was
 *    accepted and settled against Ethereum regardless.
 *  - Solana appears throughout config, metrics and health output but has no
 *    settlement code path at all — its "support" was a placeholder gauge.
 *
 * The failure mode this creates is not a loud crash.  It is a half-executed
 * bridge: funds locked on the source chain before anyone establishes that the
 * destination leg was ever possible.  This module makes capability explicit,
 * typed, and checkable *before* value moves.
 *
 * ## The model
 *
 * Capability is the intersection of two independent facts:
 *
 *  1. **What code exists** — `IMPLEMENTED_ACTIONS` / `IMPLEMENTED_TOKEN_CLASSES`
 *     are hand-maintained tables stating which actions each runtime actually
 *     has a code path for.  These change only when code changes.
 *  2. **What config enables** — the signing keys, contract addresses and
 *     endpoints present at startup.  These change per deployment.
 *
 * A runtime supports an action only when *both* agree.  Everything else in this
 * file derives from that intersection: chain support, route support, startup
 * validation, and the introspection payloads used by logs and `/support`.
 *
 * Because `SupportPolicy.chains` is a total `Record<SupportedChain, …>`, adding
 * a chain to the union is a compile error until every runtime declares a stance
 * on it.  Silence is not a valid answer.
 *
 * ## Usage
 *
 * ```ts
 * import {
 *   buildResolverSupportPolicy,
 *   assertSupportPolicy,
 *   formatSupportPolicy,
 *   supportsRoute,
 * } from "@wafflefinance/config";
 *
 * const policy = buildResolverSupportPolicy(cfg);
 * assertSupportPolicy(policy);                    // fail fast, before listeners
 * log.info({ support: describeSupportPolicy(policy) }, formatSupportPolicy(policy));
 *
 * const verdict = supportsRoute(policy, { from: "ethereum", to: "stellar" });
 * if (!verdict.supported) return reject(verdict.code, verdict.reason);
 * ```
 */

import type { NetworkMode } from "./schema.js";
import { isSolanaPlaceholder } from "./solana-placeholder.js";
import { isPlaceholderValue } from "./soroban-chain-config.js";

// ── Axes ──────────────────────────────────────────────────────────────────────

/** The two long-running runtimes that carry a support policy. */
export type RuntimeKind = "relayer" | "resolver";

/**
 * Canonical chain identifiers.
 *
 * `"stellar"` is the canonical key for the Stellar network, covering both the
 * Horizon/classic surface the relayer uses and the Soroban contract surface the
 * resolver watches.  `normaliseChain("soroban")` maps onto it — see
 * `CHAIN_ALIASES`.  The frontend already sends `"ethereum"` / `"stellar"` on
 * `POST /api/orders/create`, so these values are wire-compatible today.
 */
export type SupportedChain = "ethereum" | "stellar" | "solana";

/** Every chain identifier, in a stable order suitable for logs and iteration. */
export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  "ethereum",
  "stellar",
  "solana",
] as const;

/**
 * Actions a runtime can perform on a chain.
 *
 *  - `observe`  — attach a listener / poller and read events.  Read-only.
 *  - `lock`     — create or fund the source-side escrow (moves user value in).
 *  - `claim`    — reveal a preimage and take the locked funds.
 *  - `refund`   — return funds to the depositor after timelock expiry.
 *  - `settle`   — deliver the destination-side asset to the beneficiary.
 *  - `register`  — stake into the ResolverRegistry to become fill-eligible.
 */
export type SupportedAction =
  | "observe"
  | "lock"
  | "claim"
  | "refund"
  | "settle"
  | "register";

/** Every action identifier, in a stable order. */
export const SUPPORTED_ACTIONS: readonly SupportedAction[] = [
  "observe",
  "lock",
  "claim",
  "refund",
  "settle",
  "register",
] as const;

/**
 * Classes of asset a runtime can move.  Deliberately coarse: the bridge cares
 * whether an asset is the chain's native unit or a contract-issued token, not
 * which specific token it is.
 */
export type TokenClass = "native" | "erc20" | "stellar-asset" | "spl";

/**
 * How much of a chain's implemented capability is actually available.
 *
 *  - `full`          — every implemented action is available.
 *  - `partial`       — some implemented actions are available, not all.
 *  - `observe-only`  — reads work; no write action is available (no signer).
 *  - `unconfigured`  — required config is absent; nothing works.
 *  - `placeholder`   — config is present but is a known placeholder sentinel.
 *  - `unimplemented` — no code path exists for this chain in this runtime.
 */
export type SupportLevel =
  | "full"
  | "partial"
  | "observe-only"
  | "unconfigured"
  | "placeholder"
  | "unimplemented";

// ── Chain-name normalisation ──────────────────────────────────────────────────

/**
 * Accepted spellings for each canonical chain, lower-cased.
 *
 * Callers receive chain names from HTTP request bodies, env vars and log lines,
 * where `"soroban"`, `"eth"` and `"XLM"` all appear in this repo already.
 * Normalising at the policy boundary means every consumer compares canonical
 * values, and an unrecognised name is a rejection rather than a silent miss.
 */
const CHAIN_ALIASES: Readonly<Record<string, SupportedChain>> = {
  ethereum: "ethereum",
  eth: "ethereum",
  evm: "ethereum",
  sepolia: "ethereum",
  stellar: "stellar",
  soroban: "stellar",
  xlm: "stellar",
  solana: "solana",
  sol: "solana",
  svm: "solana",
};

/**
 * Map an arbitrary chain identifier onto its canonical form.
 * Returns `null` when the identifier is not a chain this bridge knows about —
 * callers must treat `null` as "unsupported", never as "assume the default".
 */
export function normaliseChain(raw: string | null | undefined): SupportedChain | null {
  if (raw === null || raw === undefined) return null;
  const key = raw.trim().toLowerCase();
  if (key === "") return null;
  return CHAIN_ALIASES[key] ?? null;
}

/** Type guard for `SupportedChain`, for narrowing already-canonical values. */
export function isSupportedChain(raw: unknown): raw is SupportedChain {
  return typeof raw === "string" && SUPPORTED_CHAINS.includes(raw as SupportedChain);
}

// ── Implemented-capability tables ─────────────────────────────────────────────

/**
 * Which actions each runtime has a real code path for, per chain.
 *
 * This table describes *code*, not deployment.  It is the honest answer to
 * "could this ever work, given a perfect config?" and must be edited whenever a
 * settlement path is added or removed.  Config gating is applied on top of it
 * by the builders below.
 */
export const IMPLEMENTED_ACTIONS: Readonly<
  Record<RuntimeKind, Readonly<Record<SupportedChain, readonly SupportedAction[]>>>
> = {
  relayer: {
    // Ethereum is both a source and a destination.  For `eth_to_xlm` the
    // relayer builds and funds an EscrowFactory escrow (`lock`); for
    // `xlm_to_eth` it releases ETH to the beneficiary (`settle`).
    // recovery-service.ts and refund-watchdog.ts cover `refund`.
    ethereum: ["observe", "lock", "claim", "settle", "refund"],
    // Stellar is likewise both: `xlm_to_eth` creates a Stellar HTLC and
    // horizon-verifier.ts confirms the incoming payment (`lock`), while
    // `eth_to_xlm` delivers XLM (`settle`).  xlm-refund.ts covers `refund`.
    stellar: ["observe", "lock", "settle", "refund"],
    // No Solana settlement code exists — only placeholder detection and a
    // gauge.  Declaring an empty action set keeps that fact machine-readable.
    solana: [],
  },
  resolver: {
    // resolver/src/listeners/ethereum.ts observes; commands/register.ts stakes.
    ethereum: ["observe", "claim", "refund", "register"],
    // resolver/src/listeners/soroban.ts observes and can claim/refund, but
    // registry staking is EVM-only in this repo (see commands/register.ts).
    stellar: ["observe", "claim", "refund"],
    solana: [],
  },
} as const;

/**
 * Which asset classes each runtime can actually move, per chain.
 *
 * Narrower than what the on-chain ABIs accept, on purpose.  The relayer's order
 * path hard-codes `token: address(0)` and settles XLM payments, so native is
 * the only truthful answer for it today — declaring `erc20` here would let the
 * bridge accept a USDC request and silently escrow native ETH instead.
 */
export const IMPLEMENTED_TOKEN_CLASSES: Readonly<
  Record<RuntimeKind, Readonly<Record<SupportedChain, readonly TokenClass[]>>>
> = {
  relayer: {
    ethereum: ["native"],
    stellar: ["native"],
    solana: [],
  },
  resolver: {
    // HTLC escrow events carry a token address, so the resolver is asset-generic
    // on the chains it observes.
    ethereum: ["native", "erc20"],
    stellar: ["native", "stellar-asset"],
    solana: [],
  },
} as const;

/**
 * The actions a route's source and destination legs each require, per runtime.
 *
 * Exported so route decisions are inspectable rather than implied: a relayer
 * route needs the source chain to `lock` and the destination chain to `settle`,
 * whereas a resolver route needs to `observe` the source and `claim` the
 * destination.
 */
export const ROUTE_ACTION_REQUIREMENTS: Readonly<
  Record<RuntimeKind, { readonly source: readonly SupportedAction[]; readonly destination: readonly SupportedAction[] }>
> = {
  relayer: { source: ["lock"], destination: ["settle"] },
  resolver: { source: ["observe"], destination: ["claim"] },
} as const;

// ── Policy shape ──────────────────────────────────────────────────────────────

/** Declared capability for one chain within one runtime's policy. */
export interface ChainSupport {
  chain: SupportedChain;
  level: SupportLevel;
  /** Actions available right now: implemented ∩ configured. May be empty. */
  actions: readonly SupportedAction[];
  /** Asset classes available right now. May be empty. */
  tokenClasses: readonly TokenClass[];
  /**
   * Why capability is reduced.  Non-null for every level except `"full"`, so
   * logs and `/support` can always explain a limitation instead of just
   * reporting one.  `validateSupportPolicy` enforces this.
   */
  reason: string | null;
}

/** A source→destination pair the runtime can actually carry end to end. */
export interface RouteSupport {
  from: SupportedChain;
  to: SupportedChain;
  /** Source-side asset classes this route accepts. Never empty. */
  tokenClasses: readonly TokenClass[];
}

/**
 * The complete, typed statement of what a runtime supports.
 *
 * `chains` is a total record: every `SupportedChain` must carry a stance, so a
 * newly added chain cannot be quietly omitted.
 */
export interface SupportPolicy {
  runtime: RuntimeKind;
  network: NetworkMode;
  chains: Readonly<Record<SupportedChain, ChainSupport>>;
  routes: readonly RouteSupport[];
}

// ── Verdicts ──────────────────────────────────────────────────────────────────

/** Why a capability check said no.  Stable identifiers, safe for metrics. */
export type SupportDenialCode =
  /** The identifier is not a chain this bridge knows about. */
  | "CHAIN_UNKNOWN"
  /** Known chain, but this runtime has no code path for it. */
  | "CHAIN_UNIMPLEMENTED"
  /** Known and implemented, but required config is absent. */
  | "CHAIN_UNCONFIGURED"
  /** Config present but a placeholder sentinel. */
  | "CHAIN_PLACEHOLDER"
  /** Chain is usable, but not for the requested action. */
  | "ACTION_UNSUPPORTED"
  /** Chain is usable, but not for the requested asset class. */
  | "TOKEN_CLASS_UNSUPPORTED"
  /** Both chains are usable but the pairing is not carried end to end. */
  | "ROUTE_UNSUPPORTED"
  /** Source and destination are the same chain — not a bridge route. */
  | "ROUTE_SAME_CHAIN";

/**
 * A refusal, carrying both a stable code and an explanation.
 *
 * Named separately from `SupportVerdict` so consumers compiled without
 * `strictNullChecks` — the relayer, currently `"strict": false` — can reach the
 * denial fields explicitly, since discriminated-union narrowing is unavailable
 * to them.
 */
export interface SupportDenial {
  supported: false;
  code: SupportDenialCode;
  reason: string;
}

/**
 * The result of a capability check.  Denials always carry a machine-readable
 * `code` and a human-readable `reason`; callers should surface both rather than
 * collapsing the answer to a boolean.
 */
export type SupportVerdict = { supported: true } | SupportDenial;

const SUPPORTED: SupportVerdict = { supported: true };

function deny(code: SupportDenialCode, reason: string): SupportVerdict {
  return { supported: false, code, reason };
}

/** Map a non-usable `SupportLevel` onto the denial code that describes it. */
function levelDenialCode(level: SupportLevel): SupportDenialCode {
  switch (level) {
    case "unimplemented":
      return "CHAIN_UNIMPLEMENTED";
    case "placeholder":
      return "CHAIN_PLACEHOLDER";
    default:
      return "CHAIN_UNCONFIGURED";
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Look up a chain's declared support, accepting aliases.
 * Returns `null` for identifiers outside `SupportedChain`.
 */
export function getChainSupport(
  policy: SupportPolicy,
  chain: string
): ChainSupport | null {
  const canonical = normaliseChain(chain);
  return canonical ? policy.chains[canonical] : null;
}

/**
 * Can this runtime do *anything* on `chain`?
 *
 * True only when at least one action is available — a chain whose config is
 * missing is a denial, not a degraded yes.
 */
export function supportsChain(policy: SupportPolicy, chain: string): SupportVerdict {
  const canonical = normaliseChain(chain);
  if (!canonical) {
    return deny(
      "CHAIN_UNKNOWN",
      `"${chain}" is not a known chain (expected one of: ${SUPPORTED_CHAINS.join(", ")})`
    );
  }
  const support = policy.chains[canonical];
  if (support.actions.length === 0) {
    return deny(
      levelDenialCode(support.level),
      support.reason ?? `${policy.runtime} has no capability on ${canonical}`
    );
  }
  return SUPPORTED;
}

/** Can this runtime perform `action` on `chain` right now? */
export function supportsAction(
  policy: SupportPolicy,
  chain: string,
  action: SupportedAction
): SupportVerdict {
  const chainVerdict = supportsChain(policy, chain);
  if (!chainVerdict.supported) return chainVerdict;

  const canonical = normaliseChain(chain) as SupportedChain;
  const support = policy.chains[canonical];
  if (!support.actions.includes(action)) {
    const implemented = IMPLEMENTED_ACTIONS[policy.runtime][canonical];
    const detail = implemented.includes(action)
      ? support.reason ?? "required configuration is absent"
      : `no ${policy.runtime} code path implements "${action}" on ${canonical}`;
    return deny(
      "ACTION_UNSUPPORTED",
      `${policy.runtime} cannot "${action}" on ${canonical}: ${detail} ` +
        `(available: ${support.actions.join(", ") || "none"})`
    );
  }
  return SUPPORTED;
}

/** Can this runtime handle `tokenClass` on `chain`? */
export function supportsTokenClass(
  policy: SupportPolicy,
  chain: string,
  tokenClass: string
): SupportVerdict {
  const chainVerdict = supportsChain(policy, chain);
  if (!chainVerdict.supported) return chainVerdict;

  const canonical = normaliseChain(chain) as SupportedChain;
  const support = policy.chains[canonical];
  if (!support.tokenClasses.includes(tokenClass as TokenClass)) {
    return deny(
      "TOKEN_CLASS_UNSUPPORTED",
      `${policy.runtime} cannot handle "${tokenClass}" assets on ${canonical} ` +
        `(supported: ${support.tokenClasses.join(", ") || "none"})`
    );
  }
  return SUPPORTED;
}

/** A route lookup. `from` / `to` accept aliases; `tokenClass` is optional. */
export interface RouteQuery {
  from: string;
  to: string;
  /** When given, the source-side asset class must also be supported. */
  tokenClass?: string | null;
}

/**
 * Can this runtime carry a bridge leg from `from` to `to`?
 *
 * Checks are ordered cheapest-and-most-specific first so the returned reason
 * names the actual defect: unknown chain, then same-chain, then per-chain
 * capability, then the route pairing, then the asset class.
 */
export function supportsRoute(policy: SupportPolicy, query: RouteQuery): SupportVerdict {
  const from = normaliseChain(query.from);
  const to = normaliseChain(query.to);

  if (!from) {
    return deny(
      "CHAIN_UNKNOWN",
      `source chain "${query.from}" is not a known chain ` +
        `(expected one of: ${SUPPORTED_CHAINS.join(", ")})`
    );
  }
  if (!to) {
    return deny(
      "CHAIN_UNKNOWN",
      `destination chain "${query.to}" is not a known chain ` +
        `(expected one of: ${SUPPORTED_CHAINS.join(", ")})`
    );
  }
  if (from === to) {
    return deny(
      "ROUTE_SAME_CHAIN",
      `source and destination are both ${from} — a bridge route must cross chains`
    );
  }

  const requirements = ROUTE_ACTION_REQUIREMENTS[policy.runtime];
  for (const action of requirements.source) {
    const verdict = supportsAction(policy, from, action);
    if (!verdict.supported) {
      return deny(
        verdict.code,
        `route ${from}→${to} unavailable on the source leg: ${verdict.reason}`
      );
    }
  }
  for (const action of requirements.destination) {
    const verdict = supportsAction(policy, to, action);
    if (!verdict.supported) {
      return deny(
        verdict.code,
        `route ${from}→${to} unavailable on the destination leg: ${verdict.reason}`
      );
    }
  }

  const route = policy.routes.find((r) => r.from === from && r.to === to);
  if (!route) {
    return deny(
      "ROUTE_UNSUPPORTED",
      `${policy.runtime} does not declare route ${from}→${to} ` +
        `(declared: ${policy.routes.map((r) => `${r.from}→${r.to}`).join(", ") || "none"})`
    );
  }

  if (query.tokenClass !== undefined && query.tokenClass !== null) {
    if (!route.tokenClasses.includes(query.tokenClass as TokenClass)) {
      return deny(
        "TOKEN_CLASS_UNSUPPORTED",
        `route ${from}→${to} does not accept "${query.tokenClass}" assets ` +
          `(accepted: ${route.tokenClasses.join(", ") || "none"})`
      );
    }
  }

  return SUPPORTED;
}

/** `true` when the runtime can carry at least one route end to end. */
export function isActionable(policy: SupportPolicy): boolean {
  return policy.routes.length > 0;
}

// ── Route generation ──────────────────────────────────────────────────────────

/**
 * Derive the supported route set from per-chain capability.
 *
 * A route exists when the source chain offers every source-leg action and the
 * destination chain offers every destination-leg action for this runtime.  The
 * route's asset classes are the *source* chain's — the source leg is what
 * constrains which asset a user may bring.
 *
 * Deriving rather than hand-listing is the point: a chain that loses its signer
 * at deploy time drops its routes automatically, with no second list to update.
 */
export function generateRoutes(
  runtime: RuntimeKind,
  chains: Readonly<Record<SupportedChain, ChainSupport>>
): RouteSupport[] {
  const { source, destination } = ROUTE_ACTION_REQUIREMENTS[runtime];
  const routes: RouteSupport[] = [];

  for (const from of SUPPORTED_CHAINS) {
    for (const to of SUPPORTED_CHAINS) {
      if (from === to) continue;
      const fromSupport = chains[from];
      const toSupport = chains[to];

      const sourceOk = source.every((a) => fromSupport.actions.includes(a));
      const destOk = destination.every((a) => toSupport.actions.includes(a));
      if (!sourceOk || !destOk) continue;
      // A route with no transportable asset class is not a usable route.
      if (fromSupport.tokenClasses.length === 0) continue;

      routes.push({ from, to, tokenClasses: fromSupport.tokenClasses });
    }
  }

  return routes;
}

// ── Startup validation ────────────────────────────────────────────────────────

/** A condition that makes the policy unusable or self-contradictory. */
export type SupportPolicyErrorCode =
  /** Zero chains offer any action — the runtime cannot do anything. */
  | "NO_SUPPORTED_CHAIN"
  /** No route can be carried end to end — the runtime cannot bridge. */
  | "NO_SUPPORTED_ROUTE"
  /** A chain claims actions its runtime has no code path for. */
  | "ACTION_NOT_IMPLEMENTED"
  /** A chain's level says "unusable" but it still lists actions. */
  | "LEVEL_CONTRADICTS_ACTIONS"
  /** A chain offers actions but no asset class to apply them to. */
  | "MISSING_TOKEN_CLASS"
  /** A declared route names a chain that lacks the required leg actions. */
  | "ROUTE_CHAIN_INCAPABLE"
  /** A reduced level carries no explanation, so it cannot be reported. */
  | "REASON_MISSING";

export interface SupportPolicyError {
  code: SupportPolicyErrorCode;
  message: string;
  /** The chain or route the problem attaches to, for log correlation. */
  subject: string;
}

/** A limitation worth surfacing that does not prevent startup. */
export type SupportPolicyWarningCode =
  | "CHAIN_OBSERVE_ONLY"
  | "CHAIN_PARTIAL"
  | "CHAIN_UNCONFIGURED"
  | "CHAIN_PLACEHOLDER"
  | "CHAIN_UNIMPLEMENTED"
  | "PARTIAL_ROUTE_COVERAGE";

export interface SupportPolicyWarning {
  code: SupportPolicyWarningCode;
  message: string;
  subject: string;
}

export interface SupportPolicyValidation {
  /** `true` when there are zero errors. Warnings do not affect `ok`. */
  ok: boolean;
  errors: SupportPolicyError[];
  warnings: SupportPolicyWarning[];
}

/**
 * Check a policy for internal contradictions and dead ends.
 *
 * Never throws — callers inspect `ok`.  Two distinct classes of problem are
 * reported: a policy that claims capability it cannot have (a bug in a builder
 * or a hand-written policy), and a policy that is coherent but cannot do
 * anything useful (a deployment misconfiguration).  Both should stop startup;
 * warnings describe reduced-but-workable states.
 */
export function validateSupportPolicy(policy: SupportPolicy): SupportPolicyValidation {
  const errors: SupportPolicyError[] = [];
  const warnings: SupportPolicyWarning[] = [];

  for (const chain of SUPPORTED_CHAINS) {
    const support = policy.chains[chain];
    const implemented = IMPLEMENTED_ACTIONS[policy.runtime][chain];

    // Claiming an action with no code path behind it is the exact assumption
    // this contract exists to eliminate.
    for (const action of support.actions) {
      if (!implemented.includes(action)) {
        errors.push({
          code: "ACTION_NOT_IMPLEMENTED",
          subject: chain,
          message:
            `${policy.runtime} policy claims "${action}" on ${chain}, but no such ` +
            `code path is implemented (implemented: ${implemented.join(", ") || "none"})`,
        });
      }
    }

    const unusableLevel =
      support.level === "unconfigured" ||
      support.level === "placeholder" ||
      support.level === "unimplemented";

    if (unusableLevel && support.actions.length > 0) {
      errors.push({
        code: "LEVEL_CONTRADICTS_ACTIONS",
        subject: chain,
        message:
          `${chain} is marked "${support.level}" but still lists actions ` +
          `[${support.actions.join(", ")}] — level and actions must agree`,
      });
    }

    if (support.actions.length > 0 && support.tokenClasses.length === 0) {
      errors.push({
        code: "MISSING_TOKEN_CLASS",
        subject: chain,
        message:
          `${chain} offers actions [${support.actions.join(", ")}] but declares no ` +
          `token class — there is no asset those actions could apply to`,
      });
    }

    if (support.level !== "full" && !support.reason) {
      errors.push({
        code: "REASON_MISSING",
        subject: chain,
        message:
          `${chain} has reduced support level "${support.level}" but no reason — ` +
          `a limitation that cannot be explained cannot be operated`,
      });
    }

    switch (support.level) {
      case "observe-only":
        warnings.push({
          code: "CHAIN_OBSERVE_ONLY",
          subject: chain,
          message: `${chain} is observe-only: ${support.reason ?? "no signing capability"}`,
        });
        break;
      case "partial":
        warnings.push({
          code: "CHAIN_PARTIAL",
          subject: chain,
          message:
            `${chain} is partially configured (available: ${support.actions.join(", ")}): ` +
            `${support.reason ?? "some actions unavailable"}`,
        });
        break;
      case "unconfigured":
        warnings.push({
          code: "CHAIN_UNCONFIGURED",
          subject: chain,
          message: `${chain} is unconfigured: ${support.reason ?? "required config absent"}`,
        });
        break;
      case "placeholder":
        warnings.push({
          code: "CHAIN_PLACEHOLDER",
          subject: chain,
          message: `${chain} is a placeholder: ${support.reason ?? "placeholder config value"}`,
        });
        break;
      case "unimplemented":
        warnings.push({
          code: "CHAIN_UNIMPLEMENTED",
          subject: chain,
          message: `${chain} is unimplemented: ${support.reason ?? "no code path"}`,
        });
        break;
      default:
        break;
    }
  }

  // Declared routes must be backed by the chain capability they depend on.
  const requirements = ROUTE_ACTION_REQUIREMENTS[policy.runtime];
  for (const route of policy.routes) {
    const subject = `${route.from}→${route.to}`;
    for (const action of requirements.source) {
      if (!policy.chains[route.from].actions.includes(action)) {
        errors.push({
          code: "ROUTE_CHAIN_INCAPABLE",
          subject,
          message:
            `route ${subject} is declared, but source chain ${route.from} cannot ` +
            `"${action}" — the route could never complete`,
        });
      }
    }
    for (const action of requirements.destination) {
      if (!policy.chains[route.to].actions.includes(action)) {
        errors.push({
          code: "ROUTE_CHAIN_INCAPABLE",
          subject,
          message:
            `route ${subject} is declared, but destination chain ${route.to} cannot ` +
            `"${action}" — funds could be locked with no way to settle`,
        });
      }
    }
    if (route.tokenClasses.length === 0) {
      errors.push({
        code: "MISSING_TOKEN_CLASS",
        subject,
        message: `route ${subject} accepts no token class, so no asset can cross it`,
      });
    }
  }

  const usableChains = SUPPORTED_CHAINS.filter(
    (c) => policy.chains[c].actions.length > 0
  );
  if (usableChains.length === 0) {
    errors.push({
      code: "NO_SUPPORTED_CHAIN",
      subject: policy.runtime,
      message:
        `${policy.runtime} has no capability on any chain — check RPC endpoints, ` +
        `contract addresses and signing keys`,
    });
  }
  if (policy.routes.length === 0) {
    errors.push({
      code: "NO_SUPPORTED_ROUTE",
      subject: policy.runtime,
      message:
        `${policy.runtime} cannot carry any route end to end — it would accept no ` +
        `work.  Required per route: source "${requirements.source.join(", ")}", ` +
        `destination "${requirements.destination.join(", ")}"`,
    });
  }

  // Total possible ordered pairs across known chains.
  const totalPairs = SUPPORTED_CHAINS.length * (SUPPORTED_CHAINS.length - 1);
  if (policy.routes.length > 0 && policy.routes.length < totalPairs) {
    warnings.push({
      code: "PARTIAL_ROUTE_COVERAGE",
      subject: policy.runtime,
      message:
        `${policy.routes.length} of ${totalPairs} possible chain pairs are supported — ` +
        `unsupported pairs will be rejected at dispatch`,
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Thrown by `assertSupportPolicy` when a policy cannot be operated. */
export class SupportPolicyValidationError extends Error {
  readonly errors: SupportPolicyError[];
  readonly warnings: SupportPolicyWarning[];

  constructor(validation: SupportPolicyValidation, runtime: RuntimeKind) {
    const detail = validation.errors.map((e) => `  - [${e.code}] ${e.message}`).join("\n");
    super(`${runtime} support policy is invalid:\n${detail}`);
    this.name = "SupportPolicyValidationError";
    this.errors = validation.errors;
    this.warnings = validation.warnings;
  }
}

/**
 * Validate a policy and throw when it cannot be operated.
 *
 * Call this during startup, before any listener attaches or any HTTP route is
 * served, so a runtime that cannot do its job never reports itself ready.
 */
export function assertSupportPolicy(policy: SupportPolicy): void {
  const validation = validateSupportPolicy(policy);
  if (!validation.ok) {
    throw new SupportPolicyValidationError(validation, policy.runtime);
  }
}

// ── Introspection ─────────────────────────────────────────────────────────────

/** A chain pair this runtime will refuse, with the reason it refuses. */
export interface UnsupportedRouteReport {
  from: SupportedChain;
  to: SupportedChain;
  code: SupportDenialCode;
  reason: string;
}

/** JSON-serialisable description of a policy, for logs, `/support` and docs. */
export interface SupportPolicySummary {
  runtime: RuntimeKind;
  network: NetworkMode;
  /** `true` when at least one route can be carried end to end. */
  actionable: boolean;
  chains: Array<{
    chain: SupportedChain;
    level: SupportLevel;
    actions: readonly SupportedAction[];
    tokenClasses: readonly TokenClass[];
    reason: string | null;
  }>;
  routes: Array<{
    /** Stable `"from→to"` identifier, convenient as a metric label. */
    id: string;
    from: SupportedChain;
    to: SupportedChain;
    tokenClasses: readonly TokenClass[];
  }>;
  /**
   * Every chain pair that will be rejected, and why.  Publishing the negative
   * space is the point: an operator can see what the runtime will refuse
   * without having to reproduce a failure to find out.
   */
  unsupportedRoutes: UnsupportedRouteReport[];
}

/**
 * Describe a policy as plain data.
 *
 * Contains no secrets: only chain names, action names, asset classes and
 * reasons.  Reasons are generated by this module and never interpolate key
 * material or RPC URLs, so the payload is safe to log and to serve.
 */
export function describeSupportPolicy(policy: SupportPolicy): SupportPolicySummary {
  const unsupportedRoutes: UnsupportedRouteReport[] = [];

  for (const from of SUPPORTED_CHAINS) {
    for (const to of SUPPORTED_CHAINS) {
      if (from === to) continue;
      const verdict = supportsRoute(policy, { from, to });
      if (!verdict.supported) {
        unsupportedRoutes.push({ from, to, code: verdict.code, reason: verdict.reason });
      }
    }
  }

  return {
    runtime: policy.runtime,
    network: policy.network,
    actionable: isActionable(policy),
    chains: SUPPORTED_CHAINS.map((chain) => {
      const support = policy.chains[chain];
      return {
        chain,
        level: support.level,
        actions: support.actions,
        tokenClasses: support.tokenClasses,
        reason: support.reason,
      };
    }),
    routes: policy.routes.map((r) => ({
      id: `${r.from}→${r.to}`,
      from: r.from,
      to: r.to,
      tokenClasses: r.tokenClasses,
    })),
    unsupportedRoutes,
  };
}

/**
 * Render a policy as a multi-line operator-facing block.
 *
 * Written for the startup log, where it replaces the previous pattern of
 * printing a hard-coded chain list that did not reflect what the process could
 * actually do.
 */
export function formatSupportPolicy(policy: SupportPolicy): string {
  const summary = describeSupportPolicy(policy);
  const lines: string[] = [];

  lines.push(
    `${summary.runtime} support policy (${summary.network}) — ` +
      `${summary.actionable ? "actionable" : "NOT ACTIONABLE"}`
  );

  for (const chain of summary.chains) {
    const actions = chain.actions.length > 0 ? chain.actions.join(", ") : "none";
    const assets = chain.tokenClasses.length > 0 ? chain.tokenClasses.join(", ") : "none";
    lines.push(`  chain ${chain.chain}: ${chain.level} | actions: ${actions} | assets: ${assets}`);
    if (chain.reason) {
      lines.push(`    reason: ${chain.reason}`);
    }
  }

  if (summary.routes.length > 0) {
    for (const route of summary.routes) {
      lines.push(`  route ${route.id}: accepts ${route.tokenClasses.join(", ")}`);
    }
  } else {
    lines.push("  route (none) — this runtime cannot carry any bridge leg");
  }

  for (const route of summary.unsupportedRoutes) {
    lines.push(`  route ${route.from}→${route.to}: REJECTED [${route.code}]`);
  }

  return lines.join("\n");
}

// ── Builders ──────────────────────────────────────────────────────────────────

/**
 * `true` when a value is set but is a known placeholder sentinel.
 *
 * `isPlaceholderValue` treats "absent" and "still says YOUR_CONTRACT_ID" alike,
 * which is right for gating but wrong for reporting: the first is an incomplete
 * deployment, the second is a deployment step that was started and not
 * finished.  Distinguishing them is what makes the `"placeholder"` support level
 * meaningful rather than just another word for unconfigured.
 */
function isPresentButPlaceholder(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "" && isPlaceholderValue(value);
}

/**
 * Assemble a `ChainSupport` from the actions config has enabled.
 *
 * `available` is intersected with the implemented set rather than trusted, so a
 * builder cannot accidentally grant a capability the code does not have.  The
 * level is then derived from how much of the implemented set survived.
 */
function buildChainSupport(
  runtime: RuntimeKind,
  chain: SupportedChain,
  available: readonly SupportedAction[],
  opts: { unavailableReason: string | null; placeholder?: boolean }
): ChainSupport {
  const implemented = IMPLEMENTED_ACTIONS[runtime][chain];
  const tokenClasses = IMPLEMENTED_TOKEN_CLASSES[runtime][chain];

  if (implemented.length === 0) {
    return {
      chain,
      level: "unimplemented",
      actions: [],
      tokenClasses: [],
      // Prefer the caller's reason when it has more to say — e.g. that the
      // chain is *also* configured with a placeholder.  Being unimplemented is
      // the governing fact, but the config detail is still worth reporting.
      reason: opts.unavailableReason ?? `no ${runtime} code path exists for ${chain}`,
    };
  }

  const actions = implemented.filter((a) => available.includes(a));

  if (actions.length === 0) {
    return {
      chain,
      level: opts.placeholder ? "placeholder" : "unconfigured",
      actions: [],
      tokenClasses: [],
      reason: opts.unavailableReason ?? `${chain} configuration is absent`,
    };
  }

  if (actions.length === implemented.length) {
    return { chain, level: "full", actions, tokenClasses, reason: null };
  }

  const missing = implemented.filter((a) => !actions.includes(a));
  const onlyObserve = actions.length === 1 && actions[0] === "observe";

  return {
    chain,
    level: onlyObserve ? "observe-only" : "partial",
    actions,
    tokenClasses,
    reason:
      opts.unavailableReason ??
      `unavailable actions on ${chain}: ${missing.join(", ")}`,
  };
}

/**
 * The resolver config fields that determine capability.
 *
 * Structurally compatible with `ResolverConfig`, so `buildResolverSupportPolicy(cfg)`
 * accepts a loaded config directly while tests can pass a minimal literal.
 */
export interface ResolverSupportInput {
  network: NetworkMode;
  ethereum: {
    rpcUrl: string;
    htlcEscrow: string | null;
    resolverRegistry: string | null;
    resolverPrivateKey: string | null;
  };
  soroban: {
    rpcUrl: string;
    htlc: string | null;
    resolverRegistry: string | null;
    resolverSecret: string | null;
  };
}

/**
 * Derive the resolver's support policy from its loaded config.
 *
 * Capability rules, matching what the resolver's code actually requires:
 *  - `observe` needs only a usable RPC endpoint.
 *  - `claim` / `refund` need the HTLC contract *and* a signing key — a key
 *    without a contract, or a contract without a key, cannot settle.
 *  - `register` needs the ResolverRegistry address and an Ethereum key, and is
 *    implemented for Ethereum only.
 */
export function buildResolverSupportPolicy(input: ResolverSupportInput): SupportPolicy {
  const runtime: RuntimeKind = "resolver";

  // ── Ethereum ──
  const ethRpc = !isPlaceholderValue(input.ethereum.rpcUrl);
  const ethKey = !isPlaceholderValue(input.ethereum.resolverPrivateKey);
  const ethEscrow = !isPlaceholderValue(input.ethereum.htlcEscrow);
  const ethRegistry = !isPlaceholderValue(input.ethereum.resolverRegistry);

  const ethActions: SupportedAction[] = [];
  if (ethRpc) ethActions.push("observe");
  if (ethRpc && ethKey && ethEscrow) ethActions.push("claim", "refund");
  if (ethRpc && ethKey && ethRegistry) ethActions.push("register");

  const ethMissing: string[] = [];
  if (!ethRpc) ethMissing.push("ETHEREUM_RPC_URL");
  if (!ethKey) ethMissing.push("RESOLVER_ETH_PRIVATE_KEY");
  if (!ethEscrow) ethMissing.push("ETH_HTLC_ESCROW");
  if (!ethRegistry) ethMissing.push("ETH_RESOLVER_REGISTRY");

  // ── Stellar / Soroban ──
  const sorRpc = !isPlaceholderValue(input.soroban.rpcUrl);
  const sorSecret = !isPlaceholderValue(input.soroban.resolverSecret);
  const sorHtlc = !isPlaceholderValue(input.soroban.htlc);

  const stellarActions: SupportedAction[] = [];
  if (sorRpc) stellarActions.push("observe");
  if (sorRpc && sorSecret && sorHtlc) stellarActions.push("claim", "refund");

  const stellarMissing: string[] = [];
  if (!sorRpc) stellarMissing.push("SOROBAN_RPC_URL");
  if (!sorSecret) stellarMissing.push("RESOLVER_STELLAR_SECRET");
  if (!sorHtlc) stellarMissing.push("SOROBAN_HTLC_CONTRACT");

  const chains: Record<SupportedChain, ChainSupport> = {
    ethereum: buildChainSupport(runtime, "ethereum", ethActions, {
      unavailableReason:
        ethMissing.length > 0 ? `not configured: ${ethMissing.join(", ")}` : null,
      placeholder: [
        input.ethereum.rpcUrl,
        input.ethereum.htlcEscrow,
        input.ethereum.resolverRegistry,
      ].some(isPresentButPlaceholder),
    }),
    stellar: buildChainSupport(runtime, "stellar", stellarActions, {
      unavailableReason:
        stellarMissing.length > 0 ? `not configured: ${stellarMissing.join(", ")}` : null,
      placeholder: [input.soroban.rpcUrl, input.soroban.htlc].some(isPresentButPlaceholder),
    }),
    // The resolver has no Solana listener or claim path at all.
    solana: buildChainSupport(runtime, "solana", [], { unavailableReason: null }),
  };

  return {
    runtime,
    network: input.network,
    chains,
    routes: generateRoutes(runtime, chains),
  };
}

/**
 * The relayer config fields that determine capability.
 *
 * Structurally compatible with the relayer's `RELAYER_CONFIG` shape.  Contract
 * addresses are passed in rather than read from env here because the relayer
 * resolves them through its own network-aware table.
 */
export interface RelayerSupportInput {
  network: NetworkMode;
  ethereum: {
    rpcUrl: string;
    privateKey: string;
    /** EscrowFactory address for the active network. */
    escrowFactoryAddress?: string | null;
  };
  stellar: {
    horizonUrl: string;
    secretKey: string;
  };
  solana?: {
    rpcUrl?: string | null;
    programId?: string | null;
  };
}

/**
 * Derive the relayer's support policy from its loaded config.
 *
 * Capability rules, matching what the relayer's code actually requires:
 *  - `observe` needs only a usable endpoint (RPC for Ethereum, Horizon for Stellar).
 *  - Every write action on Ethereum needs the EscrowFactory address *and* the
 *    relayer's signing key — one without the other cannot move funds.
 *  - Write actions on Stellar need the relayer's Stellar secret; both the HTLC
 *    creation and the delivery payment are submitted with that key, so no
 *    contract address is involved.
 *  - Solana remains unimplemented regardless of config; a real program ID does
 *    not conjure a settlement path, so a configured-but-unimplemented Solana is
 *    still reported as unimplemented rather than as available.
 */
export function buildRelayerSupportPolicy(input: RelayerSupportInput): SupportPolicy {
  const runtime: RuntimeKind = "relayer";

  // ── Ethereum ──
  const ethRpc = !isPlaceholderValue(input.ethereum.rpcUrl);
  const ethKey = !isPlaceholderValue(input.ethereum.privateKey);
  const ethFactory = !isPlaceholderValue(input.ethereum.escrowFactoryAddress ?? null);

  const ethActions: SupportedAction[] = [];
  if (ethRpc) ethActions.push("observe");
  if (ethRpc && ethKey && ethFactory) {
    ethActions.push("lock", "claim", "settle", "refund");
  }

  const ethMissing: string[] = [];
  if (!ethRpc) ethMissing.push("ETHEREUM_RPC_URL");
  if (!ethKey) ethMissing.push("RELAYER_PRIVATE_KEY");
  if (!ethFactory) ethMissing.push("ESCROW_FACTORY_ADDRESS");

  // ── Stellar ──
  const horizon = !isPlaceholderValue(input.stellar.horizonUrl);
  const stellarKey = !isPlaceholderValue(input.stellar.secretKey);

  const stellarActions: SupportedAction[] = [];
  if (horizon) stellarActions.push("observe");
  if (horizon && stellarKey) stellarActions.push("lock", "settle", "refund");

  const stellarMissing: string[] = [];
  if (!horizon) stellarMissing.push("STELLAR_HORIZON_URL");
  if (!stellarKey) stellarMissing.push("RELAYER_STELLAR_SECRET");

  const solanaPlaceholder = isSolanaPlaceholder(input.solana?.programId ?? undefined);

  const chains: Record<SupportedChain, ChainSupport> = {
    ethereum: buildChainSupport(runtime, "ethereum", ethActions, {
      unavailableReason:
        ethMissing.length > 0 ? `not configured: ${ethMissing.join(", ")}` : null,
      placeholder: [input.ethereum.rpcUrl, input.ethereum.escrowFactoryAddress].some(
        isPresentButPlaceholder
      ),
    }),
    stellar: buildChainSupport(runtime, "stellar", stellarActions, {
      unavailableReason:
        stellarMissing.length > 0 ? `not configured: ${stellarMissing.join(", ")}` : null,
      placeholder: isPresentButPlaceholder(input.stellar.horizonUrl),
    }),
    solana: buildChainSupport(runtime, "solana", [], {
      unavailableReason: solanaPlaceholder
        ? "SOLANA_HTLC_PROGRAM is a placeholder and no settlement path is implemented"
        : "no relayer settlement path is implemented for Solana",
      placeholder: solanaPlaceholder,
    }),
  };

  return {
    runtime,
    network: input.network,
    chains,
    routes: generateRoutes(runtime, chains),
  };
}
