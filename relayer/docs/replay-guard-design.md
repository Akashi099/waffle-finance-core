# Relayer settlement replay-guard design

Tracks GitHub issue #339. This is a design document — it is not implemented
yet. It maps where duplicate/repeated settlement events can currently slip
through the relayer, the existing precedent to build the guard on, and the
concrete integration points for whoever implements it.

## Where duplicates can currently slip through

The relayer has four call chains that end in a state-changing action. Two
already have a durable replay guard; two do not.

### A. ETH deposit → escrow-creation tx (`index.ts`) — **no durable guard**

`fetchIncomingEthPayments()` (`src/listeners/eth-incoming-monitor.ts:27`) →
linear scan of the in-memory `activeOrders` Map for
`status === 'pending_relayer_escrow'` (`index.ts:2449`) →
`createEscrowForOrder()` (`index.ts:2643`) → `contractWithSigner.createDstEscrow(...)`
/ `.createEscrow(...)` (`index.ts:2706`/`2734`) → `tx.wait()` → status flips
to `'escrow_created_by_relayer'` only *after* the tx confirms
(`index.ts:2745-2746`).

The guard today is a plain in-memory string-status check, not an atomic
claim, and there is a multi-second window between "payment observed" and
"status flipped" during which a re-scan of the same block range (e.g. after
a crash/restart, since `lastProcessedBlock` here is a plain local variable,
`index.ts:2424`, reset to current head on every restart — not persisted via
`CursorStore`) could re-trigger `createEscrowForOrder()` for the same order.
`activeOrders` itself is never persisted (`index.ts`, built fresh each
process start), so this window is real, not theoretical.

### B. Escrow-factory chain events → order status mutation — **no per-event dedupe key**

`startContractEventPoller(escrowFactoryContract, ..., {cursorStore})`
(`index.ts:2851-2864`, poller implementation in
`src/listeners/contract-event-poller.ts:81`) → `queryFilter()` per tick
(`contract-event-poller.ts:134`) → per-event `binding.handler(...)` →
handlers at `index.ts:2767-2848` match on `orderData.hashLock` and set
`orderData.status`.

The cursor only advances after a full tick succeeds
(`contract-event-poller.ts:150-154`); if one binding's handler throws
mid-tick, the whole `toBlock` isn't persisted, so **already-applied**
handlers replay on the next tick. No composite dedupe key
(`transactionHash` + `logIndex`, both available on every `EventLog` returned
by `queryFilter`) is checked before applying a handler's mutation.

Because these handlers only set a status string (no external side effect
beyond the mutation itself), replaying them is lower risk than case A — but
it's still a duplication the acceptance criteria asks to close, and it's the
cheapest of the four to fix (idempotency = "don't apply the same event
identity twice," no external call to guard).

### C. HTLCBridge `OrderCreated` → Stellar HTLC creation — **currently a no-op, but the intended v2 extension point**

`EthereumEventListener.pollEvents()` → `handleOrderCreatedEvent()` →
`processCrossChainOrder()` (`src/listeners/ethereum-listener.ts:189,232,288`)
is an explicit placeholder today (comment: "v1 placeholder Stellar HTLC path
disabled... v2 coordinator creates the Soroban HTLC"). Its
`lastProcessedBlock` (`ethereum-listener.ts:67`) is also not persisted —
always starts at current head on restart, so no cross-restart replay yet,
only same-process retry-on-failure (`ethereum-listener.ts:218-223`).

**This is the extension point to design the guard's interface around**, even
though there's nothing to protect here yet: when this path goes live, it
needs the same treatment as A and B.

### D. XLM→ETH settlement — **already hardened; the pattern to copy**

`POST /api/orders/xlm-to-eth` (`index.ts:1762`, inline variant at
`index.ts:1376`) → `globalStellarProofLedger.isConsumed(stellarTxHash)`
fast-path (`index.ts:1388`,`1791`) → `verifyIncomingStellarPayment()`
(`src/services/horizon-verifier.ts:174`) →
`globalStellarProofLedger.consume(stellarTxHash, {...})` **atomic claim**
(`index.ts:1439`,`1929`) → ETH send.

`StellarProofLedger` (`src/services/stellar-proof-ledger.ts`) and its sibling
`RefundLedger` (`src/services/refund-ledger.ts`) are this repo's existing,
working replay-guard implementations — one JSON file per key
(`stellarTxHash` / `orderId` respectively) under
`<cwd>/.stellar-proof-ledger/` / `<cwd>/.refund-ledger/`, atomic
tmp-file-then-rename writes, an in-memory `Map` cache loaded at startup, a
`storageDir: null` constructor option to disable disk I/O in tests, and a
process-wide `global*` singleton alongside an injectable-instance
constructor. `test/xlm-to-eth-settlement.test.ts` already has the exact test
shape to copy: fire two concurrent requests with the same
`stellarTxHash` and assert exactly one succeeds (409 on the second).

**Do not build the new guard on `FusionEventManager`'s
`processedEventKeys` dedup** (`src/events/event-handlers.ts:302-323`) even
though it looks like a natural fit — `relayer/tsconfig.json` excludes
`src/events/**/*` from the build, and nothing in `index.ts` imports it. It's
dead code in the deployed relayer.

## Design: one durable identity model, two integration points

### Identity keys

| Settlement action | Key | Rationale |
|---|---|---|
| Escrow creation tx (A) | `orderId` | Matches `RefundLedger`'s existing key choice for the same order-scoped "have we already acted" question. |
| Escrow-factory event handler (B) | `` `${contractAddress}:${eventName}:${transactionHash}:${logIndex}` `` | `orderId`/`hashLock` alone aren't enough here — the same order can legitimately receive multiple *different* escrow-factory events (created, funded, ...); the composite key identifies one specific on-chain log, not one order. |
| Future Stellar-HTLC creation (C) | Ethereum `transactionHash` of the triggering `OrderCreated` event | Mirrors B; there is exactly one HTLC-creation action per triggering event. |

### Store

A new `SettlementReplayGuard` service, following `StellarProofLedger`'s
exact shape (`src/services/stellar-proof-ledger.ts`) rather than inventing a
new persistence pattern:

- One JSON file per key under `<cwd>/.settlement-replay-guard/<sanitizedKey>.json`.
- Atomic write: write to `.tmp`, then `rename()`.
- In-memory `Map` cache populated from disk at construction.
- `isConsumed(key)` fast-path read; `consume(key, metadata)` atomic claim —
  same two-method shape as `StellarProofLedger.isConsumed`/`.consume`
  (`stellar-proof-ledger.ts`) so callers already familiar with that pattern
  don't have to learn a new one.
- `storageDir: null` constructor option for tests (no disk I/O), plus a
  `globalSettlementReplayGuard` singleton for production use and an
  injectable-instance constructor for tests — matching both existing ledgers.

One guard instance, keyed generically by string, serves all three
identity-key shapes above (case B's composite key is just a string built
before calling `consume()`).

### Integration points

1. **Case A** (`index.ts:2643`, `createEscrowForOrder`): call
   `guard.consume(orderId, {action: 'escrow_creation', ...})` *before*
   `contractWithSigner.createDstEscrow(...)`/`.createEscrow(...)`. A
   `consume()` that reports "already claimed" short-circuits before the tx is
   ever submitted, closing the crash/restart replay window described in §A.
2. **Case B** (`index.ts:2767-2848`, the escrow-factory event handlers): each
   handler builds its composite key from the `EventLog` it receives
   (`transactionHash`, `logIndex`, already available per §3 of the research
   this doc is based on) and calls `guard.isConsumed()`/`consume()` around
   the `orderData.status = ...` mutation.
3. **Case C**: wire the same pattern in when `processCrossChainOrder()`
   stops being a placeholder — call it out in that function's TODO so the
   guard isn't forgotten when the v2 path is implemented.

### Metrics

Follow the existing result-labeled counter convention
(`relayer_xlm_to_eth_verification_total{result,network_mode}`,
`src/metrics.ts:247-252`) and the existing "duplicate suppressed" precedent
(`relayer_xlm_refund_duplicates_suppressed_total{network_mode}`,
`metrics.ts:178-183`; `relayer_xlm_to_eth_proof_replays_total{network_mode}`,
`metrics.ts:259-264`):

```
relayer_settlement_replay_guard_total{action, result, network_mode}
  action: escrow_creation | escrow_event | stellar_htlc_creation
  result: claimed | duplicate_suppressed
```

Group these under a `replayGuardMetrics` export object, matching the
existing `watchdogMetrics`/`refundMetrics`/`settlementMetrics` grouping
pattern (`metrics.ts:214-231,266-270`) so tests can assert on it the same
way `test/xlm-refund.test.ts` etc. already do.

### Logging

Follow the structured-JSON convention used by the newest, most-reviewed
files (`refund-ledger.ts:254-261`, `stellar-proof-ledger.ts:171-178`,
`refund-watchdog.ts`, `xlm-refund.ts:205-215`) —
`process.stdout.write(JSON.stringify({level, msg, ...ctx}) + '\n')` — rather
than the legacy `console.log` + emoji-prefix style still used in most of
`index.ts`. This keeps the new code consistent with the direction the
codebase has already been moving, not the old one.

## Testing plan

Reuse existing conventions rather than inventing new test infrastructure:

- **Store unit tests**: same shape as `test/cursor-store.test.ts` — fresh
  temp dir per test, `storageDir` override, assert both the API and the raw
  on-disk JSON.
- **Concurrent-replay race test**: copy
  `test/xlm-to-eth-settlement.test.ts`'s existing "fire two concurrent calls
  with the same key, assert exactly one wins (409 on the second)" test
  directly — it's the precedent for exactly this kind of race.
- **Chain-event dedupe test**: extend `test/event-poller.test.ts`'s
  `fakeEventLog()` builder and mocked `queryFilter` to simulate the same
  block range being delivered twice (a cursor-didn't-advance retry), and
  assert a handler only mutates `orderData` once.
- **Escrow-creation restart-replay test**: simulate a fresh `activeOrders`
  Map (as if the process restarted) with an order already
  `'escrow_created_by_relayer'` per the guard's ledger but not reflected in
  the (freshly rebuilt) in-memory map, and assert `createEscrowForOrder()`
  is not re-invoked — mirrors `test/refund-watchdog.test.ts`'s pattern of
  injecting a fake `activeOrders` Map.

## Open question for whoever implements this

`activeOrders` itself is not persisted at all (§5 of the research this doc
is based on) — the replay guard proposed here prevents *duplicate actions*,
but does not by itself prevent the relayer from losing track of in-flight
orders on a crash. That's a separate concern (order-state persistence) from
replay-guarding a given action, and is out of scope for issue #339, but
worth flagging so it isn't conflated with this fix.
