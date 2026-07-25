/**
 * Cross-package ABI and schema compatibility harness.
 *
 * PURPOSE
 * ───────
 * This file is the automated enforcement layer for every rule in
 * coordinator/src/compat/COMPATIBILITY.md. It runs as part of the normal
 * `pnpm test` command so drift between the Ethereum ABI, Soroban event
 * wire format, SDK types, and coordinator parsing is caught in CI before
 * code review and release.
 *
 * HOW IT WORKS
 * ────────────
 * Each test pins a concrete, machine-readable expectation about the
 * published interface surface. A change to the contract or SDK that breaks
 * a test here is a signal that the adjacent consumer also needs updating —
 * the test failure IS the compatibility alarm.
 *
 * NEGATIVE CASES
 * ──────────────
 * Every section includes at least one negative test that deliberately
 * presents a mutated/malformed input and confirms the consumer rejects it
 * with a clear, structured error rather than silently processing bad data.
 */

import { describe, it, expect } from "vitest";
import { keccak256, toBytes } from "viem";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { HTLC_ESCROW_ABI } from "@wafflefinance/sdk/ethereum";
import {
  decodeHtlcEvent,
  isMalformedEvent,
  HTLC_EVENT_SCHEMA_VERSION,
  type CreatedEvent,
  type ClaimedEvent,
  type RefundedEvent,
} from "../../src/soroban-events.js";
import {
  makeCreatedEvent,
  makeClaimedEvent,
  makeRefundedEvent,
  HASHLOCK,
  PREIMAGE,
  ORDER_ID,
  TIMELOCK,
  SENDER_ADDR,
  BENEFICIARY_ADDR,
  REFUND_ADDR,
} from "../fixtures/soroban-xdr-fixtures.js";

// ─── SDK OrderStatus + coordinator OrderStatus ────────────────────────────────
import type { OrderStatus as SdkOrderStatus } from "@wafflefinance/sdk/types";
import type { OrderStatus as CoordOrderStatus } from "../../src/persistence/orders-repo.js";

// ─── SDK state machine ────────────────────────────────────────────────────────
import {
  canTransition as sdkCanTransition,
  isTerminal as sdkIsTerminal,
} from "@wafflefinance/sdk/state-machine";
import {
  canTransition as coordCanTransition,
  isTerminal as coordIsTerminal,
} from "../../src/state-machine/order-machine.js";


// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compute the keccak256 event topic from a canonical Solidity signature. */
function eventTopic(sig: string): string {
  return keccak256(toBytes(sig));
}

/** Look up a named entry from the ABI. */
function abiEntry(name: string, type: "event" | "function" | "error") {
  return (HTLC_ESCROW_ABI as readonly any[]).find(
    (e: any) => e.name === name && e.type === type
  );
}

/** Return the canonical signature string for an ABI event entry. */
function canonicalEventSig(name: string): string {
  const entry = abiEntry(name, "event");
  if (!entry) throw new Error(`ABI entry '${name}' not found`);
  const params = entry.inputs.map((i: any) => i.type).join(",");
  return `${name}(${params})`;
}

/** Return the canonical signature string for an ABI function entry. */
function canonicalFunctionSig(name: string): string {
  const entry = abiEntry(name, "function");
  if (!entry) throw new Error(`ABI function '${name}' not found`);
  const params = entry.inputs.map((i: any) => i.type).join(",");
  return `${name}(${params})`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// RULE 1 — Ethereum event and function signatures are pinned
// ═══════════════════════════════════════════════════════════════════════════════

describe("Compat Rule 1: Ethereum event signatures are stable", () => {
  // These keccak256 hashes are the on-chain selector values. They are derived
  // from the canonical Solidity ABI signature and must NEVER change without a
  // coordinated update to the coordinator listener, reconciler, and this file.
  const PINNED_TOPICS = {
    OrderCreated:  "0x672f124381ce10ec7be97b79c6f497471284341be29e92ea567e7c5e2daebf51",
    OrderClaimed:  "0x9091f9eab3186c0983f03b7fb35e7be438f31bd61730bbd61e7e54ad50f6c1b5",
    OrderRefunded: "0x9e02eae1abb591a452a88f0d4da3062c2b8a8ae526e02e25aff7c641cc14ef65",
  } as const;

  it("OrderCreated topic matches the pinned keccak256 selector", () => {
    const sig = canonicalEventSig("OrderCreated");
    expect(sig).toBe(
      "OrderCreated(uint256,address,address,address,uint256,uint256,bytes32,uint64)"
    );
    expect(eventTopic(sig)).toBe(PINNED_TOPICS.OrderCreated);
  });

  it("OrderClaimed topic matches the pinned keccak256 selector", () => {
    const sig = canonicalEventSig("OrderClaimed");
    expect(sig).toBe("OrderClaimed(uint256,address,bytes32,uint256,uint256)");
    expect(eventTopic(sig)).toBe(PINNED_TOPICS.OrderClaimed);
  });

  it("OrderRefunded topic matches the pinned keccak256 selector", () => {
    const sig = canonicalEventSig("OrderRefunded");
    expect(sig).toBe("OrderRefunded(uint256,address,uint256,uint256)");
    expect(eventTopic(sig)).toBe(PINNED_TOPICS.OrderRefunded);
  });

  it("NEGATIVE: a mutated OrderCreated signature produces a different topic", () => {
    // Simulate what would happen if 'hashlock' type changed to 'bytes'
    const mutated = "OrderCreated(uint256,address,address,address,uint256,uint256,bytes,uint64)";
    expect(eventTopic(mutated)).not.toBe(PINNED_TOPICS.OrderCreated);
  });

  it("NEGATIVE: removing a parameter from OrderClaimed changes its topic", () => {
    const mutated = "OrderClaimed(uint256,address,uint256,uint256)"; // preimage removed
    expect(eventTopic(mutated)).not.toBe(PINNED_TOPICS.OrderClaimed);
  });
});


describe("Compat Rule 1: Ethereum function selectors are stable", () => {
  it("createOrder has the expected parameter shape", () => {
    const sig = canonicalFunctionSig("createOrder");
    expect(sig).toBe(
      "createOrder(address,address,address,uint256,uint256,bytes32,uint64)"
    );
  });

  it("claimOrder has the expected parameter shape", () => {
    const sig = canonicalFunctionSig("claimOrder");
    expect(sig).toBe("claimOrder(uint256,bytes)");
  });

  it("refundOrder has the expected parameter shape", () => {
    const sig = canonicalFunctionSig("refundOrder");
    expect(sig).toBe("refundOrder(uint256)");
  });

  it("getOrder has the expected parameter shape", () => {
    const sig = canonicalFunctionSig("getOrder");
    expect(sig).toBe("getOrder(uint256)");
  });

  it("getOrder return tuple has all 12 expected fields in correct order", () => {
    const entry = abiEntry("getOrder", "function");
    const output = entry.outputs[0];
    expect(output.type).toBe("tuple");
    const names = output.components.map((c: any) => c.name);
    expect(names).toEqual([
      "sender", "beneficiary", "refundAddress", "token",
      "amount", "safetyDeposit", "hashlock",
      "timelock", "createdAt", "finalisedAt",
      "status", "preimageKeccak",
    ]);
  });

  it("NEGATIVE: ABI does not contain an unknown admin function", () => {
    const adminFn = abiEntry("emergencyWithdraw", "function");
    expect(adminFn).toBeUndefined();
  });

  it("OrderCreated has exactly 8 inputs", () => {
    const entry = abiEntry("OrderCreated", "event");
    expect(entry.inputs).toHaveLength(8);
  });

  it("OrderCreated indexed fields are orderId, sender, beneficiary", () => {
    const entry = abiEntry("OrderCreated", "event");
    const indexed = entry.inputs.filter((i: any) => i.indexed).map((i: any) => i.name);
    expect(indexed).toEqual(["orderId", "sender", "beneficiary"]);
  });

  it("OrderClaimed indexed fields are orderId and claimer", () => {
    const entry = abiEntry("OrderClaimed", "event");
    const indexed = entry.inputs.filter((i: any) => i.indexed).map((i: any) => i.name);
    expect(indexed).toEqual(["orderId", "claimer"]);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// RULE 2 — Soroban event wire format is versioned and stable
// ═══════════════════════════════════════════════════════════════════════════════

describe("Compat Rule 2: Soroban schema version is pinned at 1", () => {
  it("HTLC_EVENT_SCHEMA_VERSION equals 1", () => {
    expect(HTLC_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it("every decoded event kind carries schemaVersion=1", () => {
    const created  = decodeHtlcEvent(makeCreatedEvent().topic,  makeCreatedEvent().value)  as CreatedEvent;
    const claimed  = decodeHtlcEvent(makeClaimedEvent().topic,  makeClaimedEvent().value)  as ClaimedEvent;
    const refunded = decodeHtlcEvent(makeRefundedEvent().topic, makeRefundedEvent().value) as RefundedEvent;
    for (const ev of [created, claimed, refunded]) {
      expect(ev.schemaVersion).toBe(1);
    }
  });
});

describe("Compat Rule 2: Soroban 'created' wire format", () => {
  it("topics[0] is the symbol 'created'", () => {
    const ev = makeCreatedEvent();
    // Verify the fixture topic[0] decodes to exactly "created"
    const { scValToNative } = require("@stellar/stellar-sdk");
    expect(scValToNative(ev.topic[0])).toBe("created");
  });

  it("topics count is exactly 4 (symbol, sender, beneficiary, hashlock)", () => {
    expect(makeCreatedEvent().topic).toHaveLength(4);
  });

  it("data count is exactly 5 (order_id, asset, amount, safety_deposit, timelock)", () => {
    const { scValToNative } = require("@stellar/stellar-sdk");
    const data = scValToNative(makeCreatedEvent().value) as unknown[];
    expect(data).toHaveLength(5);
  });

  it("decoder extracts orderId as bigint matching ORDER_ID fixture", () => {
    const ev = decodeHtlcEvent(makeCreatedEvent().topic, makeCreatedEvent().value) as CreatedEvent;
    expect(ev.orderId).toBe(BigInt(ORDER_ID));
  });

  it("decoder extracts hashlock as 0x-prefixed 64-hex-char string", () => {
    const ev = decodeHtlcEvent(makeCreatedEvent().topic, makeCreatedEvent().value) as CreatedEvent;
    expect(ev.hashlock).toBe(HASHLOCK);
    expect(/^0x[0-9a-f]{64}$/.test(ev.hashlock)).toBe(true);
  });

  it("decoder extracts timelock as the fixture TIMELOCK integer", () => {
    const ev = decodeHtlcEvent(makeCreatedEvent().topic, makeCreatedEvent().value) as CreatedEvent;
    expect(ev.timelock).toBe(TIMELOCK);
  });

  it("decoder extracts sender and beneficiary as Stellar G-addresses", () => {
    const ev = decodeHtlcEvent(makeCreatedEvent().topic, makeCreatedEvent().value) as CreatedEvent;
    expect(ev.sender).toBe(SENDER_ADDR);
    expect(ev.beneficiary).toBe(BENEFICIARY_ADDR);
  });

  it("NEGATIVE: created event with 3 topics is rejected as topic_count_mismatch", () => {
    const ev = makeCreatedEvent();
    const result = decodeHtlcEvent(ev.topic.slice(0, 3), ev.value);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as any).reason).toBe("topic_count_mismatch");
    expect((result as any).kind).toBe("created");
  });

  it("NEGATIVE: created event with 4 data elements is rejected as data_count_mismatch", () => {
    const { scValToNative } = require("@stellar/stellar-sdk");
    const ev = makeCreatedEvent();
    const original = scValToNative(ev.value) as unknown[];
    const shortData = nativeToScVal(original.slice(0, 4)) as xdr.ScVal;
    const result = decodeHtlcEvent(ev.topic, shortData);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as any).reason).toBe("data_count_mismatch");
  });
});


describe("Compat Rule 2: Soroban 'claimed' wire format", () => {
  it("topics count is exactly 3 (symbol, beneficiary, hashlock)", () => {
    expect(makeClaimedEvent().topic).toHaveLength(3);
  });

  it("decoder extracts preimage as 0x-prefixed hex matching PREIMAGE fixture", () => {
    const ev = decodeHtlcEvent(makeClaimedEvent().topic, makeClaimedEvent().value) as ClaimedEvent;
    expect(ev.preimage).toBe(PREIMAGE);
  });

  it("decoder extracts beneficiary matching BENEFICIARY_ADDR fixture", () => {
    const ev = decodeHtlcEvent(makeClaimedEvent().topic, makeClaimedEvent().value) as ClaimedEvent;
    expect(ev.beneficiary).toBe(BENEFICIARY_ADDR);
  });

  it("NEGATIVE: claimed event with 2 topics is rejected as topic_count_mismatch", () => {
    const ev = makeClaimedEvent();
    const result = decodeHtlcEvent(ev.topic.slice(0, 2), ev.value);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as any).reason).toBe("topic_count_mismatch");
    expect((result as any).kind).toBe("claimed");
  });
});

describe("Compat Rule 2: Soroban 'refunded' wire format", () => {
  it("topics count is exactly 3 (symbol, refund_address, hashlock)", () => {
    expect(makeRefundedEvent().topic).toHaveLength(3);
  });

  it("decoder extracts refundAddress matching REFUND_ADDR fixture", () => {
    const ev = decodeHtlcEvent(makeRefundedEvent().topic, makeRefundedEvent().value) as RefundedEvent;
    expect(ev.refundAddress).toBe(REFUND_ADDR);
  });

  it("NEGATIVE: refunded event with empty data returns data_count_mismatch", () => {
    const ev = makeRefundedEvent();
    const emptyData = nativeToScVal([]) as xdr.ScVal;
    const result = decodeHtlcEvent(ev.topic, emptyData);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as any).reason).toBe("data_count_mismatch");
  });
});

describe("Compat Rule 2: unknown Soroban topics are silently skipped", () => {
  it("governance 'cfg' topic returns null (not an error)", () => {
    const cfgTopic = nativeToScVal("cfg", { type: "symbol" }) as xdr.ScVal;
    const ev = makeCreatedEvent();
    expect(decodeHtlcEvent([cfgTopic, ev.topic[1]!], ev.value)).toBeNull();
  });

  it("'adm_xfer' topic returns null", () => {
    const admTopic = nativeToScVal("adm_xfer", { type: "symbol" }) as xdr.ScVal;
    const ev = makeCreatedEvent();
    expect(decodeHtlcEvent([admTopic], ev.value)).toBeNull();
  });

  it("empty topics array returns null", () => {
    const ev = makeCreatedEvent();
    expect(decodeHtlcEvent([], ev.value)).toBeNull();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// RULE 3 — SDK OrderStatus and coordinator OrderStatus are identical
// ═══════════════════════════════════════════════════════════════════════════════

// Canonical set shared by both packages. Changing either side without
// updating this list will break these tests.
const CANONICAL_STATUSES: CoordOrderStatus[] = [
  "announced",
  "src_locked",
  "dst_locked",
  "secret_revealed",
  "completed",
  "refunded",
  "failed",
  "expired",
];

// TypeScript compile-time check: every canonical status must be assignable
// to both types. This catches renames at type-check time, not just at runtime.
const _sdkCheck: SdkOrderStatus[] = CANONICAL_STATUSES;
const _coordCheck: CoordOrderStatus[] = CANONICAL_STATUSES;

describe("Compat Rule 3: OrderStatus sets match between SDK and coordinator", () => {
  it("canonical status list has 8 entries", () => {
    expect(CANONICAL_STATUSES).toHaveLength(8);
  });

  it("every canonical status is a valid CoordOrderStatus (type-level check)", () => {
    for (const s of CANONICAL_STATUSES) {
      // If this loop runs without TS errors above, the type assignment holds.
      expect(typeof s).toBe("string");
    }
  });

  it("terminal statuses are exactly: completed, refunded, failed", () => {
    const terminal = CANONICAL_STATUSES.filter((s) => coordIsTerminal(s));
    expect(terminal.sort()).toEqual(["completed", "failed", "refunded"]);
  });

  it("non-terminal statuses include announced, src_locked, dst_locked, secret_revealed, expired", () => {
    const nonTerminal = CANONICAL_STATUSES.filter((s) => !coordIsTerminal(s));
    expect(nonTerminal.sort()).toEqual([
      "announced", "dst_locked", "expired", "secret_revealed", "src_locked",
    ]);
  });

  it("NEGATIVE: 'active' is not a valid status (would represent API drift)", () => {
    expect(CANONICAL_STATUSES).not.toContain("active");
  });
});

describe("Compat Rule 3: state-machine transition tables match between SDK and coordinator", () => {
  it("canTransition(announced → src_locked) is true in both packages", () => {
    expect(sdkCanTransition("announced", "src_locked")).toBe(true);
    expect(coordCanTransition("announced", "src_locked")).toBe(true);
  });

  it("canTransition(completed → refunded) is false in both packages", () => {
    expect(sdkCanTransition("completed", "refunded")).toBe(false);
    expect(coordCanTransition("completed", "refunded")).toBe(false);
  });

  it("canTransition(expired → refunded) is true in both packages", () => {
    expect(sdkCanTransition("expired", "refunded")).toBe(true);
    expect(coordCanTransition("expired", "refunded")).toBe(true);
  });

  it("isTerminal results are identical for every status across both packages", () => {
    for (const status of CANONICAL_STATUSES) {
      expect(sdkIsTerminal(status)).toBe(coordIsTerminal(status));
    }
  });

  it("NEGATIVE: canTransition(announced → completed) is false in both packages", () => {
    expect(sdkCanTransition("announced", "completed")).toBe(false);
    expect(coordCanTransition("announced", "completed")).toBe(false);
  });

  it("full transition table is identical between SDK and coordinator", () => {
    for (const from of CANONICAL_STATUSES) {
      for (const to of CANONICAL_STATUSES) {
        const sdkResult   = sdkCanTransition(from, to);
        const coordResult = coordCanTransition(from, to);
        expect(sdkResult).toBe(coordResult);
      }
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// RULE 4 — Direction values: coordinator directions are a subset of SDK
// ═══════════════════════════════════════════════════════════════════════════════

import type { Direction as SdkDirection } from "@wafflefinance/sdk/types";
import type { Direction as CoordDirection } from "../../src/persistence/orders-repo.js";

const COORDINATOR_DIRECTIONS: CoordDirection[] = [
  "eth_to_xlm",
  "xlm_to_eth",
  "eth_to_sol",
  "sol_to_eth",
];

// Type-level check: all coordinator directions are valid SDK directions.
const _dirCheck: SdkDirection[] = COORDINATOR_DIRECTIONS;

describe("Compat Rule 4: coordinator directions are a subset of SDK directions", () => {
  it("all 4 coordinator directions are assignable to SdkDirection (type check)", () => {
    for (const d of COORDINATOR_DIRECTIONS) {
      expect(typeof d).toBe("string");
    }
  });

  it("coordinator directions contain eth_to_xlm, xlm_to_eth, eth_to_sol, sol_to_eth", () => {
    expect(COORDINATOR_DIRECTIONS).toContain("eth_to_xlm");
    expect(COORDINATOR_DIRECTIONS).toContain("xlm_to_eth");
    expect(COORDINATOR_DIRECTIONS).toContain("eth_to_sol");
    expect(COORDINATOR_DIRECTIONS).toContain("sol_to_eth");
  });

  it("NEGATIVE: 'btc_to_eth' is not a coordinator direction", () => {
    expect(COORDINATOR_DIRECTIONS).not.toContain("btc_to_eth");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RULE 5 — Preimage validation is dual-hash: sha256 OR keccak256
// ═══════════════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { keccak256 as viemKeccak, toHex } from "viem";
import { validatePreimage } from "../../src/reconciliation/secret-reconciler.js";

describe("Compat Rule 5: dual-hash preimage validation (sha256 OR keccak256)", () => {
  const preimageBytes = Buffer.alloc(32, 0xcc);
  const preimageHex  = "0x" + preimageBytes.toString("hex");

  it("validatePreimage accepts a sha256-locked preimage", () => {
    const hashlock = "0x" + createHash("sha256").update(preimageBytes).digest("hex");
    expect(validatePreimage(preimageHex, hashlock)).toBe("sha256");
  });

  it("validatePreimage accepts a keccak256-locked preimage", () => {
    const hashlock = viemKeccak(toHex(preimageBytes)) as `0x${string}`;
    expect(validatePreimage(preimageHex, hashlock)).toBe("keccak256");
  });

  it("validatePreimage rejects a preimage that matches neither hash", () => {
    const wrongHashlock = "0x" + "aa".repeat(32);
    expect(validatePreimage(preimageHex, wrongHashlock)).toBeNull();
  });

  it("validatePreimage returns null for malformed hex input", () => {
    expect(validatePreimage("not-hex", "0x" + "aa".repeat(32))).toBeNull();
  });

  it("NEGATIVE: sha256 hash of one preimage does not satisfy a different preimage's hashlock", () => {
    const p1 = Buffer.alloc(32, 0x11);
    const p2 = Buffer.alloc(32, 0x22);
    const hashlock = "0x" + createHash("sha256").update(p1).digest("hex");
    const p2Hex = "0x" + p2.toString("hex");
    expect(validatePreimage(p2Hex, hashlock)).toBeNull();
  });
});

