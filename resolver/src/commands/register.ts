import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Chain
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, mainnet } from "viem/chains";
import { supportsAction } from "@wafflefinance/config";
import { loadConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { retryRpcCall } from "../retry.js";
import { runResolverCommand } from "../command-runner.js";
import { buildSupportPolicy } from "../support.js";
import { registrationInfo, registrationChangesTotal } from "../metrics.js";

const CHAIN_ETH = "ethereum";

/**
 * Ethereum chain ids the registry commands can operate on.
 *
 * Replaces a `chainId === 1 ? mainnet : sepolia` fallback, under which *any*
 * unrecognised chain id was silently treated as Sepolia — a resolver pointed at
 * an unsupported network would have signed transactions using the wrong chain
 * definition.  An unknown id is now a hard failure.
 */
const EVM_CHAINS: Readonly<Record<number, Chain>> = {
  [mainnet.id]: mainnet,
  [sepolia.id]: sepolia,
};

function resolveEvmChain(chainId: number): Chain {
  const chain = EVM_CHAINS[chainId];
  if (!chain) {
    throw new Error(
      `Ethereum chain id ${chainId} is not supported for registry actions ` +
        `(supported: ${Object.keys(EVM_CHAINS).join(", ")})`
    );
  }
  return chain;
}

const REGISTRY_ABI = parseAbi([
  "function register(uint256 stake)",
  "function increaseStake(uint256 additional)",
  "function unregister()",
  "function isActive(address resolver) view returns (bool)",
  "function get(address resolver) view returns ((address resolver,uint256 stake,uint64 registeredAt,uint64 lastSlashAt,uint256 totalSlashed,bool active))",
  "function getActiveResolvers() view returns ((address resolver,uint256 stake,uint64 registeredAt,uint64 lastSlashAt,uint256 totalSlashed,bool active)[])",
  "function getBatchInfo(address[] resolvers) view returns ((address resolver,uint256 stake,uint64 registeredAt,uint64 lastSlashAt,uint256 totalSlashed,bool active)[])",
  "function list() view returns (address[])",
  "function getResolverCount() view returns (uint256)",
  "function minStake() view returns (uint256)",
  "function stakeAsset() view returns (address)"
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
]);

function ensureEvmContext() {
  const cfg = loadConfig();
  const log = getLogger(cfg.logLevel);

  // Registry staking is gated on the support policy rather than on local null
  // checks, so the CLI refuses for the same reason — and with the same wording —
  // that `/support` and the startup log report.
  const policy = buildSupportPolicy(cfg);
  const canRegister = supportsAction(policy, "ethereum", "register");
  if (!canRegister.supported) {
    throw new Error(`resolver cannot register: ${canRegister.reason}`);
  }

  // Narrowing for the type checker.  The policy check above already guarantees
  // both values are present; these throws are unreachable in practice.
  if (!cfg.ethereum.resolverRegistry) {
    throw new Error("ETH_RESOLVER_REGISTRY contract address is not configured");
  }
  if (!cfg.ethereum.resolverPrivateKey) {
    throw new Error("RESOLVER_ETH_PRIVATE_KEY env var is required for registry actions");
  }

  const chain = resolveEvmChain(cfg.ethereum.chainId);
  const account = privateKeyToAccount(cfg.ethereum.resolverPrivateKey);
  const publicClient = createPublicClient({ chain, transport: http(cfg.ethereum.rpcUrl) });
  const walletClient = createWalletClient({ chain, account, transport: http(cfg.ethereum.rpcUrl) });

  return { cfg, log, account, publicClient, walletClient };
}

export async function registerCommand(amountInput?: string): Promise<void> {
  const { cfg, log, account, publicClient, walletClient } = ensureEvmContext();
  const registry = cfg.ethereum.resolverRegistry as Address;

  return runResolverCommand({ operation: "register", chain: CHAIN_ETH, log }, async () => {
    // Reads are safe to retry on transient RPC failure — they have no
    // side effects. Writes below are not retried by this wrapper: retrying
    // a submitted transaction risks double-submission.
    const stakeAsset = (await retryRpcCall(
      () =>
        publicClient.readContract({
          address: registry,
          abi: REGISTRY_ABI,
          functionName: "stakeAsset"
        }),
      { logger: log }
    )) as Address;
    const decimals = await retryRpcCall(
      () =>
        publicClient.readContract({
          address: stakeAsset,
          abi: ERC20_ABI,
          functionName: "decimals"
        }),
      { logger: log }
    );
    const symbol = await retryRpcCall(
      () =>
        publicClient.readContract({
          address: stakeAsset,
          abi: ERC20_ABI,
          functionName: "symbol"
        }),
      { logger: log }
    );

    const minStake = (await retryRpcCall(
      () =>
        publicClient.readContract({
          address: registry,
          abi: REGISTRY_ABI,
          functionName: "minStake"
        }),
      { logger: log }
    )) as bigint;

    const stake = amountInput
      ? parseUnits(amountInput, decimals as number)
      : minStake;

    if (stake < minStake) {
      throw new Error(`Stake ${stake} is below minimum ${minStake}`);
    }

    log.info({ stakeAsset, symbol, stake: stake.toString() }, "approving stake transfer");
    const approveTx = await walletClient.writeContract({
      address: stakeAsset,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [registry, stake]
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });

    log.info({ stake: stake.toString() }, "calling registry.register");
    const tx = await walletClient.writeContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "register",
      args: [stake]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    log.info({ tx, gasUsed: receipt.gasUsed.toString() }, "registered as resolver");
    log.info(`Resolver ${account.address} is now registered with ${stake} ${symbol}.`);

    registrationInfo.set(1);
    registrationChangesTotal.inc({ action: "register" });
  });
}

export async function statusCommand(): Promise<void> {
  const { cfg, log, account, publicClient } = ensureEvmContext();
  const registry = cfg.ethereum.resolverRegistry as Address;

  return runResolverCommand({ operation: "status", chain: CHAIN_ETH, log }, async () => {
    const [info, active, minStake] = await Promise.all([
      retryRpcCall(
        () =>
          publicClient.readContract({
            address: registry,
            abi: REGISTRY_ABI,
            functionName: "get",
            args: [account.address]
          }),
        { logger: log }
      ),
      retryRpcCall(
        () =>
          publicClient.readContract({
            address: registry,
            abi: REGISTRY_ABI,
            functionName: "isActive",
            args: [account.address]
          }),
        { logger: log }
      ),
      retryRpcCall(
        () =>
          publicClient.readContract({
            address: registry,
            abi: REGISTRY_ABI,
            functionName: "minStake"
          }),
        { logger: log }
      )
    ]);
    registrationInfo.set(active ? 1 : 0);
    log.info({ info, active, minStake: (minStake as bigint).toString() }, "resolver status");
  });
}

export async function unregisterCommand(): Promise<void> {
  const { cfg, log, account, publicClient, walletClient } = ensureEvmContext();
  const registry = cfg.ethereum.resolverRegistry as Address;

  return runResolverCommand({ operation: "unregister", chain: CHAIN_ETH, log }, async () => {
    const tx = await walletClient.writeContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "unregister"
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    log.info({ tx, resolver: account.address }, "unregistered");

    registrationInfo.set(0);
    registrationChangesTotal.inc({ action: "unregister" });
  });
}
