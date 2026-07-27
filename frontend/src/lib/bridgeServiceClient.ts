/**
 * Typed service client for all bridge coordinator and relayer API calls.
 *
 * Every request goes through callApi, which centralises network error
 * classification, HTTP status normalisation, and JSON parsing into the typed
 * OrderSubmissionFailure contract. Route-specific wrappers reduce ad-hoc fetch
 * calls in components to thin, typed call-sites with a single consistent
 * request-serialisation and response-parsing path.
 */

import { callApi, type OrderSubmissionFailure } from './orderSubmissionFallback';

// ── Request shapes ───────────────────────────────────────────────────────────

export interface CreateOrderRequest {
  direction: string;
  amount: string;
  ethAddress: string;
  stellarAddress: string;
  solanaAddress?: string;
  destinationAddress?: string;
  exchangeRate?: number;
  networkMode?: 'testnet' | 'mainnet';
  [key: string]: unknown;
}

export interface ProcessOrderRequest {
  orderId: string;
  ethTxHash: string;
  [key: string]: unknown;
}

export interface XlmToEthRequest {
  orderId: string;
  stellarTxHash: string;
  [key: string]: unknown;
}

export interface AnnounceOrderRequest {
  orderId: string;
  direction: string;
  solanaTxSignature: string;
  solanaAddress?: string;
  [key: string]: unknown;
}

export interface HistoryRequest {
  eth?: string;
  stellar?: string;
}

// ── Response shapes ──────────────────────────────────────────────────────────

export interface PricesResponse {
  xlmPerEth: number;
  ethUsd: number;
  xlmUsd: number;
  solUsd?: number;
  staleness?: 'fresh' | 'stale' | 'fallback';
  fetchedAt?: number;
}

export interface CreateOrderResponse {
  orderId: string;
  status?: string;
  approvalTransaction?: Record<string, unknown>;
  proxyTransaction?: Record<string, unknown>;
  instructions?: string;
  [key: string]: unknown;
}

export interface ProcessOrderResponse {
  status: string;
  stellarTxHash?: string;
  [key: string]: unknown;
}

export interface XlmToEthResponse {
  status: string;
  ethTxHash?: string;
  [key: string]: unknown;
}

export interface AnnounceOrderResponse {
  accepted?: boolean;
  status?: string;
  [key: string]: unknown;
}

export interface HistoryResponse {
  transactions: Record<string, unknown>[];
}

// ── Unified result ───────────────────────────────────────────────────────────

export type ClientResult<T> =
  | { ok: true; data: T; status: number }
  | OrderSubmissionFailure;

// ── Client ───────────────────────────────────────────────────────────────────

export class BridgeServiceClient {
  constructor(
    readonly apiBase: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  async getPrices(): Promise<ClientResult<PricesResponse>> {
    const res = await callApi(`${this.apiBase}/api/prices`, { method: 'GET' }, this.fetcher);
    if (!res.ok) return res;
    return { ok: true, data: res.body as unknown as PricesResponse, status: res.status };
  }

  async createOrder(params: CreateOrderRequest): Promise<ClientResult<CreateOrderResponse>> {
    const res = await callApi(
      `${this.apiBase}/api/orders/create`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
      this.fetcher,
    );
    if (!res.ok) return res;
    return { ok: true, data: res.body as unknown as CreateOrderResponse, status: res.status };
  }

  async processOrder(params: ProcessOrderRequest): Promise<ClientResult<ProcessOrderResponse>> {
    const res = await callApi(
      `${this.apiBase}/api/orders/process`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
      this.fetcher,
    );
    if (!res.ok) return res;
    return { ok: true, data: res.body as unknown as ProcessOrderResponse, status: res.status };
  }

  async xlmToEth(params: XlmToEthRequest): Promise<ClientResult<XlmToEthResponse>> {
    const res = await callApi(
      `${this.apiBase}/api/orders/xlm-to-eth`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
      this.fetcher,
    );
    if (!res.ok) return res;
    return { ok: true, data: res.body as unknown as XlmToEthResponse, status: res.status };
  }

  async announceOrder(params: AnnounceOrderRequest): Promise<ClientResult<AnnounceOrderResponse>> {
    const res = await callApi(
      `${this.apiBase}/api/orders/announce`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
      this.fetcher,
    );
    if (!res.ok) return res;
    return { ok: true, data: res.body as unknown as AnnounceOrderResponse, status: res.status };
  }

  async getHistory(params: HistoryRequest): Promise<ClientResult<HistoryResponse>> {
    const qs = new URLSearchParams();
    if (params.eth) qs.set('eth', params.eth);
    if (params.stellar) qs.set('stellar', params.stellar);
    const res = await callApi(
      `${this.apiBase}/api/orders/history?${qs.toString()}`,
      { method: 'GET' },
      this.fetcher,
    );
    if (!res.ok) return res;
    const raw = res.body as Record<string, unknown>;
    return {
      ok: true,
      data: { transactions: Array.isArray(raw?.transactions) ? (raw.transactions as Record<string, unknown>[]) : [] },
      status: res.status,
    };
  }
}

export function createBridgeServiceClient(
  apiBase: string,
  fetcher: typeof fetch = globalThis.fetch,
): BridgeServiceClient {
  return new BridgeServiceClient(apiBase, fetcher);
}
