/**
 * Tests for CoordinatorClient — the one coordinator surface that talks to a
 * real HTTP transport. Other coordinator tests (history-client.test.ts,
 * subscription.test.ts) stub this class out entirely, so its own fetch
 * wiring, response parsing, and error-mapping logic had no dedicated
 * coverage. This file closes that gap: happy path plus the malformed/
 * unexpected-response shapes a live coordinator can actually produce.
 *
 * All assertions go through the public CoordinatorClient API (method calls,
 * thrown error types/fields) — never through private fields — so these
 * tests hold even if the internal request/response plumbing is refactored.
 */
import { describe, it, expect, vi } from "vitest";
import { CoordinatorClient } from "../src/coordinator/client.js";
import {
  CoordinatorApiError,
  CoordinatorNetworkError,
  CoordinatorParseError,
  CoordinatorValidationError,
} from "../src/coordinator/errors.js";
import {
  announcedOrder,
  partialSrcLockedOrder,
  errorEnvelope,
  malformedErrorBody,
  mixedChainHistoryPage,
  ETH_ADDR,
  XLM_ADDR,
  HASHLOCK_A,
} from "./fixtures/coordinator-responses.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetcher: typeof fetch, extra: Partial<{ timeoutMs: number; operatorKey: string }> = {}) {
  return new CoordinatorClient({ baseUrl: "https://coordinator.example", fetcher, ...extra });
}

const VALID_ANNOUNCE = {
  direction: "eth_to_xlm" as const,
  hashlock: HASHLOCK_A,
  srcChain: "ethereum" as const,
  srcAddress: ETH_ADDR,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar" as const,
  dstAddress: XLM_ADDR,
  dstAsset: "native",
  dstAmount: "100000000",
};

describe("CoordinatorClient — announceOrder", () => {
  it("returns the created order on 201", async () => {
    const order = announcedOrder();
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(201, order));
    const c = client(fetcher as unknown as typeof fetch);

    const result = await c.announceOrder(VALID_ANNOUNCE);

    expect(result.id).toBe(order.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://coordinator.example/api/orders/announce");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ direction: "eth_to_xlm" });
  });

  it("rejects locally invalid requests without making a network call", async () => {
    const fetcher = vi.fn();
    const c = client(fetcher as unknown as typeof fetch);

    await expect(
      c.announceOrder({ ...VALID_ANNOUNCE, hashlock: "not-hex" })
    ).rejects.toBeInstanceOf(CoordinatorValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("wraps a 409 conflict as CoordinatorApiError with the coordinator's code and retryable hint", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, errorEnvelope({ error: "order_conflict", message: "duplicate hashlock", retryable: false })));
    const c = client(fetcher as unknown as typeof fetch);

    const err = await c.announceOrder(VALID_ANNOUNCE).catch((e) => e);

    expect(err).toBeInstanceOf(CoordinatorApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("order_conflict");
    expect(err.retryable).toBe(false);
  });

  it("falls back to unknown_error when a non-2xx body isn't a valid error envelope", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(500, malformedErrorBody()));
    const c = client(fetcher as unknown as typeof fetch);

    const err = await c.announceOrder(VALID_ANNOUNCE).catch((e) => e);

    expect(err).toBeInstanceOf(CoordinatorApiError);
    expect(err.status).toBe(500);
    expect(err.code).toBe("unknown_error");
  });

  it("wraps a response body that isn't valid JSON as CoordinatorParseError", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 })
    );
    const c = client(fetcher as unknown as typeof fetch);

    await expect(c.announceOrder(VALID_ANNOUNCE)).rejects.toBeInstanceOf(CoordinatorParseError);
  });

  it("wraps a fetch-level failure (network down) as CoordinatorNetworkError", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const c = client(fetcher as unknown as typeof fetch);

    const err = await c.announceOrder(VALID_ANNOUNCE).catch((e) => e);

    expect(err).toBeInstanceOf(CoordinatorNetworkError);
    expect(err.message).toContain("fetch failed");
  });

  it("includes an operator bearer token when configured", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(201, announcedOrder()));
    const c = client(fetcher as unknown as typeof fetch, { operatorKey: "secret-token" });

    await c.announceOrder(VALID_ANNOUNCE);

    const [, init] = fetcher.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-token");
  });
});

describe("CoordinatorClient — getOrder", () => {
  it("returns the order on 200", async () => {
    const order = partialSrcLockedOrder();
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, order));
    const c = client(fetcher as unknown as typeof fetch);

    const result = await c.getOrder(order.id);
    expect(result?.status).toBe("src_locked");
  });

  it("returns null on 404 instead of throwing", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(404, errorEnvelope()));
    const c = client(fetcher as unknown as typeof fetch);

    await expect(c.getOrder("wf_missing")).resolves.toBeNull();
  });

  it("throws CoordinatorValidationError for an empty publicId without calling fetch", async () => {
    const fetcher = vi.fn();
    const c = client(fetcher as unknown as typeof fetch);

    await expect(c.getOrder("")).rejects.toBeInstanceOf(CoordinatorValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("still throws CoordinatorApiError for non-404 error statuses", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(503, errorEnvelope({ error: "unavailable", message: "try later", retryable: true })));
    const c = client(fetcher as unknown as typeof fetch);

    const err = await c.getOrder("wf_x").catch((e) => e);
    expect(err).toBeInstanceOf(CoordinatorApiError);
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });
});

describe("CoordinatorClient — getHistory", () => {
  it("builds query params for cursor pagination and returns a mixed-chain page", async () => {
    const page = mixedChainHistoryPage();
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, page));
    const c = client(fetcher as unknown as typeof fetch);

    const result = await c.getHistory({ address: ETH_ADDR, limit: 10, cursor: "abc123" });

    expect(result.transactions).toHaveLength(3);
    expect(result.transactions.map((t) => t.direction)).toEqual([
      "eth_to_xlm",
      "eth_to_sol",
      "sol_to_eth",
    ]);
    const [url] = fetcher.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get("address")).toBe(ETH_ADDR);
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(parsed.searchParams.get("cursor")).toBe("abc123");
  });

  it("falls back to offset pagination when no cursor is given", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, { transactions: [], pagination: { limit: 50, offset: 20, count: 0 } })
    );
    const c = client(fetcher as unknown as typeof fetch);

    await c.getHistory({ address: ETH_ADDR, offset: 20 });

    const [url] = fetcher.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get("offset")).toBe("20");
    expect(parsed.searchParams.has("cursor")).toBe(false);
  });

  it("rejects a missing address without calling fetch", async () => {
    const fetcher = vi.fn();
    const c = client(fetcher as unknown as typeof fetch);

    await expect(c.getHistory({ address: "" })).rejects.toBeInstanceOf(CoordinatorValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("CoordinatorClient — revealSecret / getSecret", () => {
  it("validates required fields locally before sending", async () => {
    const fetcher = vi.fn();
    const c = client(fetcher as unknown as typeof fetch);

    await expect(
      c.revealSecret({ publicId: "", preimage: "0xaa", txHash: "0xbb" })
    ).rejects.toBeInstanceOf(CoordinatorValidationError);
    await expect(
      c.revealSecret({ publicId: "wf_x", preimage: "not-hex", txHash: "0xbb" })
    ).rejects.toBeInstanceOf(CoordinatorValidationError);
    await expect(
      c.revealSecret({ publicId: "wf_x", preimage: "0xaa", txHash: "" })
    ).rejects.toBeInstanceOf(CoordinatorValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reveals successfully", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const c = client(fetcher as unknown as typeof fetch);

    await expect(
      c.revealSecret({ publicId: "wf_x", preimage: "0xaa", txHash: "0xbb" })
    ).resolves.toEqual({ ok: true });
  });

  it("returns null from getSecret when not yet revealed (404)", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(404, errorEnvelope()));
    const c = client(fetcher as unknown as typeof fetch);

    await expect(c.getSecret("wf_x")).resolves.toBeNull();
  });
});

describe("CoordinatorClient — health/readiness pass-through", () => {
  it("returns the health payload as-is", async () => {
    const payload = {
      status: "ok" as const,
      service: "coordinator",
      version: "1.2.3",
      uptimeSeconds: 42,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, payload));
    const c = client(fetcher as unknown as typeof fetch);

    await expect(c.getHealth()).resolves.toEqual(payload);
  });

  it("returns a degraded readiness payload with failing checks", async () => {
    const payload = {
      status: "degraded" as const,
      service: "coordinator",
      version: "1.2.3",
      uptimeSeconds: 42,
      timestamp: "2026-01-01T00:00:00.000Z",
      checks: [{ name: "database", ok: false, detail: "connection refused" }],
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, payload));
    const c = client(fetcher as unknown as typeof fetch);

    const result = await c.getReadiness();
    expect(result.status).toBe("degraded");
    expect(result.checks[0]?.ok).toBe(false);
  });
});
