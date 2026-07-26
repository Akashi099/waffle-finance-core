/**
 * Chain-aware quote model for the bridge flow (issue #315).
 *
 * A BridgeQuote is the single source of truth for the displayed price, route,
 * and asset pair. It is serializable to sessionStorage so it survives a
 * within-session navigation and can be rehydrated when the form remounts.
 *
 * Validation enforces that the quote has not expired and that the user has not
 * switched chains or changed the amount since the quote was generated. If
 * either invariant fails the submission path must reject the quote and wait for
 * a fresh one rather than letting a stale or mismatched quote drive the order.
 */

export type SupportedChain = 'ethereum' | 'stellar' | 'solana';

export type QuoteStaleness = 'fresh' | 'stale' | 'fallback';

export interface AssetIdentity {
  chain: SupportedChain;
  symbol: string;
  decimals: number;
}

export interface BridgeQuote {
  srcChain: SupportedChain;
  dstChain: SupportedChain;
  fromAsset: AssetIdentity;
  toAsset: AssetIdentity;
  fromAmount: string;
  estimatedToAmount: string;
  exchangeRate: number;
  feeEstimate: string;
  safetyDeposit: string;
  timelockSeconds: number;
  quotedAt: number;
  expiresAt: number;
  priceStateness: QuoteStaleness;
}

// Quotes older than 60 s are treated as stale and rejected on submission.
const QUOTE_TTL_MS = 60_000;

const STORAGE_KEY = 'wafflefinance_active_quote_v1';

export function createQuote(params: {
  srcChain: SupportedChain;
  dstChain: SupportedChain;
  fromAsset: AssetIdentity;
  toAsset: AssetIdentity;
  fromAmount: string;
  estimatedToAmount: string;
  exchangeRate: number;
  priceStateness: QuoteStaleness;
  timelockSeconds?: number;
}): BridgeQuote {
  const now = Date.now();
  return {
    srcChain: params.srcChain,
    dstChain: params.dstChain,
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    fromAmount: params.fromAmount,
    estimatedToAmount: params.estimatedToAmount,
    exchangeRate: params.exchangeRate,
    feeEstimate: '0',
    safetyDeposit: '0',
    timelockSeconds: params.timelockSeconds ?? 3600,
    quotedAt: now,
    expiresAt: now + QUOTE_TTL_MS,
    priceStateness: params.priceStateness,
  };
}

export type QuoteInvalidReason = 'expired' | 'chain_mismatch' | 'amount_mismatch' | 'missing';

export interface QuoteValidationResult {
  valid: boolean;
  reason?: QuoteInvalidReason;
  message?: string;
}

export function validateQuote(
  quote: BridgeQuote | null,
  currentSrcChain: SupportedChain,
  currentDstChain: SupportedChain,
  currentAmount: string,
): QuoteValidationResult {
  if (!quote) {
    return { valid: false, reason: 'missing', message: 'No quote available. Please enter an amount and wait for a rate.' };
  }
  if (Date.now() > quote.expiresAt) {
    return { valid: false, reason: 'expired', message: 'Quote has expired. Please wait for a fresh rate.' };
  }
  if (quote.srcChain !== currentSrcChain || quote.dstChain !== currentDstChain) {
    return { valid: false, reason: 'chain_mismatch', message: 'Route changed since the quote was generated. Please wait for a fresh rate.' };
  }
  if (quote.fromAmount !== currentAmount) {
    return { valid: false, reason: 'amount_mismatch', message: 'Amount changed since the quote was generated. Please wait for the rate to update.' };
  }
  return { valid: true };
}

export function serializeQuote(quote: BridgeQuote): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(quote));
  } catch {
    // sessionStorage may be unavailable (private browsing, storage quota)
  }
}

export function deserializeQuote(): BridgeQuote | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BridgeQuote>;
    if (
      typeof parsed.quotedAt !== 'number' ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.srcChain !== 'string' ||
      typeof parsed.dstChain !== 'string' ||
      typeof parsed.fromAmount !== 'string'
    ) {
      return null;
    }
    return parsed as BridgeQuote;
  } catch {
    return null;
  }
}

export function clearPersistedQuote(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}
