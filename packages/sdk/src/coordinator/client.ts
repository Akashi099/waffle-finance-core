/**
 * CoordinatorClient — typed HTTP client for the WaffleFinance coordinator API.
 *
 * All public methods consume and return typed interfaces from ./contract.ts.
 * Errors are wrapped into the typed hierarchy from ./errors.ts so callers
 * can use instanceof guards without inspecting raw strings.
 *
 * The client performs local preflight validation (via ./validation.ts) before
 * every POST so malformed payloads are rejected locally with a clear error
 * rather than an opaque 400 from the network.
 *
 * Usage
 * ─────
 * ```ts
 * const client = new CoordinatorClient({ baseUrl: "https://coordinator.example" });
 *
 * // Announce a new swap order
 * const order = await client.announceOrder({ ... });
 *
 * // Get current order state
 * const order = await client.getOrder("wf_0x...");
 *
 * // Retrieve history for a wallet
 * const history = await client.getHistory({ address: "0x...", limit: 20 });
 *
 * // Reveal a preimage
 * await client.revealSecret({ publicId: "wf_0x...", preimage: "0x...", txHash: "0x..." });
 *
 * // Fetch a previously revealed preimage
 * const preimage = await client.getSecret("wf_0x...");
 * ```
 */

import type {
  CoordinatorAnnounceRequest,
  CoordinatorOrder,
  CoordinatorHistoryResponse,
  CoordinatorSecretResponse,
  CoordinatorRevealRequest,
  CoordinatorRevealResponse,
  CoordinatorHealthResponse,
  CoordinatorReadinessResponse,
} from "./contract.js";
import { isCoordinatorError } from "./contract.js";
import {
  CoordinatorApiError,
  CoordinatorNetworkError,
  CoordinatorParseError,
  CoordinatorValidationError,
} from "./errors.js";
import { assertValidAnnounceRequest } from "./validation.js";

// ── Options ─────────────────────────────────────────────────────────────────

export interface CoordinatorClientOptions {
  /**
   * Base URL of the coordinator, without a trailing slash.
   * Example: "https://coordinator.wafflefinance.io"
   */
  baseUrl: string;

  /**
   * Optional fetch implementation. Defaults to the global `fetch`.
   * Inject a custom fetch in tests or environments without native fetch.
   */
  fetcher?: typeof fetch;

  /**
   * Optional default request timeout in milliseconds.
   * When omitted, no timeout is applied.
   */
  timeoutMs?: number;

  /**
   * Optional bearer token for operator-level endpoints.
   * When set it is included as `Authorization: Bearer <token>`.
   */
  operatorKey?: string;
}

export interface GetHistoryOptions {
  /** Wallet address to query (Ethereum, Stellar, or Solana). */
  address: string;
  /** Max records per page. Defaults to 50, capped at 200 by the coordinator. */
  limit?: number;
  /** Cursor from a previous response for cursor-based pagination. */
  cursor?: string;
  /** Offset for legacy offset-based pagination. Use cursor instead when possible. */
  offset?: number;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class CoordinatorClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly operatorKey: string | undefined;

  constructor(options: CoordinatorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs;
    this.operatorKey = options.operatorKey;
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  /**
   * Announce a new swap order (POST /api/orders/announce).
   *
   * Performs local validation before sending. Throws `CoordinatorValidationError`
   * for locally-detectable issues; `CoordinatorApiError` for 4xx responses.
   *
   * Returns the created `CoordinatorOrder` (HTTP 201).
   */
  async announceOrder(request: CoordinatorAnnounceRequest): Promise<CoordinatorOrder> {
    // Preflight: reject malformed payloads locally before the network hit.
    assertValidAnnounceRequest(request);

    return this.post<CoordinatorOrder>("/api/orders/announce", request);
  }

  /**
   * Get a single order by public ID (GET /api/orders/:id).
   *
   * Returns null when the coordinator returns 404.
   * Throws `CoordinatorApiError` for other 4xx/5xx responses.
   */
  async getOrder(publicId: string): Promise<CoordinatorOrder | null> {
    if (!publicId) {
      throw new CoordinatorValidationError("publicId is required", "publicId");
    }
    return this.get<CoordinatorOrder | null>(`/api/orders/${encodeURIComponent(publicId)}`, {
      notFoundValue: null,
    });
  }

  /**
   * Fetch order history for a wallet address (GET /api/orders/history).
   *
   * Supports both cursor-based (preferred) and offset-based (legacy) pagination.
   * Pass `cursor` from the previous `pagination.nextCursor` to get the next page.
   */
  async getHistory(options: GetHistoryOptions): Promise<CoordinatorHistoryResponse> {
    if (!options.address) {
      throw new CoordinatorValidationError("address is required", "address");
    }

    const params = new URLSearchParams({ address: options.address });
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    else if (options.offset !== undefined) params.set("offset", String(options.offset));

    return this.get<CoordinatorHistoryResponse>(`/api/orders/history?${params.toString()}`);
  }

  // ── Secrets ──────────────────────────────────────────────────────────────

  /**
   * Reveal a preimage for an order (POST /api/secrets/reveal).
   *
   * Called by the user/relayer once the destination-leg claim tx is confirmed.
   * Returns `{ ok: true }` on success.
   */
  async revealSecret(request: CoordinatorRevealRequest): Promise<CoordinatorRevealResponse> {
    if (!request.publicId) {
      throw new CoordinatorValidationError("publicId is required", "publicId");
    }
    if (!request.preimage || !/^0x[0-9a-fA-F]+$/.test(request.preimage)) {
      throw new CoordinatorValidationError(
        "preimage must be a 0x-prefixed hex string",
        "preimage"
      );
    }
    if (!request.txHash) {
      throw new CoordinatorValidationError("txHash is required", "txHash");
    }
    return this.post<CoordinatorRevealResponse>("/api/secrets/reveal", request);
  }

  /**
   * Retrieve a previously revealed preimage (GET /api/secrets/:publicId).
   *
   * Returns null when the preimage has not been revealed yet (404).
   * Throws `CoordinatorApiError` for other error responses.
   */
  async getSecret(publicId: string): Promise<CoordinatorSecretResponse | null> {
    if (!publicId) {
      throw new CoordinatorValidationError("publicId is required", "publicId");
    }
    return this.get<CoordinatorSecretResponse | null>(
      `/api/secrets/${encodeURIComponent(publicId)}`,
      { notFoundValue: null }
    );
  }

  // ── Health ───────────────────────────────────────────────────────────────

  /** Check coordinator health (GET /health). */
  async getHealth(): Promise<CoordinatorHealthResponse> {
    return this.get<CoordinatorHealthResponse>("/health");
  }

  /** Check coordinator readiness (GET /readyz). */
  async getReadiness(): Promise<CoordinatorReadinessResponse> {
    return this.get<CoordinatorReadinessResponse>("/readyz");
  }

  // ── Low-level fetch helpers ──────────────────────────────────────────────

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extra,
    };
    if (this.operatorKey) {
      headers["Authorization"] = `Bearer ${this.operatorKey}`;
    }
    return headers;
  }

  private buildSignal(): AbortSignal | undefined {
    if (!this.timeoutMs) return undefined;
    return AbortSignal.timeout(this.timeoutMs);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: { notFoundValue?: T } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;

    try {
      response = await this.fetcher(url, {
        method,
        headers: this.buildHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: this.buildSignal(),
      });
    } catch (err) {
      throw new CoordinatorNetworkError(
        `Network request to ${url} failed: ${(err as Error).message}`,
        err
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new CoordinatorParseError(
        `Failed to parse coordinator response from ${url}: ${(err as Error).message}`,
        err
      );
    }

    if (!response.ok) {
      if (response.status === 404 && "notFoundValue" in opts) {
        return opts.notFoundValue as T;
      }
      if (isCoordinatorError(parsed)) {
        throw new CoordinatorApiError(
          response.status,
          parsed.error,
          parsed.message,
          parsed.retryable ?? false
        );
      }
      throw new CoordinatorApiError(
        response.status,
        "unknown_error",
        `Coordinator returned HTTP ${response.status}`
      );
    }

    return parsed as T;
  }

  private get<T>(path: string, opts: { notFoundValue?: T } = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, opts);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}
