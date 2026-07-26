# Command contract

This document is the canonical map of the repository's build, test, lint, and
smoke-test entry points. Every workspace package listed here commits to the
script surface described below, and CI enforces it: if a package drops or
renames one of these scripts, `pnpm validate:commands` (and the
**Command Contract** CI job) fails.

If you change a `scripts` block in any `package.json`, or add a new workspace
package, update this document **and** the contract table in
[`scripts/validate-commands.mjs`](../scripts/validate-commands.mjs) in the
same change.

## TL;DR — which command do I run?

| I changed… | Run this |
| --- | --- |
| Solidity contracts (`contracts/`) | `pnpm --filter @wafflefinance/contracts test` |
| Soroban contracts (`soroban/`) | `cd soroban && cargo test` |
| SDK (`packages/sdk/`) | `pnpm --filter @wafflefinance/sdk build && pnpm --filter @wafflefinance/sdk test` |
| Coordinator (`coordinator/`) | `pnpm --filter @wafflefinance/coordinator test` |
| Relayer (`relayer/`) | `pnpm --filter @wafflefinance/relayer test` |
| Resolver (`resolver/`) | `pnpm --filter @wafflefinance/resolver test` |
| Frontend (`frontend/`) | `pnpm --filter @wafflefinance/frontend test` and `pnpm --filter @wafflefinance/frontend lint` |
| Anything cross-package | `pnpm build && pnpm test` from the repo root |
| `package.json` scripts or workspace layout | `pnpm validate:commands && pnpm validate:manifests` |

Tests in one package do **not** validate another package's runtime contract.
The coordinator suite passing says nothing about the relayer; a green Hardhat
run says nothing about the Soroban contracts. Cross-package behaviour is only
covered by the e2e suite (`pnpm test:e2e`).

## Root aggregate commands

Run from the repository root. These fan out with `pnpm -r`, which visits every
workspace package **that defines the script** and silently skips the rest —
the tables below pin down exactly which packages participate in each.

| Command | What it does | Covers |
| --- | --- | --- |
| `pnpm build` | `pnpm -r build` | Every package except `e2e` (test-only, nothing to build) |
| `pnpm test` | `pnpm -r test` | Every package, including `e2e` |
| `pnpm test:e2e` | Cross-package end-to-end suite only | `e2e` |
| `pnpm lint` | `pnpm -r lint` | Every package that defines `lint` (`contracts` uses solhint, the rest eslint; `config` currently has no lint script) |
| `pnpm dev` | `pnpm -r dev` | Long-running dev servers (coordinator, relayer, resolver, dashboard, frontend) |
| `pnpm clean` | `pnpm -r clean` + removes root `node_modules` | Packages that define `clean` |
| `pnpm format` / `pnpm format:check` | Prettier write / check across the repo | All TS/TSX/JSON/MD files |
| `pnpm validate:commands` | Enforces this command contract | All workspace manifests |
| `pnpm validate:manifests` | Validates names, versions, and export paths | All workspace manifests |
| `pnpm validate:deployments` | Validates `deployments.testnet.json` | Deployment records |
| `pnpm health:check` | Smoke-tests a locally running coordinator (`GET /health`) | Coordinator runtime |

`pnpm -r build` ordering is dependency-aware; `@wafflefinance/sdk` and
`@wafflefinance/config` build before the services that import them.

## Per-package contract

The "validates" notes state what a green run of the script actually tells
you, and nothing more.

### `@wafflefinance/contracts` — Solidity / Hardhat (Node driver)

| Script | Command | Validates |
| --- | --- | --- |
| `build` | `hardhat compile` (alias of `compile`) | Solidity sources compile; artifacts generated |
| `compile` | `hardhat compile` | Same as `build` (kept for Hardhat convention) |
| `test` | `hardhat test` | Contract behaviour on an in-process Hardhat EVM |
| `lint` | `solhint 'contracts/**/*.sol'` | Solidity style/security lint only |
| `coverage` | `hardhat coverage` | Test coverage report |
| `clean` | Removes artifacts and cache | — |

Deployment scripts (`deploy:*`, `validate:sepolia`, `validate:mainnet`,
`verify`) are release tooling, not part of the day-to-day contract; see
[RELEASE_POLICY.md](../RELEASE_POLICY.md). Foundry fuzz/invariant tests run
via `scripts/verify-release-locally.{sh,ps1}`, not via a package script.

### `@wafflefinance/coordinator`, `@wafflefinance/relayer`, `@wafflefinance/resolver` — Node 22 services

These services share an identical script surface:

| Script | Command | Validates |
| --- | --- | --- |
| `build` | `tsc` | Type-checks and emits `dist/` |
| `test` | `vitest run` | Unit/integration tests for **this service only** |
| `test:watch` | `vitest` | Watch mode for local development |
| `lint` | `eslint src --ext .ts` | ESLint over the service's sources |
| `dev` | `tsx watch src/index.ts` | Local dev server with reload |
| `start` | `node dist/index.js` | Runs the built service (requires `build` first) |
| `clean` | Removes `dist/` | — |

`@wafflefinance/dashboard` (in `packages/`) follows the same surface, minus
`clean`.

Coordinator extras: `seed-demo` (demo data), `db:backup` / `db:restore`
(operational tooling), and Postgres-backed tests via
`TEST_WITH_POSTGRES=true pnpm --filter @wafflefinance/coordinator test`.

### `@wafflefinance/sdk`, `@wafflefinance/config` — shared TypeScript libraries

| Script | Command | Validates |
| --- | --- | --- |
| `build` | `tsc` | Type-checks and emits `dist/` consumed by every service |
| `test` | `vitest run` | Library unit tests |
| `test:watch` | `vitest` | Watch mode |
| `lint` (sdk only) | `eslint src --ext .ts` | ESLint over sources |
| `clean` | Removes `dist/` | — |

SDK extra: `build:analyze` reports bundle size. Build the SDK before working
on any package that imports it (`pnpm --filter @wafflefinance/sdk build`).

### `@wafflefinance/frontend` — browser app (Vite + React)

| Script | Command | Validates |
| --- | --- | --- |
| `build` | `tsc && vite build` | Type-check plus production bundle |
| `test` | `vitest run` | Component/unit tests (jsdom, not a real browser) |
| `lint` | `eslint . --ext ts,tsx … --max-warnings 0` | Strictest lint in the repo — warnings fail |
| `dev` | `vite` | Local dev server |
| `preview` | `vite preview` | Serves the production build locally |
| `clean` | Removes `dist/` | — |

### `@wafflefinance/e2e` — cross-package end-to-end suite

| Script | Command | Validates |
| --- | --- | --- |
| `test` | `vitest run` | Cross-package flows against running services |
| `test:watch` | `vitest` | Watch mode |
| `lint` | `eslint src --ext .ts` | ESLint over the test sources |

`e2e` intentionally has **no `build` script** — it is executed by vitest
directly and produces no artifacts. This is the one sanctioned gap in the
`pnpm -r build` fan-out.

### `soroban/` — Rust / Soroban contracts (outside the pnpm workspace)

The Soroban contracts are a Cargo workspace, not a pnpm package, so **no
`pnpm` command reaches them**. Their entry points are:

| Command (from `soroban/`) | Validates |
| --- | --- |
| `stellar contract build` (or `cargo build --release --target wasm32-unknown-unknown`) | Contracts compile to wasm |
| `cargo test` | Contract unit tests on the Soroban host |

See [soroban/README.md](../soroban/README.md) for deployment and
TypeScript-bindings generation.

## Smoke tests

- **Coordinator:** start it (`pnpm coordinator:dev`), then `pnpm health:check`
  hits `GET /health` on port 3001.
- **Frontend:** `pnpm frontend:build && pnpm frontend:preview` serves the real
  production bundle.
- **Release:** `scripts/verify-release-locally.sh` (or `.ps1` on Windows) runs
  the full pre-release verification: Hardhat + Foundry compile/test parity,
  SDK build/export checks, and checksums.

## How CI enforces this

`.github/workflows/command-contract.yml` runs on every push and pull request.
It executes `node scripts/validate-commands.mjs`, which:

1. Resolves the workspace package list from the root `package.json`.
2. Fails if any package is missing a script required by this contract, or if
   a required script no longer invokes the tool the contract documents (e.g.
   a `test` script that stops running `vitest run` / `hardhat test`).
3. Fails if a workspace package exists that the contract doesn't cover, so
   new packages must be added to the contract deliberately.
4. Verifies every `pnpm --filter <pkg> <script>` shortcut in the root
   `package.json` resolves to a script that actually exists in the target
   package.

The checker is a dependency-free Node script — CI needs no `pnpm install`,
and you can run it locally the same way.

Related but separate: `pnpm validate:manifests` checks manifest names,
versions, and export paths. Note it verifies built artifacts referenced by
`exports`, so it needs `pnpm --filter @wafflefinance/sdk build` (or a full
`pnpm build`) to have run first.
