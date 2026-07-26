import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";

const mockReadContract = vi.fn();
const mockWriteContract = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: mockReadContract,
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
    })),
    createWalletClient: vi.fn(() => ({
      writeContract: mockWriteContract,
    })),
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({ address: "0xResolverAddress" })),
}));

const cfg = {
  network: "testnet" as const,
  pollIntervalMs: 15000,
  coordinatorUrl: "",
  logLevel: "silent" as const,
  ethereum: {
    chainId: 11155111,
    rpcUrl: "http://localhost:8545",
    htlcEscrow: "0xEscrow" as const,
    resolverRegistry: "0xRegistry" as `0x${string}`,
    resolverPrivateKey: "0xabc123" as `0x${string}`,
  },
  soroban: {
    rpcUrl: "",
    networkPassphrase: "",
    horizonUrl: "",
    htlc: null,
    resolverRegistry: null,
    resolverSecret: null,
  },
};

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(() => cfg),
}));

vi.mock("../src/logger.js", () => ({
  getLogger: vi.fn(() => pino({ level: "silent" })),
}));

import { registerCommand, statusCommand, unregisterCommand } from "../src/commands/register.js";
import { registry, registrationInfo, registrationChangesTotal, operationFailuresTotal } from "../src/metrics.js";

beforeEach(() => {
  vi.clearAllMocks();
  registry.resetMetrics();
});

describe("registerCommand", () => {
  it("registers and records registration metrics on success", async () => {
    mockReadContract
      .mockResolvedValueOnce("0xStakeAsset") // stakeAsset
      .mockResolvedValueOnce(6) // decimals
      .mockResolvedValueOnce("USDC") // symbol
      .mockResolvedValueOnce(1000n); // minStake
    mockWriteContract.mockResolvedValueOnce("0xApproveTx").mockResolvedValueOnce("0xRegisterTx");
    mockWaitForTransactionReceipt.mockResolvedValue({ gasUsed: 21000n });

    await registerCommand();

    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 1");
    expect(metrics).toContain(
      'resolver_registration_changes_total{action="register"} 1'
    );
  });

  it("retries transient RPC read failures before succeeding", async () => {
    mockReadContract
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce("0xStakeAsset")
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce("USDC")
      .mockResolvedValueOnce(1000n);
    mockWriteContract.mockResolvedValueOnce("0xApproveTx").mockResolvedValueOnce("0xRegisterTx");
    mockWaitForTransactionReceipt.mockResolvedValue({ gasUsed: 21000n });

    await registerCommand();

    expect(mockReadContract).toHaveBeenCalledTimes(5);
    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 1");
  }, 10000);

  it("does not retry the write path and reports a classified failure on rejection", async () => {
    mockReadContract
      .mockResolvedValueOnce("0xStakeAsset")
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce("USDC")
      .mockResolvedValueOnce(1000n);
    mockWriteContract.mockRejectedValueOnce(new Error("insufficient funds"));

    await expect(registerCommand()).rejects.toThrow("insufficient funds");

    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    const metrics = await registry.metrics();
    expect(metrics).toContain(
      'resolver_operation_failures_total{chain="ethereum",operation="register",failure_reason="unknown_error"} 1'
    );
  });

  it("rejects a stake below the minimum without submitting any transaction", async () => {
    mockReadContract
      .mockResolvedValueOnce("0xStakeAsset")
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce("USDC")
      .mockResolvedValueOnce(1000n);

    await expect(registerCommand("0.0001")).rejects.toThrow(/below minimum/);
    expect(mockWriteContract).not.toHaveBeenCalled();
  });
});

describe("statusCommand", () => {
  it("reflects an active resolver in the registration_info gauge", async () => {
    mockReadContract
      .mockResolvedValueOnce({ resolver: "0xResolverAddress", stake: 1000n })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(1000n);

    await statusCommand();

    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 1");
  });

  it("reflects an inactive resolver in the registration_info gauge", async () => {
    mockReadContract
      .mockResolvedValueOnce({ resolver: "0xResolverAddress", stake: 0n })
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(1000n);

    await statusCommand();

    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 0");
  });
});

describe("unregisterCommand", () => {
  it("unregisters and records registration metrics on success", async () => {
    mockWriteContract.mockResolvedValueOnce("0xUnregisterTx");
    mockWaitForTransactionReceipt.mockResolvedValue({ gasUsed: 21000n });

    await unregisterCommand();

    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 0");
    expect(metrics).toContain(
      'resolver_registration_changes_total{action="unregister"} 1'
    );
  });

  it("propagates a write failure with a classified failure metric", async () => {
    mockWriteContract.mockRejectedValueOnce(new Error("nonce too low"));

    await expect(unregisterCommand()).rejects.toThrow("nonce too low");

    const metrics = await registry.metrics();
    expect(metrics).toContain(
      'resolver_operation_failures_total{chain="ethereum",operation="unregister",failure_reason="unknown_error"} 1'
    );
  });
});
