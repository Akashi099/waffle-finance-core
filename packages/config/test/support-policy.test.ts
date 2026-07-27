import { describe, it, expect } from "vitest";
import {
  IMPLEMENTED_ACTIONS,
  ROUTE_ACTION_REQUIREMENTS,
  SUPPORTED_CHAINS,
  SupportPolicyValidationError,
  assertSupportPolicy,
  buildRelayerSupportPolicy,
  buildResolverSupportPolicy,
  describeSupportPolicy,
  formatSupportPolicy,
  generateRoutes,
  getChainSupport,
  isActionable,
  isSupportedChain,
  normaliseChain,
  supportsAction,
  supportsChain,
  supportsRoute,
  supportsTokenClass,
  validateSupportPolicy,
  type ChainSupport,
  type RelayerSupportInput,
  type ResolverSupportInput,
  type SupportPolicy,
  type SupportedChain,
} from "../src/support-policy.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────
//
// Values are realistic rather than minimal: `isPlaceholderValue` rejects blanks,
// "YOUR_…" strings and well-known dummy addresses, so a fixture built from those
// would be indistinguishable from an unconfigured deployment.

const ETH_RPC = "https://sepolia.infura.io/v3/abc123";
const SOROBAN_RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const ETH_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const STELLAR_SECRET = "SBBQ6HLNPBBXOFMKHZ7KVQSKGDMBVDLXXBIYSNDUDJUP7DKGFFP6JG2C";
const ETH_ESCROW = "0x3f42E2F5D4C896a9CB62D0128175180a288de38A";
const ETH_REGISTRY = "0x0ABa862Da2F004bCa6ce2990EbC0f77184B6d3a8";
const SOROBAN_HTLC = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
const ESCROW_FACTORY = "0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a";

function resolverInput(overrides: Partial<ResolverSupportInput> = {}): ResolverSupportInput {
  return {
    network: overrides.network ?? "testnet",
    ethereum: {
      rpcUrl: ETH_RPC,
      htlcEscrow: ETH_ESCROW,
      resolverRegistry: ETH_REGISTRY,
      resolverPrivateKey: ETH_KEY,
      ...(overrides.ethereum ?? {}),
    },
    soroban: {
      rpcUrl: SOROBAN_RPC,
      htlc: SOROBAN_HTLC,
      resolverRegistry: SOROBAN_HTLC,
      resolverSecret: STELLAR_SECRET,
      ...(overrides.soroban ?? {}),
    },
  };
}

function relayerInput(overrides: Partial<RelayerSupportInput> = {}): RelayerSupportInput {
  return {
    network: overrides.network ?? "testnet",
    ethereum: {
      rpcUrl: ETH_RPC,
      privateKey: ETH_KEY,
      escrowFactoryAddress: ESCROW_FACTORY,
      ...(overrides.ethereum ?? {}),
    },
    stellar: {
      horizonUrl: HORIZON,
      secretKey: STELLAR_SECRET,
      ...(overrides.stellar ?? {}),
    },
    solana: overrides.solana ?? { programId: "PLACEHOLDER" },
  };
}

/** Build a hand-written policy for validator tests that need a broken input. */
function policyWith(
  runtime: "relayer" | "resolver",
  chains: Partial<Record<SupportedChain, Partial<ChainSupport>>>,
  routes: SupportPolicy["routes"] = []
): SupportPolicy {
  const base = (chain: SupportedChain): ChainSupport => ({
    chain,
    level: "unimplemented",
    actions: [],
    tokenClasses: [],
    reason: "fixture default",
  });
  return {
    runtime,
    network: "testnet",
    chains: {
      ethereum: { ...base("ethereum"), ...(chains.ethereum ?? {}) },
      stellar: { ...base("stellar"), ...(chains.stellar ?? {}) },
      solana: { ...base("solana"), ...(chains.solana ?? {}) },
    },
    routes,
  };
}

// ── Chain normalisation ───────────────────────────────────────────────────────

describe("normaliseChain", () => {
  it("maps canonical names to themselves", () => {
    expect(normaliseChain("ethereum")).toBe("ethereum");
    expect(normaliseChain("stellar")).toBe("stellar");
    expect(normaliseChain("solana")).toBe("solana");
  });

  it("maps the aliases already used across the repo", () => {
    // The resolver labels its metrics "soroban"; the frontend sends "stellar".
    expect(normaliseChain("soroban")).toBe("stellar");
    expect(normaliseChain("xlm")).toBe("stellar");
    expect(normaliseChain("eth")).toBe("ethereum");
    expect(normaliseChain("sepolia")).toBe("ethereum");
    expect(normaliseChain("sol")).toBe("solana");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normaliseChain("  ETHEREUM  ")).toBe("ethereum");
    expect(normaliseChain("Soroban")).toBe("stellar");
  });

  it("returns null for unknown, empty and nullish identifiers", () => {
    // Critically, an unknown chain must not fall back to a default.
    expect(normaliseChain("bitcoin")).toBeNull();
    expect(normaliseChain("")).toBeNull();
    expect(normaliseChain("   ")).toBeNull();
    expect(normaliseChain(null)).toBeNull();
    expect(normaliseChain(undefined)).toBeNull();
  });
});

describe("isSupportedChain", () => {
  it("accepts canonical ids only", () => {
    expect(isSupportedChain("ethereum")).toBe(true);
    expect(isSupportedChain("soroban")).toBe(false);
    expect(isSupportedChain(42)).toBe(false);
  });
});

// ── Resolver policy generation ────────────────────────────────────────────────

describe("buildResolverSupportPolicy — fully configured", () => {
  const policy = buildResolverSupportPolicy(resolverInput());

  it("reports full support on both implemented chains", () => {
    expect(policy.chains.ethereum.level).toBe("full");
    expect(policy.chains.ethereum.reason).toBeNull();
    expect(policy.chains.stellar.level).toBe("full");
    expect(policy.chains.stellar.reason).toBeNull();
  });

  it("grants exactly the implemented action set", () => {
    expect([...policy.chains.ethereum.actions].sort()).toEqual(
      [...IMPLEMENTED_ACTIONS.resolver.ethereum].sort()
    );
    expect([...policy.chains.stellar.actions].sort()).toEqual(
      [...IMPLEMENTED_ACTIONS.resolver.stellar].sort()
    );
  });

  it("does not claim registry staking on Stellar, which is EVM-only", () => {
    expect(policy.chains.ethereum.actions).toContain("register");
    expect(policy.chains.stellar.actions).not.toContain("register");
  });

  it("derives both cross-chain routes and no same-chain route", () => {
    expect(policy.routes.map((r) => `${r.from}->${r.to}`).sort()).toEqual([
      "ethereum->stellar",
      "stellar->ethereum",
    ]);
  });

  it("passes startup validation", () => {
    const validation = validateSupportPolicy(policy);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(isActionable(policy)).toBe(true);
  });
});

describe("buildResolverSupportPolicy — partially configured", () => {
  it("falls back to observe-only when the signing key is absent", () => {
    const policy = buildResolverSupportPolicy(
      resolverInput({
        ethereum: {
          rpcUrl: ETH_RPC,
          htlcEscrow: ETH_ESCROW,
          resolverRegistry: ETH_REGISTRY,
          resolverPrivateKey: null,
        },
      })
    );

    expect(policy.chains.ethereum.level).toBe("observe-only");
    expect(policy.chains.ethereum.actions).toEqual(["observe"]);
    // The reason must name the missing key, not the escrow that is present.
    expect(policy.chains.ethereum.reason).toContain("RESOLVER_ETH_PRIVATE_KEY");
    expect(policy.chains.ethereum.reason).not.toContain("ETH_HTLC_ESCROW");
  });

  it("reports partial when some but not all actions are configured", () => {
    // Key and registry present, HTLC escrow absent: staking works, claiming
    // does not.  This is the state the old boolean checks could not express.
    const policy = buildResolverSupportPolicy(
      resolverInput({
        ethereum: {
          rpcUrl: ETH_RPC,
          htlcEscrow: null,
          resolverRegistry: ETH_REGISTRY,
          resolverPrivateKey: ETH_KEY,
        },
      })
    );

    expect(policy.chains.ethereum.level).toBe("partial");
    expect([...policy.chains.ethereum.actions].sort()).toEqual(["observe", "register"]);
    expect(policy.chains.ethereum.actions).not.toContain("claim");
    expect(policy.chains.ethereum.reason).toContain("ETH_HTLC_ESCROW");
  });

  it("drops the routes that depend on an unclaimable destination", () => {
    // Stellar cannot claim, so ethereum→stellar cannot complete.  The reverse
    // route survives because Ethereum can still claim.
    const policy = buildResolverSupportPolicy(
      resolverInput({
        soroban: {
          rpcUrl: SOROBAN_RPC,
          htlc: SOROBAN_HTLC,
          resolverRegistry: SOROBAN_HTLC,
          resolverSecret: null,
        },
      })
    );

    expect(policy.chains.stellar.level).toBe("observe-only");
    expect(policy.routes.map((r) => `${r.from}->${r.to}`)).toEqual(["stellar->ethereum"]);

    const verdict = supportsRoute(policy, { from: "ethereum", to: "stellar" });
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) {
      expect(verdict.code).toBe("ACTION_UNSUPPORTED");
      expect(verdict.reason).toContain("destination leg");
    }
  });

  it("reports unconfigured and no routes when nothing is configured", () => {
    const policy = buildResolverSupportPolicy(
      resolverInput({
        ethereum: {
          rpcUrl: "",
          htlcEscrow: null,
          resolverRegistry: null,
          resolverPrivateKey: null,
        },
        soroban: { rpcUrl: "", htlc: null, resolverRegistry: null, resolverSecret: null },
      })
    );

    expect(policy.chains.ethereum.level).toBe("unconfigured");
    expect(policy.chains.ethereum.actions).toEqual([]);
    expect(policy.chains.stellar.level).toBe("unconfigured");
    expect(policy.routes).toEqual([]);
    expect(isActionable(policy)).toBe(false);
  });

  it("refuses to validate a runtime that cannot carry any route", () => {
    const policy = buildResolverSupportPolicy(
      resolverInput({
        ethereum: {
          rpcUrl: "",
          htlcEscrow: null,
          resolverRegistry: null,
          resolverPrivateKey: null,
        },
        soroban: { rpcUrl: "", htlc: null, resolverRegistry: null, resolverSecret: null },
      })
    );

    const validation = validateSupportPolicy(policy);
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((e) => e.code)).toContain("NO_SUPPORTED_CHAIN");
    expect(validation.errors.map((e) => e.code)).toContain("NO_SUPPORTED_ROUTE");
    expect(() => assertSupportPolicy(policy)).toThrow(SupportPolicyValidationError);
  });
});

describe("buildResolverSupportPolicy — Solana", () => {
  const policy = buildResolverSupportPolicy(resolverInput());

  it("declares Solana unimplemented rather than omitting it", () => {
    expect(policy.chains.solana.level).toBe("unimplemented");
    expect(policy.chains.solana.actions).toEqual([]);
    expect(policy.chains.solana.tokenClasses).toEqual([]);
    expect(policy.chains.solana.reason).toContain("no resolver code path");
  });

  it("refuses every Solana route", () => {
    for (const other of ["ethereum", "stellar"] as const) {
      expect(supportsRoute(policy, { from: "solana", to: other }).supported).toBe(false);
      expect(supportsRoute(policy, { from: other, to: "solana" }).supported).toBe(false);
    }
  });
});

// ── Relayer policy generation ─────────────────────────────────────────────────

describe("buildRelayerSupportPolicy — fully configured", () => {
  const policy = buildRelayerSupportPolicy(relayerInput());

  it("supports both bridge directions the order API implements", () => {
    expect(policy.routes.map((r) => `${r.from}->${r.to}`).sort()).toEqual([
      "ethereum->stellar",
      "stellar->ethereum",
    ]);
  });

  it("supports native assets only, matching the hard-coded token in the order path", () => {
    expect(policy.chains.ethereum.tokenClasses).toEqual(["native"]);
    expect(policy.chains.stellar.tokenClasses).toEqual(["native"]);
    expect(supportsTokenClass(policy, "ethereum", "native").supported).toBe(true);
    expect(supportsTokenClass(policy, "ethereum", "erc20").supported).toBe(false);
  });

  it("refuses an ERC-20 route rather than silently escrowing native ETH", () => {
    const verdict = supportsRoute(policy, {
      from: "ethereum",
      to: "stellar",
      tokenClass: "erc20",
    });
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) {
      expect(verdict.code).toBe("TOKEN_CLASS_UNSUPPORTED");
    }
  });

  it("passes startup validation", () => {
    expect(validateSupportPolicy(policy).ok).toBe(true);
  });
});

describe("buildRelayerSupportPolicy — partially configured", () => {
  it("loses every write action on Ethereum when the escrow factory is absent", () => {
    const policy = buildRelayerSupportPolicy(
      relayerInput({
        ethereum: { rpcUrl: ETH_RPC, privateKey: ETH_KEY, escrowFactoryAddress: null },
      })
    );

    expect(policy.chains.ethereum.level).toBe("observe-only");
    expect(policy.chains.ethereum.reason).toContain("ESCROW_FACTORY_ADDRESS");
    // Ethereum can no longer be a source (no lock) or a destination (no settle),
    // so no route survives.
    expect(policy.routes).toEqual([]);
    expect(validateSupportPolicy(policy).ok).toBe(false);
  });

  it("loses both routes when the Stellar secret is absent, as Stellar is source and destination", () => {
    const policy = buildRelayerSupportPolicy(
      relayerInput({ stellar: { horizonUrl: HORIZON, secretKey: "" } })
    );

    expect(policy.chains.stellar.level).toBe("observe-only");
    expect(policy.chains.stellar.reason).toContain("RELAYER_STELLAR_SECRET");
    // Stellar can no longer lock, so it cannot be a source; nor settle, so it
    // cannot be a destination.  Both directions of the bridge are gone.
    expect(policy.routes).toEqual([]);

    const outbound = supportsRoute(policy, { from: "stellar", to: "ethereum" });
    expect(outbound.supported).toBe(false);
    if (!outbound.supported) expect(outbound.reason).toContain("source leg");

    const inbound = supportsRoute(policy, { from: "ethereum", to: "stellar" });
    expect(inbound.supported).toBe(false);
    if (!inbound.supported) expect(inbound.reason).toContain("destination leg");
  });

  it("reports placeholder rather than unconfigured when a value is a sentinel", () => {
    // "Set to YOUR_… " is an unfinished deployment step, not an empty config —
    // the level distinguishes them so the operator knows which to fix.
    const policy = buildRelayerSupportPolicy(
      relayerInput({
        ethereum: {
          rpcUrl: "YOUR_ETHEREUM_RPC_URL",
          privateKey: "",
          escrowFactoryAddress: null,
        },
      })
    );
    expect(policy.chains.ethereum.level).toBe("placeholder");
    expect(policy.chains.ethereum.actions).toEqual([]);
  });

  it("records the placeholder program id in Solana's reason", () => {
    const policy = buildRelayerSupportPolicy(
      relayerInput({ solana: { programId: "YOUR_SOLANA_HTLC_PROGRAM" } })
    );
    // Being unimplemented is the governing fact, so the level stays
    // "unimplemented" — but the reason still reports the placeholder config, so
    // an operator setting SOLANA_HTLC_PROGRAM learns it will not be enough.
    expect(policy.chains.solana.level).toBe("unimplemented");
    expect(policy.chains.solana.actions).toEqual([]);
    expect(policy.chains.solana.reason).toContain("placeholder");
  });

  it("still refuses Solana when a real-looking program id is configured", () => {
    // Configuration cannot conjure a settlement path.  This is the case the old
    // placeholder gauge could not express: "configured but still unsupported".
    const policy = buildRelayerSupportPolicy(
      relayerInput({ solana: { programId: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" } })
    );
    expect(policy.chains.solana.level).toBe("unimplemented");
    expect(supportsChain(policy, "solana").supported).toBe(false);
  });
});

// ── Queries ───────────────────────────────────────────────────────────────────

describe("capability queries", () => {
  const policy = buildResolverSupportPolicy(resolverInput());

  it("resolves chain support through aliases", () => {
    expect(getChainSupport(policy, "soroban")?.chain).toBe("stellar");
    expect(getChainSupport(policy, "bitcoin")).toBeNull();
  });

  it("rejects unknown chains with CHAIN_UNKNOWN and lists the known ones", () => {
    const verdict = supportsChain(policy, "bitcoin");
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) {
      expect(verdict.code).toBe("CHAIN_UNKNOWN");
      for (const chain of SUPPORTED_CHAINS) expect(verdict.reason).toContain(chain);
    }
  });

  it("distinguishes an unimplemented action from an unconfigured one", () => {
    // "register" on Stellar has no code path at all.
    const unimplemented = supportsAction(policy, "stellar", "register");
    expect(unimplemented.supported).toBe(false);
    if (!unimplemented.supported) {
      expect(unimplemented.code).toBe("ACTION_UNSUPPORTED");
      expect(unimplemented.reason).toContain("no resolver code path implements");
    }

    // Whereas "claim" on Ethereum exists but needs config.
    const unconfigured = supportsAction(
      buildResolverSupportPolicy(
        resolverInput({
          ethereum: {
            rpcUrl: ETH_RPC,
            htlcEscrow: null,
            resolverRegistry: ETH_REGISTRY,
            resolverPrivateKey: ETH_KEY,
          },
        })
      ),
      "ethereum",
      "claim"
    );
    expect(unconfigured.supported).toBe(false);
    if (!unconfigured.supported) expect(unconfigured.reason).toContain("ETH_HTLC_ESCROW");
  });

  it("refuses a same-chain route", () => {
    const verdict = supportsRoute(policy, { from: "ethereum", to: "eth" });
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) expect(verdict.code).toBe("ROUTE_SAME_CHAIN");
  });

  it("names which leg is at fault for an unknown chain", () => {
    const from = supportsRoute(policy, { from: "bitcoin", to: "ethereum" });
    expect(from.supported).toBe(false);
    if (!from.supported) {
      expect(from.code).toBe("CHAIN_UNKNOWN");
      expect(from.reason).toContain("source chain");
    }

    const to = supportsRoute(policy, { from: "ethereum", to: "dogecoin" });
    expect(to.supported).toBe(false);
    if (!to.supported) expect(to.reason).toContain("destination chain");
  });

  it("accepts a supported route through aliases", () => {
    expect(supportsRoute(policy, { from: "eth", to: "soroban" }).supported).toBe(true);
  });
});

// ── Route generation ──────────────────────────────────────────────────────────

describe("generateRoutes", () => {
  it("requires the runtime's source and destination actions on the right legs", () => {
    // Ethereum can only observe; Stellar can only claim.  For a resolver
    // (source: observe, destination: claim) that yields exactly ethereum→stellar.
    const chains = policyWith("resolver", {
      ethereum: {
        level: "observe-only",
        actions: ["observe"],
        tokenClasses: ["native"],
        reason: "no key",
      },
      stellar: {
        level: "partial",
        actions: ["claim"],
        tokenClasses: ["native"],
        reason: "observe disabled",
      },
    }).chains;

    expect(generateRoutes("resolver", chains).map((r) => `${r.from}->${r.to}`)).toEqual([
      "ethereum->stellar",
    ]);
  });

  it("omits a route whose source has no transportable asset class", () => {
    // Ethereum has both leg actions, so only the empty asset list can exclude
    // it as a source — while it remains usable as a destination.
    const chains = policyWith("resolver", {
      ethereum: {
        level: "partial",
        actions: ["observe", "claim"],
        tokenClasses: [],
        reason: "no assets",
      },
      stellar: {
        level: "full",
        actions: ["observe", "claim", "refund"],
        tokenClasses: ["native"],
        reason: null,
      },
    }).chains;

    const routes = generateRoutes("resolver", chains);
    expect(routes.map((r) => `${r.from}->${r.to}`)).toEqual(["stellar->ethereum"]);
  });

  it("takes the route's asset classes from the source chain", () => {
    const policy = buildResolverSupportPolicy(resolverInput());
    const ethToStellar = policy.routes.find((r) => r.from === "ethereum");
    expect(ethToStellar?.tokenClasses).toEqual(policy.chains.ethereum.tokenClasses);
  });

  it("never produces a same-chain route", () => {
    const policy = buildRelayerSupportPolicy(relayerInput());
    expect(policy.routes.every((r) => r.from !== r.to)).toBe(true);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("validateSupportPolicy", () => {
  it("rejects a policy claiming an action with no code path", () => {
    const policy = policyWith(
      "resolver",
      {
        ethereum: {
          level: "full",
          // "settle" is a relayer action; the resolver has no such path.
          actions: ["observe", "claim", "refund", "register", "settle"],
          tokenClasses: ["native"],
          reason: null,
        },
        stellar: {
          level: "full",
          actions: ["observe", "claim", "refund"],
          tokenClasses: ["native"],
          reason: null,
        },
      },
      [{ from: "ethereum", to: "stellar", tokenClasses: ["native"] }]
    );

    const validation = validateSupportPolicy(policy);
    expect(validation.ok).toBe(false);
    const error = validation.errors.find((e) => e.code === "ACTION_NOT_IMPLEMENTED");
    expect(error?.subject).toBe("ethereum");
    expect(error?.message).toContain("settle");
  });

  it("rejects a level that contradicts its own action list", () => {
    const policy = policyWith(
      "resolver",
      {
        ethereum: {
          level: "unconfigured",
          actions: ["observe"],
          tokenClasses: ["native"],
          reason: "contradictory",
        },
        stellar: {
          level: "full",
          actions: ["observe", "claim", "refund"],
          tokenClasses: ["native"],
          reason: null,
        },
      },
      [{ from: "ethereum", to: "stellar", tokenClasses: ["native"] }]
    );

    expect(validateSupportPolicy(policy).errors.map((e) => e.code)).toContain(
      "LEVEL_CONTRADICTS_ACTIONS"
    );
  });

  it("rejects actions with no asset class to apply them to", () => {
    const policy = policyWith(
      "resolver",
      {
        ethereum: {
          level: "partial",
          actions: ["observe", "claim"],
          tokenClasses: [],
          reason: "no assets declared",
        },
        stellar: {
          level: "full",
          actions: ["observe", "claim", "refund"],
          tokenClasses: ["native"],
          reason: null,
        },
      },
      [{ from: "stellar", to: "ethereum", tokenClasses: ["native"] }]
    );

    expect(validateSupportPolicy(policy).errors.map((e) => e.code)).toContain(
      "MISSING_TOKEN_CLASS"
    );
  });

  it("rejects a reduced level with no explanation", () => {
    const policy = policyWith(
      "resolver",
      {
        ethereum: {
          level: "observe-only",
          actions: ["observe"],
          tokenClasses: ["native"],
          reason: null,
        },
        stellar: {
          level: "full",
          actions: ["observe", "claim", "refund"],
          tokenClasses: ["native"],
          reason: null,
        },
      },
      [{ from: "ethereum", to: "stellar", tokenClasses: ["native"] }]
    );

    const validation = validateSupportPolicy(policy);
    expect(validation.errors.map((e) => e.code)).toContain("REASON_MISSING");
  });

  it("rejects a declared route whose destination cannot settle it", () => {
    // The dangerous case: a route is advertised, funds would be locked on the
    // source leg, and the destination can do nothing.
    const policy = policyWith(
      "resolver",
      {
        ethereum: {
          level: "observe-only",
          actions: ["observe"],
          tokenClasses: ["native"],
          reason: "no key",
        },
        stellar: {
          level: "observe-only",
          actions: ["observe"],
          tokenClasses: ["native"],
          reason: "no secret",
        },
      },
      [{ from: "ethereum", to: "stellar", tokenClasses: ["native"] }]
    );

    const validation = validateSupportPolicy(policy);
    const error = validation.errors.find((e) => e.code === "ROUTE_CHAIN_INCAPABLE");
    expect(error?.subject).toBe("ethereum→stellar");
    expect(error?.message).toContain("claim");
  });

  it("warns without failing for reduced-but-workable states", () => {
    const policy = buildResolverSupportPolicy(
      resolverInput({
        ethereum: {
          rpcUrl: ETH_RPC,
          htlcEscrow: ETH_ESCROW,
          resolverRegistry: null,
          resolverPrivateKey: ETH_KEY,
        },
      })
    );

    const validation = validateSupportPolicy(policy);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.map((w) => w.code)).toContain("CHAIN_PARTIAL");
    // Solana is always reported, so operators never wonder about it.
    expect(validation.warnings.map((w) => w.code)).toContain("CHAIN_UNIMPLEMENTED");
    expect(validation.warnings.map((w) => w.code)).toContain("PARTIAL_ROUTE_COVERAGE");
  });

  it("throws with every problem listed when asserted", () => {
    const policy = policyWith("resolver", {});
    expect(() => assertSupportPolicy(policy)).toThrow(SupportPolicyValidationError);
    try {
      assertSupportPolicy(policy);
    } catch (err) {
      const typed = err as SupportPolicyValidationError;
      expect(typed.errors.length).toBeGreaterThan(0);
      expect(typed.message).toContain("resolver support policy is invalid");
    }
  });
});

// ── Introspection ─────────────────────────────────────────────────────────────

describe("describeSupportPolicy", () => {
  const policy = buildRelayerSupportPolicy(relayerInput());
  const summary = describeSupportPolicy(policy);

  it("describes every known chain, including the unsupported ones", () => {
    expect(summary.chains.map((c) => c.chain)).toEqual([...SUPPORTED_CHAINS]);
  });

  it("publishes the routes it will refuse together with the reason", () => {
    // Publishing the negative space is the point: an operator should not have
    // to trigger a failure to discover what is unsupported.
    expect(summary.unsupportedRoutes.length).toBeGreaterThan(0);
    for (const route of summary.unsupportedRoutes) {
      expect(route.code).toBeTruthy();
      expect(route.reason).toBeTruthy();
    }
    const pairs = summary.unsupportedRoutes.map((r) => `${r.from}->${r.to}`);
    expect(pairs).toContain("ethereum->solana");
    expect(pairs).toContain("solana->ethereum");
  });

  it("accounts for every ordered chain pair exactly once", () => {
    const total = SUPPORTED_CHAINS.length * (SUPPORTED_CHAINS.length - 1);
    expect(summary.routes.length + summary.unsupportedRoutes.length).toBe(total);
  });

  it("is JSON-serialisable and leaks no secrets", () => {
    const json = JSON.stringify(summary);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(summary)));
    expect(json).not.toContain(ETH_KEY);
    expect(json).not.toContain(STELLAR_SECRET);
    expect(json).not.toContain("infura");
  });

  it("marks a route-less runtime as not actionable", () => {
    const dead = buildRelayerSupportPolicy(
      relayerInput({ stellar: { horizonUrl: "", secretKey: "" } })
    );
    expect(describeSupportPolicy(dead).actionable).toBe(false);
  });
});

describe("formatSupportPolicy", () => {
  it("renders each chain, its level and its rejected routes", () => {
    const text = formatSupportPolicy(buildResolverSupportPolicy(resolverInput()));
    expect(text).toContain("resolver support policy (testnet)");
    expect(text).toContain("chain ethereum: full");
    expect(text).toContain("route ethereum→stellar");
    expect(text).toContain("REJECTED");
  });

  it("says so plainly when nothing is supported", () => {
    const text = formatSupportPolicy(
      buildResolverSupportPolicy(
        resolverInput({
          ethereum: {
            rpcUrl: "",
            htlcEscrow: null,
            resolverRegistry: null,
            resolverPrivateKey: null,
          },
          soroban: { rpcUrl: "", htlc: null, resolverRegistry: null, resolverSecret: null },
        })
      )
    );
    expect(text).toContain("NOT ACTIONABLE");
    expect(text).toContain("cannot carry any bridge leg");
  });
});

// ── Table invariants ──────────────────────────────────────────────────────────

describe("capability tables", () => {
  it("declares a stance on every chain for every runtime", () => {
    for (const runtime of ["relayer", "resolver"] as const) {
      for (const chain of SUPPORTED_CHAINS) {
        expect(IMPLEMENTED_ACTIONS[runtime][chain]).toBeDefined();
      }
    }
  });

  it("implements the actions its own route requirements depend on", () => {
    // A runtime whose route requirements name an action it never implements
    // could never support a route — catch that at test time, not at deploy time.
    for (const runtime of ["relayer", "resolver"] as const) {
      const { source, destination } = ROUTE_ACTION_REQUIREMENTS[runtime];
      const all = SUPPORTED_CHAINS.flatMap((c) => IMPLEMENTED_ACTIONS[runtime][c]);
      for (const action of [...source, ...destination]) {
        expect(all).toContain(action);
      }
    }
  });
});
