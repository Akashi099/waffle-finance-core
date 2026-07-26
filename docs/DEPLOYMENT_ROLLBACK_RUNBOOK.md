# Coordinator & Relayer: Deployment and Rollback Contract

A rollback-first runbook for redeploying the coordinator and relayer. It covers
configuration changes, restart behavior, secret rotation, and the decision
points for rolling back — grounded in this repo's actual health-check contract,
metrics, and config loading, not generic release advice.

Related docs: [docs/OPERATIONS.md](OPERATIONS.md) (contract deployment, DB
backup/restore, incident response), [coordinator/ops/RUNBOOK.md](../coordinator/ops/RUNBOOK.md)
(alert-driven on-call procedures), [docs/HEALTH_DASHBOARD.md](HEALTH_DASHBOARD.md)
(health/readiness contract shared by all services), [docs/QUALITY_GATE.md](QUALITY_GATE.md)
(why the numbers in this document must stay accurate).

## Deployment topology (as it actually exists in this repo)

| Service | Dockerfile in repo | Default port | Start command |
|---|---|---|---|
| `coordinator` | **None** — no `coordinator/Dockerfile` exists | `COORDINATOR_PORT` (default `3001`, see `packages/config/src/node.ts`) | `pnpm --filter @wafflefinance/coordinator start` → `node dist/index.js` |
| `relayer` | [`relayer/Dockerfile`](../relayer/Dockerfile) — multi-stage `node:22-alpine`, `EXPOSE 8080` | `8080` in the container image; `RELAYER_PORT`/`COORDINATOR_PORT` env fallback locally | `pnpm --filter @wafflefinance/relayer start` |
| `resolver` | [`resolver/Dockerfile`](../resolver/Dockerfile) — multi-stage `node:20-alpine` | N/A (`RESOLVER_HEALTH_PORT`, `RESOLVER_METRICS_PORT`) | `ENTRYPOINT ["node", "dist/index.js"] CMD ["run"]` |

**Operator note:** `coordinator/ops/RUNBOOK.md` and `coordinator/ops/QUICK_REFERENCE.md`
use `docker restart wafflefinance-coordinator` / `docker logs wafflefinance-coordinator`
as if the coordinator always runs in a named Docker container. Since there is no
committed `coordinator/Dockerfile`, that container must be built from an
external/undocumented image definition, or the coordinator is run as a bare
Node process by whatever platform hosts it (the `/api/*` proxy target in
[vercel.json](../vercel.json) points at a DigitalOcean App Platform URL, which
does not require a Dockerfile). **Before following any `docker restart
wafflefinance-coordinator` step below, confirm how your specific environment
actually runs the coordinator process** — the restart *mechanism* differs
(`docker restart <container>` vs. process manager restart vs. platform
redeploy), even though the verification sequence that follows is identical.

## Startup lifecycle (what "restarted successfully" means)

The coordinator's `/readyz` endpoint reports one of four `startup_phase`
values, derived in [coordinator/src/readiness.ts](../coordinator/src/readiness.ts):

| Phase | Meaning | HTTP status |
|---|---|---|
| `starting` | Process is up; database/RPC dependencies not yet confirmed | `503` |
| `pending` | Dependencies are up, but the first reconciliation pass hasn't completed | `200` |
| `ready` | All checks pass, including a completed reconciliation run | `200` |
| `degraded` | A previously-ready coordinator now has a failing dependency check | `503` |

A restart is **not complete** the moment the process starts responding — it is
complete when `/readyz` reports `ready` (not `pending`), because `pending`
means the coordinator hasn't yet replayed missed on-chain events for the
downtime window. The relayer and resolver do not have a `pending` phase — their
`/readyz` is a flat `ok`/`degraded` over their configured RPC checks (see
[relayer/src/routes/health.ts](../relayer/src/routes/health.ts) and
[resolver/src/health.ts](../resolver/src/health.ts)).

## Deployment and rollback contract

### 1. Before the change

- [ ] Confirm the change category: config-only (env var), code deploy, or both.
      Config-only changes to `env.example`-tracked variables still require a
      restart — nothing in this repo hot-reloads environment variables.
- [ ] Run `pnpm validate` (workspace manifest + dependency checks) and, for the
      package being changed, its test suite (e.g. `pnpm --filter
      @wafflefinance/coordinator test`, which includes
      [`coordinator/HANDOFF_SMOKE_TEST.md`](../coordinator/HANDOFF_SMOKE_TEST.md)'s
      handoff-smoke suite — a failure there means a service-boundary contract
      changed and must be resolved or deliberately accepted before deploying).
- [ ] Snapshot current metrics as a rollback baseline (values you'll compare
      post-deploy):
  ```bash
  curl -s "$COORDINATOR_URL/metrics" | grep -E \
    'coordinator_listener_lag_blocks|coordinator_active_orders|coordinator_reconciliation_last_run_timestamp_seconds'
  ```
- [ ] For a coordinator database migration, take a verified backup first —
      see `coordinator/docs/backup-restore.md` and the `pnpm --filter
      @wafflefinance/coordinator db:backup` script referenced in
      `docs/OPERATIONS.md`.

### 2. Deploy

1. Build and start the new version using each service's own start command
   (table above). Do not skip the build step for the coordinator — it has no
   Dockerfile, so "deploy" for it specifically means "run `pnpm build` then
   restart the process," not "pull a new image."
2. Watch process/container startup logs for the coordinator's listener and
   reconciliation initialization messages before touching health endpoints —
   restarting the HTTP server is near-instant, but RPC listener attachment is
   not.
3. Poll `/readyz` until `startup_phase` (coordinator) or `status` (relayer,
   resolver) settles — do not consider the deploy "up" from `/healthz` alone,
   since `/healthz` intentionally always returns `200` while the process is
   alive regardless of dependency state.

### 3. Verify: live, synchronized, no stale event window

Run all three checks below before declaring the deploy complete. They
correspond to the three ways a restart can leave the system in a bad but
not-obviously-broken state.

**a. Live** — process is accepting traffic:

```bash
curl -sf "$COORDINATOR_URL/readyz" | jq '.'
curl -sf "$RELAYER_URL/readyz" | jq '.'
```
Expect `status: "ok"` (relayer) and no `startup_phase` field, or
`startup_phase: "ready"` if present (coordinator).

**b. Synchronized** — listeners caught up on the downtime window rather than
silently skipping it:

```bash
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_listener_lag_blocks
```
Compare against the pre-deploy baseline. A brief spike immediately after
restart is expected (the listener is catching up); it must trend back down
within a few polling intervals (`COORDINATOR_POLL_INTERVAL_MS`, default
`15000`). A lag that stays flat and high indicates the listener did not
resume from the correct block — see the `ListenerLagHigh` /
`ListenerNoProgress` procedures in
[coordinator/ops/RUNBOOK.md](../coordinator/ops/RUNBOOK.md).

**c. No stale event window** — reconciliation has run since the restart and
found nothing it couldn't explain:

```bash
curl -s "$COORDINATOR_URL/metrics" | grep -E \
  'coordinator_reconciliation_last_run_timestamp_seconds|coordinator_reconciliation_events_replayed_total'
```
`coordinator_reconciliation_last_run_timestamp_seconds` must advance past the
deploy time. A nonzero jump in `coordinator_reconciliation_events_replayed_total`
immediately after restart is expected and healthy (it is exactly what
reconciliation exists to catch — events missed during the downtime window
being replayed). A jump that does *not* happen despite real downtime is the
concerning case: it means reconciliation is not actually re-scanning the gap.

### 4. Secret rotation (`SECRET_STORAGE_KEY`)

Preimages are encrypted at rest with AES-256-GCM when `SECRET_STORAGE_KEY` is
set ([coordinator/src/services/secret-service.ts](../coordinator/src/services/secret-service.ts)).
`SecretService` internally supports an ordered key ring (`current`/`previous`/
`fallback`/`additional`) so old ciphertext can still be decrypted with a
retired key while new writes use the newest one — but as of this writing,
[packages/config/src/node.ts](../packages/config/src/node.ts) only wires a
**single** `SECRET_STORAGE_KEY` value from the environment into that config.
There is currently no documented multi-var convention (e.g.
`SECRET_STORAGE_KEY_PREVIOUS`) that would let a rotation carry both keys
through `env.example`-style config. Until that wiring exists, treat rotation
as **not zero-downtime**:

1. Confirm which orders have preimages already persisted under the current
   key (any order that has reached `secret_revealed` or later).
2. Generate the new key the same way the original was generated (`openssl
   rand -hex 32`, per the guidance in
   [coordinator/src/crypto/secret-cipher.ts](../coordinator/src/crypto/secret-cipher.ts)).
3. Deploy with the new `SECRET_STORAGE_KEY`. Existing plaintext rows continue
   to work (`SecretService` returns raw `0x…` values as-is). Rows encrypted
   under the *old* key will fail to decrypt once the old key is gone from the
   environment — do not remove the old key from wherever it's stored until
   you have confirmed (via `coordinator/docs/backup-restore.md` procedures or
   a targeted read of in-flight orders) that no order still needs it.
4. If any order needs the old key at decrypt time before the multi-key
   wiring above exists, the rollback is: redeploy with the previous
   `SECRET_STORAGE_KEY` value restored.

### 5. Rollback triggers

Roll back immediately (do not attempt a forward-fix first) if, within 15
minutes of deploy completing:

| Signal | Threshold | Source |
|---|---|---|
| `coordinator_listener_lag_blocks` | Not decreasing, or exceeds 500 | `coordinator/ops/coordinator-alerts.yml` `CoordinatorListenerLagCritical` |
| `coordinator_reconciliation_last_run_timestamp_seconds` | Has not advanced at all | `CoordinatorReconciliationStale` |
| `/readyz` on coordinator or relayer | Still `503` / `degraded` | This doc, §3a |
| `coordinator_http_request_duration_seconds` 5xx ratio | `> 0.1%` sustained | `CoordinatorHttpErrorRate` |
| Relayer `/readyz` `ethereum_rpc` or `stellar_rpc` check | `ok: false` with `detail` other than `not_configured`/`disabled_placeholder` | `relayer/src/routes/health.ts` |

### 6. Rollback procedure

1. Redeploy the previous known-good build (previous git SHA / previous image
   tag) using the same start command from the topology table.
2. Re-run the full verification sequence in §3 against the rolled-back
   version — a rollback is not "safe" until it, too, is verified live,
   synchronized, and reconciled.
3. If the rollback trigger was database-related (migration, corrupted state),
   follow the "Database Recovery" procedure in
   [docs/OPERATIONS.md](OPERATIONS.md#rollback-procedures) instead of a plain
   process rollback.
4. Any SEV-1/SEV-2 rollback requires a postmortem per
   [docs/OPERATIONS.md](OPERATIONS.md#postmortem-process) — open the issue
   within 24 hours.

## Monitoring checklist reference

Before rollout, know your baseline for: `coordinator_listener_lag_blocks`,
`coordinator_active_orders`, `coordinator_reconciliation_last_run_timestamp_seconds`,
relayer `/readyz` check statuses. After rollout, confirm all of the above
returned to baseline (or improved) and stayed there for at least one full
`COORDINATOR_POLL_INTERVAL_MS` cycle. Full metric definitions, thresholds, and
Grafana panel queries are maintained in
[coordinator/ops/README.md](../coordinator/ops/README.md) and
[coordinator/ops/RUNBOOK.md](../coordinator/ops/RUNBOOK.md) — this runbook
intentionally does not duplicate that table, only the subset relevant to a
deploy/rollback decision.
