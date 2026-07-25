/**
 * Prometheus metrics for the archival lifecycle policy.
 */

import { Counter, Gauge } from "prom-client";
import { registry } from "../metrics.js";

/** Archival runs by result (success | failure). */
export const archivalRuns = new Counter({
  name: "coordinator_archival_runs_total",
  help: "Total stale-order archival runs, by result",
  labelNames: ["result"] as const,
  registers: [registry],
});

/** Orders archived per run. */
export const archivalOrdersArchived = new Counter({
  name: "coordinator_archival_orders_archived_total",
  help: "Total orders soft-deleted by the archival policy",
  registers: [registry],
});

/** Orders reactivated (unarchived) after an on-chain lock was discovered. */
export const archivalOrdersReactivated = new Counter({
  name: "coordinator_archival_orders_reactivated_total",
  help: "Total previously-archived orders reactivated by the recovery path",
  registers: [registry],
});

/** Unix timestamp of the last completed archival run. */
export const archivalLastRun = new Gauge({
  name: "coordinator_archival_last_run_timestamp_seconds",
  help: "Unix timestamp of the most recent archival run",
  registers: [registry],
});

/** Archival run errors. */
export const archivalErrors = new Counter({
  name: "coordinator_archival_errors_total",
  help: "Total archival run failures",
  registers: [registry],
});
