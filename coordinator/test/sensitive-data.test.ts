/**
 * Sensitive-data handling policy enforcement tests.
 *
 * These tests prove that:
 *  1. redactSensitiveFields() strips every name in SENSITIVE_FIELD_NAMES.
 *  2. Redaction is recursive (nested objects, arrays, error objects).
 *  3. Circular references and deep nesting are handled safely.
 *  4. Non-sensitive fields are never altered.
 *  5. SecretService does NOT log the raw preimage during reveal or on
 *     validation failure — captured log output is checked directly.
 *  6. InvalidPreimageError messages never contain the rejected value.
 *  7. The repository stores an encrypted blob (not the plaintext) when
 *     a key is configured — double-checked via raw DB row inspection.
 *  8. isSensitiveField() type-guard works correctly.
 *
 * See coordinator/src/sensitive/SENSITIVE_DATA_POLICY.md for the full policy.
 */

import { describe, it, expect, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import pino, { type Logger } from "pino";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import {
  redactSensitiveFields,
  sensitiveSerializers,
  isSensitiveField,
  SENSITIVE_FIELD_NAMES,
  REDACTED_PLACEHOLDER,
} from "../src/sensitive/sensitive-fields.js";
import { InvalidPreimageError } from "../src/services/secret-errors.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const VALID_KEY_HEX = "a".repeat(64);
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

function makePreimage(): { preimage: string; hashlock: string } {
  const buf = randomBytes(32);
  return {
    preimage: "0x" + buf.toString("hex"),
    hashlock: "0x" + createHash("sha256").update(buf).digest("hex"),
  };
}

async function freshServices(key?: string) {
  const dir = mkdtempSync(resolve(tmpdir(), "wf-sensitive-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const repo = new OrdersRepository(db);
  const nullLog = pino({ level: "silent" });
  const orders = new OrderService(repo, nullLog);
  const secrets = new SecretService(orders, nullLog, key);
  return { repo, orders, secrets, db };
}

async function seedLockedOrder(orders: OrderService, hashlock: string): Promise<string> {
  const order = await orders.announce({
    direction: "eth_to_xlm",
    hashlock,
    srcChain: "ethereum",
    srcAddress: VALID_ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: "stellar",
    dstAddress: VALID_STELLAR_ADDR,
    dstAsset: "native",
    dstAmount: "100000000",
  });
  await orders.recordSrcLock({
    publicId: order.publicId,
    orderId: "1",
    txHash: "0xsrc",
    blockNumber: 1,
    timelock: Math.floor(Date.now() / 1000) + 3600,
  });
  return order.publicId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. redactSensitiveFields — field-level redaction
// ═══════════════════════════════════════════════════════════════════════════════

describe("redactSensitiveFields — top-level sensitive keys", () => {
  it("replaces every name in SENSITIVE_FIELD_NAMES with REDACTED_PLACEHOLDER", () => {
    const obj: Record<string, unknown> = {};
    for (const name of SENSITIVE_FIELD_NAMES) {
      obj[name] = "super-secret-value-" + name;
    }
    const result = redactSensitiveFields(obj) as Record<string, unknown>;
    for (const name of SENSITIVE_FIELD_NAMES) {
      expect(result[name]).toBe(REDACTED_PLACEHOLDER);
    }
  });

  it("preserves non-sensitive fields unchanged", () => {
    const obj = { publicId: "wf_abc", status: "src_locked", amount: "1e18" };
    const result = redactSensitiveFields(obj);
    expect(result).toEqual(obj);
  });

  it("redacts 'preimage' at the top level", () => {
    const result = redactSensitiveFields({ preimage: "0x" + "cc".repeat(32) }) as any;
    expect(result.preimage).toBe(REDACTED_PLACEHOLDER);
  });

  it("redacts 'secret' at the top level", () => {
    const result = redactSensitiveFields({ secret: "mysecret" }) as any;
    expect(result.secret).toBe(REDACTED_PLACEHOLDER);
  });

  it("null and undefined pass through", () => {
    expect(redactSensitiveFields(null)).toBeNull();
    expect(redactSensitiveFields(undefined)).toBeUndefined();
  });

  it("primitives (number, string, boolean) pass through", () => {
    expect(redactSensitiveFields(42)).toBe(42);
    expect(redactSensitiveFields("hello")).toBe("hello");
    expect(redactSensitiveFields(true)).toBe(true);
  });
});

describe("redactSensitiveFields — recursive redaction", () => {
  it("redacts a sensitive field nested in a plain object", () => {
    const obj = { outer: { preimage: "0x" + "aa".repeat(32), safe: "ok" } };
    const result = redactSensitiveFields(obj) as any;
    expect(result.outer.preimage).toBe(REDACTED_PLACEHOLDER);
    expect(result.outer.safe).toBe("ok");
  });

  it("redacts a sensitive field inside an array element", () => {
    const arr = [{ preimage: "0x" + "bb".repeat(32) }, { status: "announced" }];
    const result = redactSensitiveFields(arr) as any[];
    expect(result[0].preimage).toBe(REDACTED_PLACEHOLDER);
    expect(result[1].status).toBe("announced");
  });

  it("redacts sensitive fields in a deeply nested structure", () => {
    const deep = { a: { b: { c: { preimage: "secret", safe: 1 } } } };
    const result = redactSensitiveFields(deep) as any;
    expect(result.a.b.c.preimage).toBe(REDACTED_PLACEHOLDER);
    expect(result.a.b.c.safe).toBe(1);
  });

  it("stops at depth 4 and returns [MAX_DEPTH] for objects beyond that", () => {
    const deep = { a: { b: { c: { d: { preimage: "secret" } } } } };
    const result = redactSensitiveFields(deep) as any;
    // depth 0=root, 1=a's value, 2=b's value, 3=c's value, 4=d's value → truncated
    expect(result.a.b.c.d).toBe("[MAX_DEPTH]");
  });

  it("handles circular references without infinite loop", () => {
    const obj: any = { preimage: "secret", safe: "ok" };
    obj.self = obj; // circular
    expect(() => redactSensitiveFields(obj)).not.toThrow();
    const result = redactSensitiveFields(obj) as any;
    expect(result.preimage).toBe(REDACTED_PLACEHOLDER);
    expect(result.safe).toBe("ok");
    expect(result.self).toBe("[CIRCULAR]");
  });
});

describe("redactSensitiveFields — mixed sensitive + log-record shape", () => {
  it("redacts preimage inside an order-like object while preserving public fields", () => {
    const order = {
      publicId: "wf_abc",
      status: "secret_revealed",
      hashlock: "0x" + "aa".repeat(32),
      preimage: "0x" + "bb".repeat(32),
      srcAddress: VALID_ETH_ADDR,
      dstAddress: VALID_STELLAR_ADDR,
    };
    const result = redactSensitiveFields(order) as any;
    expect(result.preimage).toBe(REDACTED_PLACEHOLDER);
    expect(result.hashlock).toBe(order.hashlock); // hashlock is NOT sensitive
    expect(result.publicId).toBe(order.publicId);
    expect(result.status).toBe(order.status);
    expect(result.srcAddress).toBe(order.srcAddress);
    expect(result.dstAddress).toBe(order.dstAddress);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. sensitiveSerializers + isSensitiveField
// ═══════════════════════════════════════════════════════════════════════════════

describe("sensitiveSerializers", () => {
  it("returns an object with serializers for order, err, req, res", () => {
    const s = sensitiveSerializers();
    expect(typeof s.order).toBe("function");
    expect(typeof s.err).toBe("function");
    expect(typeof s.req).toBe("function");
    expect(typeof s.res).toBe("function");
  });

  it("order serializer redacts preimage", () => {
    const s = sensitiveSerializers();
    const result = s.order({ publicId: "wf_x", preimage: "0x" + "cc".repeat(32) }) as any;
    expect(result.preimage).toBe(REDACTED_PLACEHOLDER);
    expect(result.publicId).toBe("wf_x");
  });

  it("err serializer redacts secret inside error-shaped object", () => {
    const s = sensitiveSerializers();
    const result = s.err({ message: "bad", secret: "leak" }) as any;
    expect(result.secret).toBe(REDACTED_PLACEHOLDER);
    expect(result.message).toBe("bad");
  });
});

describe("isSensitiveField", () => {
  it("returns true for every name in SENSITIVE_FIELD_NAMES", () => {
    for (const name of SENSITIVE_FIELD_NAMES) {
      expect(isSensitiveField(name)).toBe(true);
    }
  });

  it("returns false for safe field names", () => {
    expect(isSensitiveField("publicId")).toBe(false);
    expect(isSensitiveField("hashlock")).toBe(false);
    expect(isSensitiveField("status")).toBe(false);
    expect(isSensitiveField("srcAddress")).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 3. SecretService — preimage never leaks into logs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log-capture helper.
 * Creates a Pino logger that writes to an in-memory array so tests can
 * assert on what was (and was not) logged.
 */
function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const dest = {
    write(chunk: string) {
      lines.push(chunk);
    },
  };
  const logger = pino({ level: "trace" }, dest as any);
  return { logger, lines };
}

describe("SecretService — raw preimage never appears in log output", () => {
  it("reveal() does not log the plaintext preimage (encryption disabled)", async () => {
    const { logger, lines } = captureLogger();
    const dir = mkdtempSync(resolve(tmpdir(), "wf-logtest-"));
    const db = await openDatabase(`file:${dir}/test.db`);
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, logger);
    const secrets = new SecretService(orders, logger); // no key

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedLockedOrder(orders, hashlock);
    await secrets.reveal(publicId, preimage, "0xtxhash");

    const allOutput = lines.join(" ");
    expect(allOutput).not.toContain(preimage);
    expect(allOutput).not.toContain(preimage.slice(2)); // bare hex without 0x
  });

  it("reveal() does not log the plaintext preimage (encryption enabled)", async () => {
    const { logger, lines } = captureLogger();
    const dir = mkdtempSync(resolve(tmpdir(), "wf-logtest-enc-"));
    const db = await openDatabase(`file:${dir}/test.db`);
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, logger);
    const secrets = new SecretService(orders, logger, VALID_KEY_HEX);

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedLockedOrder(orders, hashlock);
    await secrets.reveal(publicId, preimage, "0xtxhash");

    const allOutput = lines.join(" ");
    expect(allOutput).not.toContain(preimage);
    expect(allOutput).not.toContain(preimage.slice(2));
  });

  it("failed reveal (wrong preimage) does not log the rejected preimage", async () => {
    const { logger, lines } = captureLogger();
    const dir = mkdtempSync(resolve(tmpdir(), "wf-logtest-fail-"));
    const db = await openDatabase(`file:${dir}/test.db`);
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, logger);
    const secrets = new SecretService(orders, logger);

    const { hashlock } = makePreimage();
    const wrongPreimage = "0x" + "de".repeat(32);
    const publicId = await seedLockedOrder(orders, hashlock);

    await expect(secrets.reveal(publicId, wrongPreimage, "0xtx")).rejects.toThrow();

    const allOutput = lines.join(" ");
    // The rejected preimage must NOT appear in any log output
    expect(allOutput).not.toContain(wrongPreimage);
    expect(allOutput).not.toContain("de".repeat(32));
  });
});

describe("SecretService — InvalidPreimageError message never contains the rejected value", () => {
  it("error message does not include the wrong preimage hex", async () => {
    const { secrets } = await freshServices();
    const { hashlock } = makePreimage();
    const publicId = await seedLockedOrder(
      (await freshServices()).orders,
      hashlock,
    );
    // Use a fresh env to avoid cross-test DB sharing
    const { orders: o2, secrets: s2 } = await freshServices();
    const { hashlock: hl2 } = makePreimage();
    const pid2 = await seedLockedOrder(o2, hl2);
    const badPreimage = "0x" + "ef".repeat(32);

    const err = await s2.reveal(pid2, badPreimage, "0xtx").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidPreimageError);

    // The error message must not leak the rejected preimage value
    expect(err.message).not.toContain(badPreimage);
    expect(err.message).not.toContain("ef".repeat(32));
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 4. Repository layer — encryption at rest (plaintext never in DB column)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Repository — preimage stored as encrypted blob when key is configured", () => {
  it("raw DB row does not contain the plaintext preimage when encryption is enabled", async () => {
    const { repo, orders, secrets } = await freshServices(VALID_KEY_HEX);

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedLockedOrder(orders, hashlock);
    await secrets.reveal(publicId, preimage, "0xtxhash");

    // Read the raw DB row directly (bypasses SecretService decryption)
    const row = await repo.findByPublicId(publicId);
    expect(row).not.toBeNull();

    // The stored value must NOT be the plaintext preimage
    expect(row!.preimage).not.toBe(preimage);
    expect(row!.preimage).not.toMatch(/^0x/); // encrypted blobs have no 0x prefix
    expect(row!.preimageEncVersion).toBe(1);  // encryption version is set
  });

  it("raw DB row contains the plaintext preimage when encryption is disabled (plaintext mode)", async () => {
    const { repo, orders, secrets } = await freshServices(); // no key

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedLockedOrder(orders, hashlock);
    await secrets.reveal(publicId, preimage, "0xtxhash");

    const row = await repo.findByPublicId(publicId);
    // In plaintext mode the raw preimage IS stored; this is intentional
    // and documented. In production SECRET_STORAGE_KEY should be set.
    expect(row!.preimage).toBe(preimage);
    expect(row!.preimageEncVersion).toBeNull(); // no encryption version
  });

  it("SecretService.get() decrypts to original value and never returns the blob", async () => {
    const { orders, secrets } = await freshServices(VALID_KEY_HEX);

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedLockedOrder(orders, hashlock);
    await secrets.reveal(publicId, preimage, "0xtxhash");

    const retrieved = await secrets.get(publicId);
    expect(retrieved).toBe(preimage);   // correct plaintext returned
    expect(retrieved).toMatch(/^0x/);  // it's a hex preimage, not a blob
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. redactSensitiveFields used as a Pino serializer on a log record
// ═══════════════════════════════════════════════════════════════════════════════

describe("Log record with sensitiveSerializers — end-to-end redaction", () => {
  it("a log record using the order serializer does not emit the preimage", () => {
    const lines: string[] = [];
    const logger = pino(
      { level: "info", serializers: sensitiveSerializers() },
      { write: (chunk: string) => lines.push(chunk) } as any,
    );

    const order = {
      publicId: "wf_test",
      status: "secret_revealed",
      preimage: "0x" + "aa".repeat(32),
      hashlock: "0x" + "bb".repeat(32),
    };

    logger.info({ order }, "order status updated");

    const output = lines.join(" ");
    expect(output).not.toContain("0x" + "aa".repeat(32));
    expect(output).toContain(REDACTED_PLACEHOLDER);
    expect(output).toContain("wf_test");           // publicId preserved
    expect(output).toContain("0x" + "bb".repeat(32)); // hashlock preserved
  });

  it("an object with both sensitive and safe fields is partially redacted", () => {
    const lines: string[] = [];
    const logger = pino(
      { level: "info" },
      { write: (chunk: string) => lines.push(chunk) } as any,
    );

    const sensitivePreimage = "0x" + "cc".repeat(32);
    const ctx = redactSensitiveFields({
      publicId: "wf_safe",
      hashlock: "0x" + "dd".repeat(32),
      preimage: sensitivePreimage,
    });
    logger.info(ctx, "audit");

    const output = lines.join(" ");
    expect(output).not.toContain(sensitivePreimage);
    expect(output).toContain(REDACTED_PLACEHOLDER);
    expect(output).toContain("wf_safe");
  });
});
