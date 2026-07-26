# @wafflefinance/sdk

TypeScript SDK for the WaffleFinance non-custodial cross-chain atomic swap
bridge. It provides:

- **Chain clients** for locking, claiming, and refunding HTLC swaps on
  **Ethereum**, **Stellar (Soroban)**, and **Solana**.
- A typed **Coordinator API client** (`CoordinatorClient`, `HistoryClient`,
  `OrderSubscriber`) for announcing orders, tracking their lifecycle, and
  revealing secrets.
- Shared **secret/hashlock utilities**, an SDK-local **order state machine**,
  and **asset mapping** helpers for resolving the equivalent asset across a
  bridge path.

This document is the single source of truth for what's public, what's
transport-specific, and what's still internal. If a type or function isn't
listed here or re-exported from `src/index.ts` / a documented subpath, treat
it as an implementation detail that may change without notice.

## Installation

```bash
npm install @wafflefinance/sdk
```

The package is ESM-only (`"type": "module"`) and ships per-domain subpath
exports so bundlers can tree-shake unused chains — see
[TREE_SHAKING.md](./TREE_SHAKING.md) for import guidance.

## Supported bridge paths

`Direction` (`@wafflefinance/sdk/types`) enumerates six chain pairings, but
**the coordinator currently only accepts four of them**. `SUPPORTED_DIRECTIONS`
(`@wafflefinance/sdk/coordinator`) is the single source of truth for what's
actually live — check it (or `isDirectionLive` in
[`examples/asset-resolution.ts`](./examples/asset-resolution.ts)) before
assuming a direction works end-to-end.

| Direction    | Live on coordinator? | Asset resolver (`@wafflefinance/sdk/assets`) |
| ------------ | :-------------------: | --------------------------------------------- |
| `eth_to_xlm` | ✅ | `resolveStellarAsset` |
| `xlm_to_eth` | ✅ | `resolveEthereumToken` |
| `eth_to_sol` | ✅ | `resolveSolanaAsset` |
| `sol_to_eth` | ✅ | `resolveEthereumTokenFromSolana` |
| `xlm_to_sol` | ❌ not yet | none — no direct Stellar↔Solana mapping exists |
| `sol_to_xlm` | ❌ not yet | none — no direct Stellar↔Solana mapping exists |

All asset resolution pivots through Ethereum today, which is why there's no
direct Stellar↔Solana resolver.

## Stability tiers

| Tier | Surfaces | What it means |
| --- | --- | --- |
| **Stable** | `types`, `htlc-client`, `secrets`, `state-machine`, `assets`, `coordinator` (client, history, subscription, validation, errors) | Safe to build on. Breaking changes ship as a semver-major bump. |
| **Transport-specific** | `ethereum`, `ethereum/adapter`, `soroban`, `soroban/adapter`, `solana`, `solana/adapter` | Stable *within* their chain, but each client's constructor options and raw return shapes (e.g. Soroban's transaction-hash-as-orderId convention) reflect that chain's own SDK. Prefer the `IHTLCClient` interface (below) when you need chain-agnostic code. |
| **Internal** | Anything under `src/` not re-exported by `src/index.ts` or a subpath in `package.json#exports` | No stability guarantee. Node's `exports` map already blocks deep imports (e.g. `@wafflefinance/sdk/coordinator/client` fails) — this is enforced, not just a convention. |
| **Not yet wired up** | `ExternalBridgeKind`, `ExternalBridgeRoute`, `ExternalBridgeAdapter` (`@wafflefinance/sdk/types`) | Shape reserved for v2.1 external-bridge routing (CCTP v2, Axelar ITS). No adapter ships today; only `"wafflefinance-htlc"` is a real route. |

## Quickstart: chain-agnostic HTLC operations

Every chain client implements `IHTLCClient` (`@wafflefinance/sdk/htlc-client`),
so orchestration code that doesn't care which chain it's talking to can use
the adapters uniformly:

```ts
import { EthereumHTLCAdapter } from "@wafflefinance/sdk/ethereum/adapter";
import { HTLCError } from "@wafflefinance/sdk/htlc-client";

const client = new EthereumHTLCClient({ /* chain-specific options */ });
const adapter = new EthereumHTLCAdapter(client);

try {
  const { txId, orderId } = await adapter.createOrder({
    /* chain-specific create input */
  });
} catch (err) {
  if (err instanceof HTLCError) {
    // err.code: "wallet_unavailable" | "simulation_failed" | "tx_rejected" | ...
    // err.retryable: true if safe to retry (RPC timeout, nonce conflict, ...)
  }
}
```

The same `createOrder`/`claimOrder`/`refundOrder` shape (and the same
`HTLCError` on expected failures) applies to `SorobanHTLCAdapter` and
`SolanaHTLCAdapter`. Use the chain-specific client classes
(`EthereumHTLCClient`, `SorobanHTLCClient`, `SolanaHTLCClient`) directly when
you need their full, chain-specific API instead of the normalised interface.

## Quickstart: Coordinator client

```ts
import { CoordinatorClient, OrderSubscriber } from "@wafflefinance/sdk/coordinator";

const coordinator = new CoordinatorClient({ baseUrl: "https://coordinator.example" });

// Announce a new swap (local validation runs before the network call).
const order = await coordinator.announceOrder({
  direction: "eth_to_xlm",
  hashlock: "0x...",
  srcChain: "ethereum",
  srcAddress: "0x...",
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar",
  dstAddress: "G...",
  dstAsset: "native",
  dstAmount: "100000000",
});

// Poll for status changes and terminal settlement.
const sub = new OrderSubscriber({ coordinatorClient: coordinator, orderId: order.id });
sub.on("statusChanged", (e) => console.log(e.from, "→", e.to));
sub.on("secretRevealed", (e) => console.log("preimage revealed:", e.revealedTx));
sub.on("settled", (e) => console.log("done:", e.finalStatus));
sub.start();
```

See [`examples/announce-and-track-order.ts`](./examples/announce-and-track-order.ts)
for a complete, tested version of this flow (announce → subscribe → resolve
on settlement), and `HistoryClient` for paginated wallet history instead of
single-order polling.

## The error/response model

Every network-touching surface throws a typed error instead of a raw string,
so callers can use `instanceof` instead of parsing messages:

| Error class | Thrown by | Meaning |
| --- | --- | --- |
| `CoordinatorValidationError` | `CoordinatorClient`, `validateAnnounceRequest` | Request was invalid and **never sent** — fix the input. Has `.field` and `.details`. |
| `CoordinatorApiError` | `CoordinatorClient` | Coordinator responded with 4xx/5xx. Has `.status`, `.code` (stable machine-readable), and `.retryable`. |
| `CoordinatorNetworkError` | `CoordinatorClient` | No response received (DNS/timeout/connection reset). Always safe to retry. |
| `CoordinatorParseError` | `CoordinatorClient` | Response received but not valid JSON. |
| `HTLCError` | All chain clients/adapters | Expected on-chain failure. Has `.code` (`wallet_unavailable`, `simulation_failed`, `tx_rejected`, `order_not_found`, `timelock_not_expired`, `invalid_preimage`, `simulation_mode`, `chain_error`) and `.retryable`. |
| `UnsupportedAssetError` | `assertSupportedEthToStellar` and friends (`@wafflefinance/sdk/assets`) | No asset mapping exists for the given direction/network. Has `.asset`, `.network`, `.direction`. |

All coordinator errors extend `CoordinatorError`, so a single
`catch (err) { if (err instanceof CoordinatorError) ... }` catches any of
them. See [`examples/error-handling.ts`](./examples/error-handling.ts) for a
tested classifier that maps every error class above to a UI-facing category.

## Subpath exports

| Subpath | Contents |
| --- | --- |
| `@wafflefinance/sdk` | Everything below, re-exported from one entry point (largest bundle — prefer subpaths in size-sensitive code). |
| `@wafflefinance/sdk/types` | `Chain`, `Direction`, `OrderStatus`, `Order`, `ChainLeg`, `ResolverInfo`, external-bridge route types. Zero runtime cost (types only). |
| `@wafflefinance/sdk/htlc-client` | `IHTLCClient`, `HTLCError`, `HTLCErrorCode`, result types. |
| `@wafflefinance/sdk/coordinator` | `CoordinatorClient`, `HistoryClient`, `OrderSubscriber`, validation helpers, transforms, wire-contract types, error classes. |
| `@wafflefinance/sdk/secrets` | `generateSecret`, `hashSecret`, `verifyPreimage`. |
| `@wafflefinance/sdk/state-machine` | SDK-local order transition guards (`canTransition`, `requireTransition`, `isTerminal`, `nextStatesOf`). |
| `@wafflefinance/sdk/assets` | Asset resolution/normalisation/validation helpers — see [ASSET_MAPPING_CONTRACT.md](./ASSET_MAPPING_CONTRACT.md). |
| `@wafflefinance/sdk/ethereum`, `/ethereum/adapter` | `EthereumHTLCClient`, `EthereumHTLCAdapter`. |
| `@wafflefinance/sdk/soroban`, `/soroban/adapter` | `SorobanHTLCClient`, `SorobanHTLCAdapter`, order-ref encode/decode. |
| `@wafflefinance/sdk/solana`, `/solana/adapter` | `SolanaHTLCClient`, `SolanaHTLCAdapter`. |
| `@wafflefinance/sdk/shared-utils` | Hex/buffer conversion, order-ID/hashlock helpers, timelock estimation. |

Deep imports outside this table (e.g. `@wafflefinance/sdk/coordinator/client`)
are not exposed by `package.json#exports` and will fail to resolve — that's
enforced by Node, not just documented convention.

## Soroban contract schema

When interacting with or extending bindings for the Stellar Soroban
`wafflefinance-htlc` contract, refer to the formal IDL and schema
documentation: [Soroban HTLC IDL Reference](../../soroban/docs/HTLC_IDL.md).
It covers account layouts, data types (`OrderStatus`, `Order`), and entrypoint
parameters needed for SDK development.

## Examples

Runnable, tested examples live under [`examples/`](./examples):

- [`announce-and-track-order.ts`](./examples/announce-and-track-order.ts) —
  the full announce → subscribe → settle lifecycle shared by every
  coordinator-supported bridge path.
- [`error-handling.ts`](./examples/error-handling.ts) — classifying and
  reacting to the error/response model above.
- [`asset-resolution.ts`](./examples/asset-resolution.ts) — resolving the
  destination asset for each live direction, and detecting directions that
  aren't coordinator-supported yet.

These are exercised by [`test/examples.test.ts`](./test/examples.test.ts) and
type-checked by `npm run typecheck` (see below), so a renamed or removed
export breaks CI here instead of silently going stale in this README.

## Development

```bash
npm run build       # tsc — compiles src/ to dist/
npm run typecheck   # tsc --noEmit — also checks test/ and examples/
npm test            # vitest run
npm run test:watch  # vitest, watch mode
npm run lint        # eslint src
npm run build:analyze # build + bundle/tree-shaking sanity check
```

See also [TREE_SHAKING.md](./TREE_SHAKING.md) (bundle optimisation) and
[ASSET_MAPPING_CONTRACT.md](./ASSET_MAPPING_CONTRACT.md) (canonical asset
identifiers and per-network mapping tables).
