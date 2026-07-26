/**
 * Example: the error/response model.
 *
 * Every SDK surface that touches the network throws a typed error you can
 * discriminate with `instanceof` instead of parsing strings:
 *
 *  - Coordinator calls (CoordinatorClient, HistoryClient, OrderSubscriber)
 *    throw subclasses of `CoordinatorError` (see @wafflefinance/sdk/coordinator).
 *  - Chain client calls (EthereumHTLCAdapter, SorobanHTLCAdapter,
 *    SolanaHTLCAdapter, and the underlying *HTLCClient classes) throw
 *    `HTLCError` (see @wafflefinance/sdk/htlc-client) for expected failures.
 *  - Asset resolution helpers throw `UnsupportedAssetError` (see
 *    @wafflefinance/sdk/assets) when an asset has no mapping for the
 *    requested direction/network.
 *
 * `packages/sdk/test/examples.test.ts` drives this classifier against one
 * instance of every error subclass so a renamed/removed error class fails
 * CI instead of silently going stale in this example.
 */

import {
  CoordinatorError,
  CoordinatorApiError,
  CoordinatorNetworkError,
  CoordinatorParseError,
  CoordinatorValidationError,
} from "../src/coordinator/index.js";
import { HTLCError } from "../src/htlc-client.js";
import { UnsupportedAssetError } from "../src/assets/index.js";

export type ErrorCategory =
  | "invalid_request" // never sent — fix the caller's input
  | "rejected_by_coordinator" // sent, coordinator said no
  | "network_or_parse" // sent, transport/parse failure — safe to retry
  | "chain_operation_failed" // on-chain create/claim/refund failure
  | "unsupported_asset" // no mapping for this asset on this direction/network
  | "unknown";

/**
 * Classify any error thrown by the SDK into a category a UI can branch on
 * (e.g. show a form error vs. a "try again" toast vs. an unexpected-error
 * report).
 */
export function classifySdkError(err: unknown): ErrorCategory {
  // Order matters: check the most specific subclasses before the base class.
  if (err instanceof CoordinatorValidationError) return "invalid_request";
  if (err instanceof CoordinatorApiError) return "rejected_by_coordinator";
  if (err instanceof CoordinatorNetworkError || err instanceof CoordinatorParseError) {
    return "network_or_parse";
  }
  if (err instanceof CoordinatorError) return "unknown"; // future subclass we don't special-case yet
  if (err instanceof HTLCError) return "chain_operation_failed";
  if (err instanceof UnsupportedAssetError) return "unsupported_asset";
  return "unknown";
}

/** Whether the caller should retry the same request without changes. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof CoordinatorApiError) return err.retryable;
  if (err instanceof CoordinatorNetworkError) return true;
  if (err instanceof HTLCError) return err.retryable;
  return false;
}
