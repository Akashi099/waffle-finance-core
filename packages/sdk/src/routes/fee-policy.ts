import type { Chain, Direction, ExternalBridgeKind } from "../types/index.js";

export interface RouteFeeFixture {
  gasEstimate: bigint;
  protocolFee: bigint;
  minSafetyDeposit: bigint;
  expectedRelayCost: bigint;
}

export interface RouteFeeEstimate extends RouteFeeFixture {
  routeId: string;
  totalEstimatedCost: bigint;
  assumptions: string[];
}

export interface RouteFeePolicy {
  routeId: string;
  srcChain: Chain;
  dstChain: Chain;
  direction: Direction;
  bridgeMode: ExternalBridgeKind;
  assumptions: string[];
  defaultGasEstimate: bigint;
  defaultProtocolFee: bigint;
  defaultMinSafetyDeposit: bigint;
  defaultExpectedRelayCost: bigint;
}

export function estimateRouteFee(
  routeId: string,
  fixture: Partial<RouteFeeFixture> = {},
): RouteFeeEstimate {
  const policy = getRouteFeePolicy(routeId);
  const gasEstimate = fixture.gasEstimate ?? policy.defaultGasEstimate;
  const protocolFee = fixture.protocolFee ?? policy.defaultProtocolFee;
  const minSafetyDeposit = fixture.minSafetyDeposit ?? policy.defaultMinSafetyDeposit;
  const expectedRelayCost = fixture.expectedRelayCost ?? policy.defaultExpectedRelayCost;

  return {
    routeId: policy.routeId,
    gasEstimate,
    protocolFee,
    minSafetyDeposit,
    expectedRelayCost,
    totalEstimatedCost: gasEstimate + protocolFee + minSafetyDeposit + expectedRelayCost,
    assumptions: policy.assumptions,
  };
}

export function getRouteFeePolicy(routeId: string): RouteFeePolicy {
  const policy = ROUTE_FEE_POLICIES[routeId];
  if (!policy) {
    throw new Error(`No fee policy registered for route "${routeId}"`);
  }
  return policy;
}

const ethereumToStellarAssumptions = [
  "ethereum submission and stellar settlement",
  "native safety deposit on source leg",
];
const ethereumToSolanaAssumptions = [
  "ethereum submission and solana settlement",
  "native safety deposit on source leg",
];
const solanaToEthereumAssumptions = [
  "solana submission and ethereum settlement",
  "native safety deposit on source leg",
];

export const ROUTE_FEE_POLICIES: Readonly<Record<string, RouteFeePolicy>> = {
  "eth_to_xlm:native:wafflefinance-htlc": {
    routeId: "eth_to_xlm:native:wafflefinance-htlc",
    srcChain: "ethereum",
    dstChain: "stellar",
    direction: "eth_to_xlm",
    bridgeMode: "wafflefinance-htlc",
    assumptions: ethereumToStellarAssumptions,
    defaultGasEstimate: 10n,
    defaultProtocolFee: 3n,
    defaultMinSafetyDeposit: 5n,
    defaultExpectedRelayCost: 2n,
  },
  "xlm_to_eth:native:wafflefinance-htlc": {
    routeId: "xlm_to_eth:native:wafflefinance-htlc",
    srcChain: "stellar",
    dstChain: "ethereum",
    direction: "xlm_to_eth",
    bridgeMode: "wafflefinance-htlc",
    assumptions: ["stellar submission and ethereum settlement", "destination relay cost included"],
    defaultGasEstimate: 12n,
    defaultProtocolFee: 4n,
    defaultMinSafetyDeposit: 6n,
    defaultExpectedRelayCost: 2n,
  },
  "eth_to_sol:native:wafflefinance-htlc": {
    routeId: "eth_to_sol:native:wafflefinance-htlc",
    srcChain: "ethereum",
    dstChain: "solana",
    direction: "eth_to_sol",
    bridgeMode: "wafflefinance-htlc",
    assumptions: ethereumToSolanaAssumptions,
    defaultGasEstimate: 11n,
    defaultProtocolFee: 3n,
    defaultMinSafetyDeposit: 4n,
    defaultExpectedRelayCost: 3n,
  },
  "sol_to_eth:native:wafflefinance-htlc": {
    routeId: "sol_to_eth:native:wafflefinance-htlc",
    srcChain: "solana",
    dstChain: "ethereum",
    direction: "sol_to_eth",
    bridgeMode: "wafflefinance-htlc",
    assumptions: solanaToEthereumAssumptions,
    defaultGasEstimate: 9n,
    defaultProtocolFee: 2n,
    defaultMinSafetyDeposit: 4n,
    defaultExpectedRelayCost: 2n,
  },
  "eth_to_xlm:usdc:wafflefinance-htlc": {
    routeId: "eth_to_xlm:usdc:wafflefinance-htlc",
    srcChain: "ethereum",
    dstChain: "stellar",
    direction: "eth_to_xlm",
    bridgeMode: "wafflefinance-htlc",
    assumptions: ["USDC route uses the same settlement assumptions as native", "protocol fee is charged against the transfer value"],
    defaultGasEstimate: 13n,
    defaultProtocolFee: 5n,
    defaultMinSafetyDeposit: 6n,
    defaultExpectedRelayCost: 3n,
  },
  "xlm_to_eth:usdc:wafflefinance-htlc": {
    routeId: "xlm_to_eth:usdc:wafflefinance-htlc",
    srcChain: "stellar",
    dstChain: "ethereum",
    direction: "xlm_to_eth",
    bridgeMode: "wafflefinance-htlc",
    assumptions: ["USDC route uses the same settlement assumptions as native", "protocol fee is charged against the transfer value"],
    defaultGasEstimate: 14n,
    defaultProtocolFee: 5n,
    defaultMinSafetyDeposit: 6n,
    defaultExpectedRelayCost: 3n,
  },
  "eth_to_sol:usdc:wafflefinance-htlc": {
    routeId: "eth_to_sol:usdc:wafflefinance-htlc",
    srcChain: "ethereum",
    dstChain: "solana",
    direction: "eth_to_sol",
    bridgeMode: "wafflefinance-htlc",
    assumptions: ["USDC route uses the same settlement assumptions as native", "protocol fee is charged against the transfer value"],
    defaultGasEstimate: 12n,
    defaultProtocolFee: 4n,
    defaultMinSafetyDeposit: 5n,
    defaultExpectedRelayCost: 3n,
  },
  "sol_to_eth:usdc:wafflefinance-htlc": {
    routeId: "sol_to_eth:usdc:wafflefinance-htlc",
    srcChain: "solana",
    dstChain: "ethereum",
    direction: "sol_to_eth",
    bridgeMode: "wafflefinance-htlc",
    assumptions: ["USDC route uses the same settlement assumptions as native", "protocol fee is charged against the transfer value"],
    defaultGasEstimate: 10n,
    defaultProtocolFee: 4n,
    defaultMinSafetyDeposit: 5n,
    defaultExpectedRelayCost: 2n,
  },
};
