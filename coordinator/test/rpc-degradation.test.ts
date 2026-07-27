/**
 * Multi-chain RPC degradation matrix for the coordinator.
 *
 * The coordinator's /readyz endpoint is the operator-visible signal that a
 * chain RPC has gone bad. This suite proves that signal is honest under the
 * three deterministic failure shapes a real RPC node produces (see
 * test/fixtures/rpc-degradation.ts): a slow node that blows past the probe
 * timeout, a dropped connection, and a node that responds 200 OK but with a
 * JSON-RPC error envelope. It also proves degradation on one chain never
 * bleeds into a false report on another, and that a chain recovering is
 * reflected on the very next check (no latched/sticky failure state).
 */

import { describe, expect, it } from "vitest";
import express from "express";
import supertest from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CoordinatorConfig } from "../src/config.js";
import { openDatabase } from "../src/persistence/db.js";
import { createReadinessChecks } from "../src/readiness.js";
import { healthRoutes } from "../src/server/routes/health.js";
import { buildDegradedFetcher } from "./fixtures/rpc-degradation.js";

const baseConfig: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file:./wafflefinance.db",
  logLevel: "error",
  corsOrigin: "*",
  pollIntervalMs: 15_000,
  secretStorageKey: undefined,
  ethereum: {
    rpcUrl: "https://ethereum.example/rpc",
    chainId: 11_155_111,
    htlcEscrow: null,
    resolverRegistry: null
  },
  soroban: {
    rpcUrl: "https://soroban.example/rpc",
    horizonUrl: "https://horizon.example",
    networkPassphrase: "Test SDF Network ; September 2015",
    htlcContract: null,
    resolverRegistry: null
  },
  solana: {
    // Real-looking (non-placeholder) program id so the solana_rpc probe is
    // actually exercised by this matrix instead of being skipped.
    rpcUrl: "https://solana.example/rpc",
    programId: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    commitment: "confirmed"
  }
};

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-rpc-degradation-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

const okReconciliation = () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 });

async function runChecks(fetcher: ReturnType<typeof buildDegradedFetcher>, timeoutMs = 15) {
  const db = await freshDb();
  return createReadinessChecks({
    cfg: baseConfig,
    db,
    getReconciliationStatus: okReconciliation,
    fetcher,
    timeoutMs
  })();
}

function checkFor(checks: Awaited<ReturnType<typeof runChecks>>, name: string) {
  const check = checks.find((c) => c.name === name);
  expect(check, `expected a "${name}" check to be present`).toBeDefined();
  return check!;
}

describe("coordinator RPC degradation matrix", () => {
  describe("delayed responses (probe exceeds timeout)", () => {
    it("marks only the slow chain unhealthy, isolated from the others", async () => {
      const fetcher = buildDegradedFetcher({ ethereum: "delayed" }, { delayMs: 200 });
      const checks = await runChecks(fetcher, /* timeoutMs */ 15);

      expect(checkFor(checks, "ethereum_rpc").ok).toBe(false);
      expect(checkFor(checks, "ethereum_rpc").detail).toBe("unavailable");
      expect(checkFor(checks, "soroban_rpc").ok).toBe(true);
      expect(checkFor(checks, "solana_rpc").ok).toBe(true);
    });

    it("never reports overall readiness as ok while any chain is timing out", async () => {
      const fetcher = buildDegradedFetcher({ soroban: "delayed" }, { delayMs: 200 });
      const checks = await runChecks(fetcher, 15);

      expect(checks.every((c) => c.ok)).toBe(false);
    });
  });

  describe("connection resets", () => {
    it("marks a reset chain unhealthy without misreporting the others", async () => {
      const fetcher = buildDegradedFetcher({ solana: "reset" });
      const checks = await runChecks(fetcher);

      expect(checkFor(checks, "solana_rpc").ok).toBe(false);
      expect(checkFor(checks, "ethereum_rpc").ok).toBe(true);
      expect(checkFor(checks, "soroban_rpc").ok).toBe(true);
    });

    it("does not leak the RPC URL into the reset failure detail", async () => {
      const fetcher = buildDegradedFetcher({ ethereum: "reset" });
      const checks = await runChecks(fetcher);

      expect(JSON.stringify(checks)).not.toContain("ethereum.example");
    });
  });

  describe("partial receipts (HTTP 200 with a JSON-RPC error envelope)", () => {
    it("treats a 200 OK carrying an RPC error as unhealthy, not as success", async () => {
      const fetcher = buildDegradedFetcher({ soroban: "partial_receipt" });
      const checks = await runChecks(fetcher);

      expect(checkFor(checks, "soroban_rpc").ok).toBe(false);
    });
  });

  describe("simultaneous multi-chain degradation", () => {
    it("reports every affected chain as unhealthy at once, never a false-healthy summary", async () => {
      const fetcher = buildDegradedFetcher(
        { ethereum: "delayed", soroban: "reset", solana: "partial_receipt" },
        { delayMs: 200 }
      );
      const checks = await runChecks(fetcher, 15);

      expect(checkFor(checks, "ethereum_rpc").ok).toBe(false);
      expect(checkFor(checks, "soroban_rpc").ok).toBe(false);
      expect(checkFor(checks, "solana_rpc").ok).toBe(false);
      expect(checks.every((c) => c.ok)).toBe(false);
    });

    it("drives /readyz to HTTP 503 with status=degraded under simultaneous multi-chain failure", async () => {
      const db = await freshDb();
      const fetcher = buildDegradedFetcher(
        { ethereum: "reset", soroban: "delayed", solana: "partial_receipt" },
        { delayMs: 200 }
      );
      const getReadinessChecks = createReadinessChecks({
        cfg: baseConfig,
        db,
        getReconciliationStatus: okReconciliation,
        fetcher,
        timeoutMs: 15
      });

      const app = express();
      app.use(healthRoutes({ getReadinessChecks }));

      const res = await supertest(app).get("/readyz");

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
      const names = (res.body.checks as Array<{ name: string; ok: boolean }>).filter((c) => !c.ok).map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(["ethereum_rpc", "soroban_rpc", "solana_rpc"]));
    });
  });

  describe("recovery is reflected immediately (no latched failure state)", () => {
    it("reports healthy again on the next check once the chain recovers", async () => {
      const db = await freshDb();
      const degraded = buildDegradedFetcher({ ethereum: "reset" });
      const recovered = buildDegradedFetcher({});

      const first = await createReadinessChecks({
        cfg: baseConfig,
        db,
        getReconciliationStatus: okReconciliation,
        fetcher: degraded,
        timeoutMs: 15
      })();
      expect(checkFor(first, "ethereum_rpc").ok).toBe(false);

      const second = await createReadinessChecks({
        cfg: baseConfig,
        db,
        getReconciliationStatus: okReconciliation,
        fetcher: recovered,
        timeoutMs: 15
      })();
      expect(checkFor(second, "ethereum_rpc").ok).toBe(true);
    });
  });
});
