/**
 * Local preflight validation for coordinator request payloads.
 *
 * This module mirrors the coordinator's own `announceSchema` and address
 * validation logic so the SDK can reject malformed requests before they
 * travel over the network. The rules are kept deliberately in sync with
 * coordinator/src/validation/announce.ts and coordinator/src/validation/address.ts.
 *
 * No Zod dependency — the SDK is a library and we don't want to force
 * consumers into a specific validation runtime. Plain TypeScript predicates
 * and structured error returns are used instead.
 *
 * Which validation is local vs backend
 * ─────────────────────────────────────
 * LOCAL (this file):
 *   - Hashlock format (0x + 64 hex chars)
 *   - direction is one of the four coordinator-supported values
 *   - srcChain/dstChain alignment with direction
 *   - Address format per chain (ETH 0x40, Stellar G+55, Solana base58 32-44)
 *   - Ethereum zero-address rejection
 *   - srcAmount, srcSafetyDeposit, dstAmount are decimal integer strings
 *   - srcAsset, dstAsset are non-empty
 *
 * BACKEND ONLY:
 *   - Hashlock uniqueness (duplicate announce detection)
 *   - Rate limiting
 *   - Asset pair support (which specific assets are enabled for which route)
 *   - Amount range / minimum checks
 */

import type { Chain } from "../types/index.js";
import type { CoordinatorDirection, CoordinatorAnnounceRequest } from "./contract.js";
import { CoordinatorValidationError } from "./errors.js";

// ── Regex constants (mirrors coordinator/src/validation/address.ts) ──────────

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL_INT = /^\d+$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── Direction → chain mapping (mirrors coordinator/src/validation/announce.ts) ─

/**
 * The src/dst chains each coordinator-supported direction must use.
 * Kept in sync with coordinator `DIRECTION_CHAINS`.
 */
export const DIRECTION_CHAINS: Record<CoordinatorDirection, { src: Chain; dst: Chain }> = {
  eth_to_xlm: { src: "ethereum", dst: "stellar" },
  xlm_to_eth: { src: "stellar", dst: "ethereum" },
  eth_to_sol: { src: "ethereum", dst: "solana" },
  sol_to_eth: { src: "solana", dst: "ethereum" },
};

/** All four directions the coordinator currently supports. */
export const SUPPORTED_DIRECTIONS: ReadonlyArray<CoordinatorDirection> = [
  "eth_to_xlm",
  "xlm_to_eth",
  "eth_to_sol",
  "sol_to_eth",
];

// ── Individual field validators ─────────────────────────────────────────────

/** Returns an error message or null. */
export function validateHashlockField(hashlock: string): string | null {
  if (!HEX32.test(hashlock)) {
    return "hashlock must be a 0x-prefixed 64-char hex string (32 bytes)";
  }
  return null;
}

/** Returns an error message or null. */
export function validateChainAddress(chain: Chain, address: string): string | null {
  if (chain === "ethereum") {
    if (!HEX_ADDRESS.test(address)) {
      return `${address} is not a valid Ethereum address (expected 0x + 40 hex chars)`;
    }
    if (address.toLowerCase() === ZERO_ADDRESS) {
      return "Ethereum zero address is not a valid counterparty";
    }
    return null;
  }
  if (chain === "stellar") {
    return STELLAR_ADDRESS.test(address)
      ? null
      : `${address} is not a valid Stellar account (expected G + 55 base32 chars)`;
  }
  if (chain === "solana") {
    return SOLANA_ADDRESS.test(address)
      ? null
      : `${address} is not a valid Solana address (expected base58, 32–44 chars)`;
  }
  return `unsupported chain: ${chain}`;
}

/** Returns an error message or null. */
export function validateDecimalIntField(value: string, fieldName: string): string | null {
  if (!DECIMAL_INT.test(value)) {
    return `${fieldName} must be a decimal integer string (e.g. "1000000000000000000")`;
  }
  return null;
}

// ── Structured validation result ────────────────────────────────────────────

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * Validate a coordinator announce request payload.
 *
 * Returns a `ValidationResult`. If `ok` is false, `issues` contains every
 * validation failure found so callers can show all errors at once rather than
 * one at a time.
 *
 * Does NOT throw. Use `assertValidAnnounceRequest` if you prefer an exception.
 */
export function validateAnnounceRequest(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (typeof input !== "object" || input === null) {
    return { ok: false, issues: [{ field: "root", message: "request must be an object" }] };
  }

  const req = input as Record<string, unknown>;

  // direction
  const direction = req["direction"];
  if (typeof direction !== "string") {
    issues.push({ field: "direction", message: "direction is required" });
  } else if (!(SUPPORTED_DIRECTIONS as string[]).includes(direction)) {
    issues.push({
      field: "direction",
      message: `direction must be one of: ${SUPPORTED_DIRECTIONS.join(", ")} (got "${direction}")`,
    });
  }

  // hashlock
  const hashlock = req["hashlock"];
  if (typeof hashlock !== "string") {
    issues.push({ field: "hashlock", message: "hashlock is required" });
  } else {
    const err = validateHashlockField(hashlock);
    if (err) issues.push({ field: "hashlock", message: err });
  }

  // srcChain / dstChain
  const srcChain = req["srcChain"];
  const dstChain = req["dstChain"];
  const validChains = ["ethereum", "stellar", "solana"];

  if (typeof srcChain !== "string" || !validChains.includes(srcChain)) {
    issues.push({ field: "srcChain", message: `srcChain must be one of: ${validChains.join(", ")}` });
  }
  if (typeof dstChain !== "string" || !validChains.includes(dstChain)) {
    issues.push({ field: "dstChain", message: `dstChain must be one of: ${validChains.join(", ")}` });
  }

  // direction/chain alignment (only when all three fields are valid strings)
  if (
    typeof direction === "string" &&
    (SUPPORTED_DIRECTIONS as string[]).includes(direction) &&
    typeof srcChain === "string" &&
    validChains.includes(srcChain) &&
    typeof dstChain === "string" &&
    validChains.includes(dstChain)
  ) {
    const want = DIRECTION_CHAINS[direction as CoordinatorDirection];
    if (srcChain !== want.src) {
      issues.push({
        field: "srcChain",
        message: `direction ${direction} requires srcChain=${want.src} (got ${srcChain})`,
      });
    }
    if (dstChain !== want.dst) {
      issues.push({
        field: "dstChain",
        message: `direction ${direction} requires dstChain=${want.dst} (got ${dstChain})`,
      });
    }
  }

  // srcAddress
  const srcAddress = req["srcAddress"];
  if (typeof srcAddress !== "string" || srcAddress.length === 0) {
    issues.push({ field: "srcAddress", message: "srcAddress is required" });
  } else if (typeof srcChain === "string" && validChains.includes(srcChain)) {
    const err = validateChainAddress(srcChain as Chain, srcAddress);
    if (err) issues.push({ field: "srcAddress", message: err });
  }

  // dstAddress
  const dstAddress = req["dstAddress"];
  if (typeof dstAddress !== "string" || dstAddress.length === 0) {
    issues.push({ field: "dstAddress", message: "dstAddress is required" });
  } else if (typeof dstChain === "string" && validChains.includes(dstChain)) {
    const err = validateChainAddress(dstChain as Chain, dstAddress);
    if (err) issues.push({ field: "dstAddress", message: err });
  }

  // srcAsset
  const srcAsset = req["srcAsset"];
  if (typeof srcAsset !== "string" || srcAsset.length === 0) {
    issues.push({ field: "srcAsset", message: "srcAsset is required" });
  }

  // dstAsset
  const dstAsset = req["dstAsset"];
  if (typeof dstAsset !== "string" || dstAsset.length === 0) {
    issues.push({ field: "dstAsset", message: "dstAsset is required" });
  }

  // srcAmount
  const srcAmount = req["srcAmount"];
  if (typeof srcAmount !== "string") {
    issues.push({ field: "srcAmount", message: "srcAmount is required" });
  } else {
    const err = validateDecimalIntField(srcAmount, "srcAmount");
    if (err) issues.push({ field: "srcAmount", message: err });
  }

  // srcSafetyDeposit
  const srcSafetyDeposit = req["srcSafetyDeposit"];
  if (typeof srcSafetyDeposit !== "string") {
    issues.push({ field: "srcSafetyDeposit", message: "srcSafetyDeposit is required" });
  } else {
    const err = validateDecimalIntField(srcSafetyDeposit, "srcSafetyDeposit");
    if (err) issues.push({ field: "srcSafetyDeposit", message: err });
  }

  // dstAmount
  const dstAmount = req["dstAmount"];
  if (typeof dstAmount !== "string") {
    issues.push({ field: "dstAmount", message: "dstAmount is required" });
  } else {
    const err = validateDecimalIntField(dstAmount, "dstAmount");
    if (err) issues.push({ field: "dstAmount", message: err });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Like `validateAnnounceRequest` but throws `CoordinatorValidationError` on
 * the first issue found. Use when you want an exception rather than collecting
 * all issues.
 */
export function assertValidAnnounceRequest(
  input: unknown
): asserts input is CoordinatorAnnounceRequest {
  const result = validateAnnounceRequest(input);
  if (!result.ok) {
    const first = result.issues[0]!;
    throw new CoordinatorValidationError(
      first.message,
      first.field,
      result.issues.map((i) => `${i.field}: ${i.message}`)
    );
  }
}
