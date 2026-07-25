# Dependency Hygiene Policy

**Scope:** `packages/sdk` and `frontend` runtime surfaces, with supporting guidance
for `coordinator`, `relayer`, and `resolver` service packages.

**Owner:** WaffleFinance core team  
**Last reviewed:** 2026-07-25  
**Enforcement:** `pnpm validate:deps` (see [CI Check](#ci-check))

---

## 1. Why this document exists

The monorepo contains multiple independent runtime surfaces that each own their
own dependency tree:

| Surface | Entry point | Runtime |
|---------|-------------|---------|
| `packages/sdk` | consumed by frontend, e2e, external callers | browser + Node ≥ 22 |
| `frontend` | browser bundle | browser |
| `coordinator` | server process | Node ≥ 22 |
| `relayer` | server process | Node ≥ 22 |
| `resolver` | server process | Node ≥ 22 |

Over time these trees drift: one package upgrades `viem` to `2.22`, another
stays on `2.21`, and peer-resolution warnings silently turn into runtime
incompatibilities. This policy defines the canonical supported ranges,
the upgrade procedure, and the automated check that catches divergence
before it reaches `main`.

---

## 2. Supported version ranges

### 2.1 Shared chain-client libraries

These libraries appear in **multiple** packages and must stay in lock-step
across the workspace. Any upgrade must touch all packages simultaneously.

| Library | Supported range | Notes |
|---------|-----------------|-------|
| `viem` | `^2.21.0` | ABI encoding ABI, EIP-712, public client; SDK + frontend + coordinator + resolver all share this range. |
| `@stellar/stellar-sdk` | `^13.0.0` | Soroban RPC + Horizon client; coordinator + relayer + resolver + SDK. Do **not** mix v12 and v13 — the Soroban XDR schema changed. |
| `@solana/web3.js` | `^1.98.4` | SDK + coordinator; v2 is a full rewrite (tree-shaking, no `Connection` class) and is **not** compatible. |
| `ethers` | `^6.9.0` | Relayer only. Frontend uses `viem`; do not add `ethers` to frontend or SDK. |

### 2.2 Framework and build tooling

| Library | Supported range | Notes |
|---------|-----------------|-------|
| `react` / `react-dom` | `^18.2.0` | React 19 requires coordinated migration of all hooks consumers; do not upgrade without a tracked issue. |
| `wagmi` | `^1.4.0` | Tightly coupled to `viem ^2.x` and `@rainbow-me/rainbowkit ^1.x`. All three must be upgraded together. |
| `@rainbow-me/rainbowkit` | `^1.3.0` | See wagmi note. |
| `@tanstack/react-query` | `^5.14.0` | v5 is a full rewrite of v4; do not mix majors within a single React tree. |
| `vite` | `^5.0.8` | Vite 6 changes the default ESM output format and may break the `@vitejs/plugin-react` pairing. |
| `typescript` | `^5.6.0` | Root workspace constraint. All packages must stay on the same minor or higher. |

### 2.3 Server-side runtime libraries

| Library | Supported range | Notes |
|---------|-----------------|-------|
| `express` | `^4.18.2` – `^4.21.0` | The range spans 4.18-4.21; both are supported. Express 5 is RC and not yet adopted. |
| `pino` / `pino-http` | `^9.5.0` / `^10.3.0` | Coordinator structured logging. |
| `winston` | `^3.11.0` | Relayer structured logging. |
| `zod` | `^3.23.8` | Config and route validation; shared via `packages/config`. |
| `prom-client` | `^15.1.3` | Prometheus metrics; all services must share the same major. |
| `pg` | `^8.11.0` | Coordinator Postgres backend only. |
| `xstate` | `^5.18.0` | Coordinator state machine; v5 API is breaking vs v4. |
| `axios` | `^1.10.0` | Relayer + dashboard HTTP client. |

### 2.4 Dev tooling (all packages)

| Library | Supported range | Notes |
|---------|-----------------|-------|
| `vitest` | `^2.1.0` | Tests across all packages. Frontend pins `^1.0.4` for Vite 5 compat — see §4.2. |
| `tsx` | `^4.6.0` – `^4.19.0` | Dev runner; range span is safe, prefer ≥ 4.19. |

---

## 3. Peer-dependency compatibility contract

`packages/config` declares the following **peer dependencies** that consumers
must satisfy:

```json
"peerDependencies": {
  "@stellar/stellar-sdk": ">=13.0.0",
  "dotenv":               ">=16.0.0",
  "viem":                 ">=2.0.0"
}
```

**Rule:** Any package that depends on `@wafflefinance/config` must install a
version of each peer that satisfies these ranges. The automated check
([§5](#5-ci-check--automated-validation)) verifies this on every PR.

---

## 4. Upgrade policy

### 4.1 Patch and minor upgrades (non-breaking)

1. Renovate opens a grouped PR (see `renovate.json5`).
2. CI must pass — including `pnpm validate:deps`.
3. One reviewer approves.
4. Merge.

For **shared chain-client libraries** (§2.1) verify that the version in
every consumer package is updated in the same PR.

### 4.2 Known version skew (intentional, documented)

The following mismatches are **intentional** and must not be auto-corrected:

| Situation | Reason |
|-----------|--------|
| `frontend` pins `vitest ^1.0.4`; all other packages use `^2.1.0` | Frontend runs Vitest inside Vite 5's test harness; Vitest 2 requires a Vite plugin API not yet backported to `@vitejs/plugin-react ^4.2`. Upgrade both together. |
| `e2e` uses `@types/node ^20.10.0`; services use `^22.10.0` | e2e tests run on whatever CI image is available; Node 20 typings are a safe subset. |
| `resolver` uses `@types/node ^20.12.0` | Same rationale as e2e. Upgrade with next Node LTS bump. |

These exceptions are explicitly whitelisted in `scripts/check-dep-versions.mjs`.

### 4.3 Major upgrades

Major upgrades of any library in §2.1 or §2.2 require:

1. A dedicated tracking issue describing the upgrade path.
2. A draft PR that updates **all** affected packages simultaneously.
3. Full test suite green (`pnpm test`).
4. Two reviewers (one must have previously reviewed the library's changelog).
5. Update this document (§2 table + §4.2 if a new intentional skew is added).

### 4.4 Security patches

Security patches bypass grouping and the Monday schedule — see the
`vulnerabilityAlerts` block in `renovate.json5`. They still require CI green
and one reviewer approval before merge.

---

## 5. CI check / automated validation

Running `pnpm validate:deps` from the workspace root executes
`scripts/check-dep-versions.mjs`, which:

1. **Shared-library alignment** — verifies that every workspace package that
   depends on a shared chain-client library (`viem`, `@stellar/stellar-sdk`,
   `@solana/web3.js`) uses a version whose resolved major matches the
   canonical range declared in this policy.

2. **Peer-dependency satisfaction** — verifies that every consumer of
   `@wafflefinance/config` declares peer deps within the required ranges.

3. **Intentional skew allow-list** — whitelisted mismatches from §4.2 are
   reported as INFO, not errors.

4. **Forbidden cross-surface deps** — checks that `ethers` does not appear in
   `packages/sdk` or `frontend` (both must use `viem` only).

Exit code 0 = all checks pass. Exit code 1 = at least one violation.

The check is intentionally **lightweight** (pure JS, no network, < 100 ms) so
it can run on every push without adding CI latency.

---

## 6. Adding a new shared dependency

1. Check §2 — if the library is already listed, align to the existing range.
2. If new, propose it in a PR that updates §2 and the `check-dep-versions.mjs`
   allow-list before merging the feature that introduces it.
3. If the library is a chain-client or handles user funds, treat it as
   audit-critical (§4.3 process applies).

---

## 7. Maintenance cadence

| Activity | Frequency | Owner |
|----------|-----------|-------|
| Review §2 version tables | On every major upgrade PR | PR author |
| Full range audit against latest published versions | Quarterly | Core team |
| Renovate dashboard review | Weekly (Monday) | On-call reviewer |
| Node.js LTS upgrade | On LTS release (even years) | Core team |

---

## 8. References

- `renovate.json5` — automated PR configuration
- `scripts/check-dep-versions.mjs` — the enforcement script
- `packages/config/package.json` — peer-dependency declarations
- `.nvmrc` — canonical Node version for local development
