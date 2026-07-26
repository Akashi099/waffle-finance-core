import { describe, it, expect, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { supportsAction } from "@wafflefinance/config";
import { buildSupportPolicy, chainLabel, logSupportPolicy } from "../src/support.js";
import { createResolverHealthServer } from "../src/health.js";
import { Supervisor } from "../src/supervisor.js";
import type { ResolverConfig } from "../src/config.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ETH_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as `0x${string}`;
const STELLAR_SECRET = "SBBQ6HLNPBBXOFMKHZ7KVQSKGDMBVDLXXBIYSNDUDJUP7DKGFFP6JG2C";
const ETH_ESCROW = "0x3f42E2F5D4C896a9CB62D0128175180a288de38A" as `0x${string}`;
const ETH_REGISTRY = "0x0ABa862Da2F004bCa6ce2990EbC0f77184B6d3a8" as `0x${string}`;
const SOROBAN_HTLC = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

function cfg(overrides: {
  ethereum?: Partial<ResolverConfig["ethereum"]>;
  soroban?: Partial<ResolverConfig["soroban"]>;
} = {}): ResolverConfig {
  return {
    network: "testnet",
    pollIntervalMs: 15_000,
    coordinatorUrl: "http://localhost:3001",
    logLevel: "info",
    ethereum: {
      rpcUrl: "https://sepolia.infura.io/v3/abc123",
      chainId: 11_155_111,
      htlcEscrow: ETH_ESCROW,
      resolverRegistry: ETH_REGISTRY,
      resolverPrivateKey: ETH_KEY,
      ...(overrides.ethereum ?? {}),
    },
    soroban: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      htlc: SOROBAN_HTLC,
      resolverRegistry: SOROBAN_HTLC,
      resolverSecret: STELLAR_SECRET,
      ...(overrides.soroban ?? {}),
    },
    rpc: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 2000 },
  } as ResolverConfig;
}

/** Silent logger stub, matching the shape Supervisor requires. */
const silentLog = {
  child: () => silentLog,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
} as any;

/** Start a health server on an ephemeral port and return its base URL. */
async function startServer(deps: Parameters<typeof createResolverHealthServer>[0]) {
  const server = createResolverHealthServer(deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Chain labels ──────────────────────────────────────────────────────────────

describe("chainLabel", () => {
  it("keeps the metric label strings the resolver has always emitted", () => {
    // The policy's canonical id is "stellar", but dashboards and alert rules key
    // on "soroban" — renaming them would silently break existing queries.
    expect(chainLabel("ethereum")).toBe("ethereum");
    expect(chainLabel("stellar")).toBe("soroban");
    expect(chainLabel("solana")).toBe("solana");
  });
});

// ── Policy derivation from resolver config ────────────────────────────────────

describe("buildSupportPolicy", () => {
  it("grants full support on both chains when fully configured", () => {
    const policy = buildSupportPolicy(cfg());
    expect(policy.runtime).toBe("resolver");
    expect(policy.network).toBe("testnet");
    expect(policy.chains.ethereum.level).toBe("full");
    expect(policy.chains.stellar.level).toBe("full");
    expect(policy.routes).toHaveLength(2);
  });

  it("gates registry staking on both the registry address and the key", () => {
    expect(supportsAction(buildSupportPolicy(cfg()), "ethereum", "register").supported).toBe(
      true
    );

    const noRegistry = buildSupportPolicy(cfg({ ethereum: { resolverRegistry: null } }));
    const verdict = supportsAction(noRegistry, "ethereum", "register");
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) expect(verdict.reason).toContain("ETH_RESOLVER_REGISTRY");

    const noKey = buildSupportPolicy(cfg({ ethereum: { resolverPrivateKey: null } }));
    expect(supportsAction(noKey, "ethereum", "register").supported).toBe(false);
  });

  it("still observes a chain it cannot settle on", () => {
    // An observe-only resolver is a legitimate deployment — it just cannot fill.
    const policy = buildSupportPolicy(cfg({ ethereum: { resolverPrivateKey: null } }));
    expect(supportsAction(policy, "ethereum", "observe").supported).toBe(true);
    expect(supportsAction(policy, "ethereum", "claim").supported).toBe(false);
  });

  it("stops observing a chain whose RPC endpoint is absent", () => {
    const policy = buildSupportPolicy(cfg({ soroban: { rpcUrl: "" } }));
    expect(supportsAction(policy, "stellar", "observe").supported).toBe(false);
    expect(policy.chains.stellar.reason).toContain("SOROBAN_RPC_URL");
  });
});

describe("logSupportPolicy", () => {
  it("logs each warning and one description, without secrets", () => {
    const warn = vi.fn();
    const info = vi.fn();
    const log = { warn, info } as unknown as Parameters<typeof logSupportPolicy>[1];

    logSupportPolicy(buildSupportPolicy(cfg({ ethereum: { resolverRegistry: null } })), log);

    // Solana (unimplemented) and Ethereum (partial) both warrant a warning.
    expect(warn).toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);

    const logged = JSON.stringify([warn.mock.calls, info.mock.calls]);
    expect(logged).not.toContain(ETH_KEY);
    expect(logged).not.toContain(STELLAR_SECRET);
  });
});

// ── /support endpoint ─────────────────────────────────────────────────────────

describe("GET /support", () => {
  it("serves the declared capabilities when the resolver is actionable", async () => {
    const { baseUrl, close } = await startServer({ cfg: cfg(), supervisor: new Supervisor({ log: silentLog }) });
    try {
      const res = await fetch(`${baseUrl}/support`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.runtime).toBe("resolver");
      expect(body.actionable).toBe(true);
      expect(body.routes.map((r: { id: string }) => r.id).sort()).toEqual([
        "ethereum→stellar",
        "stellar→ethereum",
      ]);
      // The refused pairs are published too, with a reason each.
      expect(body.unsupportedRoutes.length).toBe(4);
      for (const refused of body.unsupportedRoutes) {
        expect(refused.reason).toBeTruthy();
      }
    } finally {
      await close();
    }
  });

  it("returns 503 when the resolver cannot carry any route", async () => {
    // "Running but useless" must be visible to monitoring rather than looking
    // healthy because the process is up.
    const { baseUrl, close } = await startServer({
      cfg: cfg({ ethereum: { rpcUrl: "" }, soroban: { rpcUrl: "" } }),
      supervisor: new Supervisor({ log: silentLog }),
    });
    try {
      const res = await fetch(`${baseUrl}/support`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.actionable).toBe(false);
    } finally {
      await close();
    }
  });

  it("exposes no key material", async () => {
    const { baseUrl, close } = await startServer({ cfg: cfg(), supervisor: new Supervisor({ log: silentLog }) });
    try {
      const text = await (await fetch(`${baseUrl}/support`)).text();
      expect(text).not.toContain(ETH_KEY);
      expect(text).not.toContain(STELLAR_SECRET);
      expect(text).not.toContain("infura");
    } finally {
      await close();
    }
  });
});

// ── Readiness detail accuracy ─────────────────────────────────────────────────

describe("readiness details", () => {
  it("names the missing signing key rather than blaming the escrow", async () => {
    // The previous implementation reported "missing_htlc_escrow" whenever either
    // value was absent, so this case pointed at the wrong field.
    const { baseUrl, close } = await startServer({
      cfg: cfg({ ethereum: { resolverPrivateKey: null } }),
      supervisor: new Supervisor({ log: silentLog }),
    });
    try {
      const body = await (await fetch(`${baseUrl}/readyz`)).json();
      const check = body.checks.find(
        (c: { name: string }) => c.name === "ethereum_config"
      );
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("RESOLVER_ETH_PRIVATE_KEY");
      expect(check.detail).not.toContain("ETH_HTLC_ESCROW");
      expect(check.level).toBe("observe-only");
    } finally {
      await close();
    }
  });

  it("names the missing escrow when that is the actual defect", async () => {
    const { baseUrl, close } = await startServer({
      cfg: cfg({ ethereum: { htlcEscrow: null } }),
      supervisor: new Supervisor({ log: silentLog }),
    });
    try {
      const body = await (await fetch(`${baseUrl}/readyz`)).json();
      const check = body.checks.find(
        (c: { name: string }) => c.name === "ethereum_config"
      );
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("ETH_HTLC_ESCROW");
      // Registry staking still works, so the chain is partial, not observe-only.
      expect(check.level).toBe("partial");
    } finally {
      await close();
    }
  });

  it("reports configured when the chain can claim", async () => {
    const { baseUrl, close } = await startServer({ cfg: cfg(), supervisor: new Supervisor({ log: silentLog }) });
    try {
      const body = await (await fetch(`${baseUrl}/readyz`)).json();
      for (const name of ["ethereum_config", "soroban_config"]) {
        const check = body.checks.find((c: { name: string }) => c.name === name);
        expect(check.ok).toBe(true);
        expect(check.detail).toBe("configured");
        expect(check.level).toBe("full");
      }
    } finally {
      await close();
    }
  });
});
