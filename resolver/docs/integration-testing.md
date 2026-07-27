# Resolver integration-testing strategy (chain listener + network config)

Tracks GitHub issue #365. This document defines the integration-test surface
for the resolver's connection/configuration/listener startup path. It is a
strategy document — the tests themselves are not implemented yet; this is
the plan for adding them.

## Why this gap exists

Every existing test in `resolver/test/` exercises one layer in isolation,
each with its own hand-built fixtures:

| Layer | File | What it tests | What it does NOT test |
|---|---|---|---|
| Env → `ResolverConfig` | `test/config.test.ts` | `loadConfig()` against real `process.env`, including malformed-key rejection | Never calls `validateResolverConfig()` or starts a listener with the result |
| `ResolverConfig` → validation | `test/validation.test.ts` | `validateResolverConfig()` against hand-built `baseConfig()` objects, with injected chain-id/passphrase probes | Never goes through `loadConfig()` first, so a schema-level bug (e.g. a field name drifting) wouldn't surface here |
| `ResolverConfig` → listener | `test/ethereum.test.ts`, `test/soroban.test.ts` | Listener lifecycle (start/stop, event dispatch) against inline literal config objects with viem/stellar-sdk mocked at the client boundary | Never receives a config produced by `loadConfig()`, and never runs after `validateResolverConfig()` has passed or failed |

No test today answers "if I set exactly these environment variables and run
`resolver run`, what actually happens?" — which is the question issue #365
asks for. A schema change that silently breaks how `loadConfig()`'s output
flows into `EthereumListener`/`SorobanListener` (e.g. a renamed field) could
pass every existing test file and still break the real binary.

## Supported runtime combinations

The new suite (`resolver/test/startup-integration.test.ts`, not yet
written) should assert on three layers together — `loadConfig()` →
`validateResolverConfig()` → listener `.start()` — for each row below, using
real environment variables (following `config.test.ts`'s `MANAGED_KEYS`
save/restore pattern) rather than hand-built `ResolverConfig` objects.

| Fixture | Env shape | Expected `loadConfig()` | Expected `validateResolverConfig()` | Expected listener behavior |
|---|---|---|---|---|
| **Healthy, both chains** | Valid `NETWORK_MODE`, both registry/HTLC addresses set, valid `RESOLVER_ETH_PRIVATE_KEY` + `RESOLVER_STELLAR_SECRET`, RPC probes return the expected chain id / passphrase | Returns a populated `ResolverConfig` | Resolves | Both `EthereumListener` and `SorobanListener` attach; `activeListeners{chain}` metric set to 1 for both |
| **Healthy, observe-only** | Same as above but `RESOLVER_ETH_PRIVATE_KEY` / `RESOLVER_STELLAR_SECRET` unset | Returns config with the corresponding key field `null` | Resolves (secrets are optional — see `validation.ts:184` comment) | Listener(s) still attach and watch events; `registry-status.ts`'s monitor (issue #363) treats the chain as unconfigured, not degraded |
| **Placeholder Soroban contract** | `SOROBAN_HTLC_*` unset/blank, Ethereum fully configured | Returns config with `soroban.htlc === null` | Resolves | `SorobanListener.start()` logs `"SOROBAN_HTLC contract id not configured — skipping Soroban listener"` (`listeners/soroban.ts:87-91`) and returns without attaching; `EthereumListener` still starts normally |
| **Placeholder Ethereum contract** | `ETH_HTLC_ESCROW_*` unset/blank, Soroban fully configured | Returns config with `ethereum.htlcEscrow === null` | Resolves | Mirror case — assert the Ethereum-side equivalent (currently `EthereumListener` should be checked for the same "skip without throwing" behavior; if it does not yet guard on a null `htlcEscrow`, that's a bug this test would catch, not something to code around) |
| **Malformed Ethereum key** | `RESOLVER_ETH_PRIVATE_KEY` set to a non-hex or wrong-length string | Throws `ConfigValidationError` (schema-level `refine`, `packages/config/src/schema.ts`) | Not reached | No listener ever attaches — assert the failure happens before any `EthereumListener`/`SorobanListener` construction, matching `commands/run.ts:41-49`'s "validate before any listener attaches" ordering |
| **Malformed Stellar secret** | `RESOLVER_STELLAR_SECRET` set to an invalid StrKey | Throws `ConfigValidationError` | Not reached | Same as above |
| **Chain id mismatch** | Valid config shape, but the injected `ethereumChainIdProbe` returns a different chain id than `cfg.ethereum.chainId` | Returns config | Throws `ConfigValidationError` (`assertEthereumChainId`, `validation.ts:115-134`) | No listener attaches — this is the connectivity-check path `validation.test.ts` already unit-tests in isolation; the integration suite's job is to prove it actually gates listener startup in `run.ts`'s real ordering, not just that the function throws in isolation |
| **Soroban passphrase mismatch** | Same idea via `sorobanPassphraseProbe` | Returns config | Throws `ConfigValidationError` (`assertSorobanReachable`, `validation.ts:140-160`) | No listener attaches |
| **Unreachable RPC** | Injected probe rejects (simulated network error) | Returns config | Throws `ConfigValidationError` with a redacted URL (never leaks embedded API keys — see `redactUrl`, `validation.ts:36-42`) | No listener attaches |

## How each layer stays mockable (no live RPC)

- `loadConfig()` — no mocking needed; it's pure env-var parsing (`@wafflefinance/config/node`), which is exactly why it's safe to exercise for real in every fixture.
- `validateResolverConfig()` — already accepts `ethereumChainIdProbe`/`sorobanPassphraseProbe` overrides (`validation.ts:171-173`); the integration suite reuses this injection point instead of adding a new one.
- Listener startup — reuse the existing per-listener mocking conventions rather than inventing new ones:
  - EVM: `vi.mock('viem', ...)` overriding `createPublicClient().watchEvent`, as in `test/ethereum.test.ts:6-14`.
  - Soroban: `vi.mock('@stellar/stellar-sdk', ...)` overriding `rpc.Server` while keeping `xdr`/`nativeToScVal`/`Address` real, as in `test/soroban.test.ts:28-42`.

## What "real runtime behavior" means here

Per the issue's acceptance criteria ("tests validate real runtime behavior
rather than mock-only assumptions"): the mocks stop at the RPC/SDK client
boundary (`createPublicClient`, `rpc.Server`) — everything above that
boundary (`loadConfig`, `validateResolverConfig`, `EthereumListener`,
`SorobanListener`, and their interaction in the shape `commands/run.ts`
uses) runs as real, unmocked code. That is what distinguishes this suite
from the existing per-file unit tests, which sometimes construct
`ResolverConfig` objects by hand and therefore can't catch a schema/config
drift between `loadConfig()`'s actual output shape and what a listener
expects.

## Suggested file layout

```
resolver/test/startup-integration.test.ts
  describe("healthy startup")
  describe("observe-only startup")
  describe("placeholder chain — Soroban")
  describe("placeholder chain — Ethereum")
  describe("malformed key material aborts before any listener attaches")
  describe("connectivity mismatch aborts before any listener attaches")
```

Each `describe` block: set the fixture's env vars (save/restore via the
`MANAGED_KEYS` pattern from `test/config.test.ts:9-33`), call `loadConfig()`
for real, then either assert the thrown error (malformed/mismatch cases) or
proceed to `validateResolverConfig()` with injected probes and, on success,
construct and `.start()` the listeners with client-boundary mocks in place,
asserting on `activeListeners` (`src/metrics.ts`) and captured log output.
