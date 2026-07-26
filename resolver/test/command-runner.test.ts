import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import { runResolverCommand, classifyFailureReason } from "../src/command-runner.js";
import { registry, operationFailuresTotal, activeOperations } from "../src/metrics.js";

const log = pino({ level: "silent" });

beforeEach(() => {
  registry.resetMetrics();
});

class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

describe("classifyFailureReason", () => {
  it("uses the error's name when it is a custom subclass", () => {
    expect(classifyFailureReason(new ConfigValidationError("bad config"))).toBe(
      "ConfigValidationError"
    );
  });

  it("falls back to unknown_error for plain Error instances", () => {
    expect(classifyFailureReason(new Error("boom"))).toBe("unknown_error");
  });

  it("falls back to unknown_error for non-Error throws", () => {
    expect(classifyFailureReason("just a string")).toBe("unknown_error");
    expect(classifyFailureReason({ code: 503 })).toBe("unknown_error");
  });
});

describe("runResolverCommand", () => {
  it("returns the wrapped function's result on success", async () => {
    const result = await runResolverCommand(
      { operation: "status", chain: "ethereum", log },
      async () => 42
    );
    expect(result).toBe(42);
  });

  it("does not increment failure metrics on success", async () => {
    await runResolverCommand({ operation: "status", chain: "ethereum", log }, async () => "ok");

    const metrics = await registry.metrics();
    expect(metrics).not.toMatch(/resolver_operation_failures_total\{.*operation="status"/);
  });

  it("records operation_failures_total with a classified reason on failure", async () => {
    await expect(
      runResolverCommand({ operation: "register", chain: "ethereum", log }, async () => {
        throw new ConfigValidationError("missing RESOLVER_ETH_PRIVATE_KEY");
      })
    ).rejects.toThrow("missing RESOLVER_ETH_PRIVATE_KEY");

    const metrics = await registry.metrics();
    expect(metrics).toContain(
      'resolver_operation_failures_total{chain="ethereum",operation="register",failure_reason="ConfigValidationError"} 1'
    );
  });

  it("rethrows the original error unchanged", async () => {
    const original = new Error("underlying rpc failure");
    await expect(
      runResolverCommand({ operation: "unregister", chain: "ethereum", log }, async () => {
        throw original;
      })
    ).rejects.toBe(original);
  });

  it("always decrements active_operations, even on failure", async () => {
    await expect(
      runResolverCommand({ operation: "register", chain: "ethereum", log }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow();

    const metrics = await registry.metrics();
    expect(metrics).toContain('resolver_active_operations{operation="register"} 0');
  });

  it("records operation duration on success", async () => {
    await runResolverCommand({ operation: "status", chain: "ethereum", log }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });

    const metrics = await registry.metrics();
    expect(metrics).toContain(
      'resolver_operation_duration_seconds_count{operation="status",chain="ethereum"} 1'
    );
  });

  it("keeps failures independent across concurrent operations", async () => {
    const [a, b] = await Promise.allSettled([
      runResolverCommand({ operation: "register", chain: "ethereum", log }, async () => {
        throw new Error("register failed");
      }),
      runResolverCommand({ operation: "status", chain: "ethereum", log }, async () => "ok"),
    ]);

    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");

    const metrics = await registry.metrics();
    expect(metrics).toContain(
      'resolver_operation_failures_total{chain="ethereum",operation="register",failure_reason="unknown_error"} 1'
    );
    expect(metrics).not.toMatch(/resolver_operation_failures_total\{.*operation="status"/);
  });
});
