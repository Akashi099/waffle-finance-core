import { createServer, type Server, type ServerResponse } from "node:http";
import type { ResolverConfig } from "./config.js";
import type { Supervisor } from "./supervisor.js";
import type { ResolverStatusMonitor } from "./registry-status.js";
import { ResolverTelemetryCollector } from "./telemetry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResolverHealthDeps {
  cfg: ResolverConfig;
  supervisor: Supervisor;
  startedAt?: number;
  /**
   * Optional — when provided, readiness also reflects this resolver's own
   * registration/stake/slash standing (see registry-status.ts). Omitted in
   * tests/deployments that don't wire registry monitoring; readiness then
   * falls back to config-presence checks only.
   */
  registryStatus?: ResolverStatusMonitor;
  /** Chains to report liveness for on GET /telemetry. Defaults to ["ethereum", "soroban"]. */
  telemetryChains?: string[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function servicePayload(startedAt: number) {
  return {
    service: "wafflefinance-resolver",
    version: process.env.npm_package_version ?? "1.0.0",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build the per-dependency readiness checks.
 *
 * These are lightweight config-presence checks (no live RPC calls) so they
 * complete in microseconds and never block a health probe.
 */
function readinessChecks(deps: ResolverHealthDeps) {
  const { cfg, supervisor, registryStatus } = deps;

  const ethOk = Boolean(cfg.ethereum.htlcEscrow && cfg.ethereum.resolverPrivateKey);
  const sorobanOk = Boolean(cfg.soroban.htlc && cfg.soroban.resolverSecret);

  // "supervisor" check: ok when it is actively running or idle (not yet
  // started).  Not-ok when it has stopped due to exhausted restarts or a fatal
  // error.  Stopping due to a signal is a deliberate action and is reported
  // as ok=true with detail="stopping" so orchestration systems don't
  // immediately restart the pod before teardown completes.
  const supervisorState = supervisor.state;
  const supervisorOk =
    supervisorState === "idle" ||
    supervisorState === "running" ||
    supervisorState === "restarting" ||
    supervisorState === "stopping" ||
    supervisorState === "stopped";

  const checks = [
    {
      name: "ethereum_config",
      ok: ethOk,
      detail: ethOk ? "configured" : "missing_htlc_escrow",
    },
    {
      name: "soroban_config",
      ok: sorobanOk,
      detail: sorobanOk ? "configured" : "missing_htlc_contract",
    },
    {
      name: "supervisor",
      ok: supervisorOk,
      detail: supervisorState,
    },
  ];

  // Registry status: not-ready when this resolver's own on-chain standing on
  // any tracked chain is low_stake / slashed / unbonding / inactive. A chain
  // that has never been probed (registry not configured for it) reports
  // ok=true — see ResolverStatusMonitor.isReady().
  if (registryStatus) {
    const ready = registryStatus.isReady();
    checks.push({
      name: "registry_status",
      ok: ready,
      detail: ready ? "active" : "degraded",
    });
  }

  return checks;
}

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Create an HTTP server exposing three health endpoints:
 *
 * - `GET /healthz`   — liveness probe (always 200 while the process is alive).
 * - `GET /readyz`    — readiness probe (503 when a required dependency check fails).
 * - `GET /health`    — combined health payload with supervisor state and restart count.
 * - `GET /telemetry` — resolver runtime telemetry (connected/degraded/stale/inactive).
 */
export function createResolverHealthServer(deps: ResolverHealthDeps): Server {
  const startedAt = deps.startedAt ?? Date.now();
  const telemetryChains = deps.telemetryChains ?? ["ethereum", "soroban"];
  const telemetryCollector = new ResolverTelemetryCollector();

  return createServer((req, res) => {
    if (req.method !== "GET") {
      json(res, 405, { error: "method_not_allowed" });
      return;
    }

    // ── /healthz — liveness ──────────────────────────────────────────────
    // Always 200 while the process is alive. A failing liveness probe causes
    // the orchestrator to kill and replace the pod — only use for truly
    // unrecoverable states (not transient restart loops).
    if (req.url === "/healthz") {
      json(res, 200, {
        status: "ok",
        ...servicePayload(startedAt),
      });
      return;
    }

    // ── /readyz — readiness ──────────────────────────────────────────────
    // Returns 503 when a required dependency is missing or misconfigured.
    // Orchestration systems stop routing traffic to the pod when this fails.
    //
    // A supervisor in "stopping" state returns 503 so new traffic is not
    // routed to a pod that is mid-teardown.
    if (req.url === "/readyz") {
      const checks = readinessChecks(deps);
      const state = deps.supervisor.state;

      // Pods that are cleanly stopping should not receive new traffic.
      const isStoppingOrStopped =
        state === "stopping" || state === "stopped" || state === "failed";

      const allChecksOk = checks.every((c) => c.ok);
      const ok = allChecksOk && !isStoppingOrStopped;

      json(res, ok ? 200 : 503, {
        status: ok ? "ok" : "degraded",
        supervisorState: state,
        ...servicePayload(startedAt),
        checks,
      });
      return;
    }

    // ── /health — combined health ────────────────────────────────────────
    // Full health payload for dashboards and debugging.  Not used by
    // Kubernetes probes directly (too verbose for high-frequency polling).
    if (req.url === "/health") {
      const checks = readinessChecks(deps);
      const state = deps.supervisor.state;
      const dependencyFailures = checks.filter((c) => !c.ok);

      const overallStatus =
        state === "failed"
          ? "unhealthy"
          : state === "stopping" || state === "stopped"
            ? "stopping"
            : dependencyFailures.length > 0
              ? "degraded"
              : "healthy";

      json(res, state === "failed" ? 503 : 200, {
        status: overallStatus,
        supervisorState: state,
        restarts: deps.supervisor.restarts,
        ...servicePayload(startedAt),
        checks,
      });
      return;
    }

    // ── /telemetry — resolver runtime telemetry ──────────────────────────
    // Reports whether the resolver is connected, degraded, stale, or
    // inactive so operators can distinguish "delayed" from "not doing its
    // job" without reading raw logs. See src/telemetry.ts.
    if (req.url === "/telemetry") {
      telemetryCollector
        .collect({ supervisor: deps.supervisor, chains: telemetryChains })
        .then((snapshot) => {
          json(res, snapshot.state === "inactive" ? 503 : 200, {
            ...snapshot,
            ...servicePayload(startedAt),
          });
        })
        .catch((err) => {
          json(res, 500, { error: "telemetry_collection_failed", detail: String(err) });
        });
      return;
    }

    json(res, 404, { error: "not_found" });
  });
}

/**
 * Create and immediately start listening the resolver health server.
 */
export function startResolverHealthServer(deps: ResolverHealthDeps, port: number): Server {
  const server = createResolverHealthServer(deps);
  server.listen(port);
  return server;
}
