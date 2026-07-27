/**
 * Deterministic RPC-degradation fixtures shared by the coordinator's
 * degradation test matrix. Models the failure shapes a real chain RPC
 * endpoint produces under load or partial outage:
 *
 *  - "delayed"         — the endpoint is up but slow; the response arrives
 *                        after the caller's timeout has already fired.
 *  - "reset"           — the connection drops before any response is read
 *                        (ECONNRESET / network-level failure).
 *  - "partial_receipt" — the endpoint responds 200 OK but with a JSON-RPC
 *                        error envelope instead of a usable result (a
 *                        node that's up but not synced/healthy).
 *  - "ok"              — healthy passthrough, for chains not under test.
 */

export type DegradationScenario = "ok" | "delayed" | "reset" | "partial_receipt";

type FetchInit = {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
};

type FetchResult = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type DegradationFetcher = (url: string, init: FetchInit) => Promise<FetchResult>;

/**
 * Builds a fetch-like function that routes by URL substring to a configured
 * degradation scenario. Any URL not matched by `routes` behaves as healthy
 * ("ok"), so a test only has to describe the chain(s) it wants degraded.
 *
 * `delayMs` controls how long a "delayed" scenario waits before it would
 * resolve — it must be larger than the readiness probe's `timeoutMs` for the
 * probe to observe a timeout rather than a slow-but-successful response.
 * The returned promise honors `init.signal` exactly as a real `fetch` would,
 * so it exercises the same AbortController path the production code uses.
 */
export function buildDegradedFetcher(
  routes: Record<string, DegradationScenario>,
  { delayMs = 500 }: { delayMs?: number } = {}
): DegradationFetcher {
  return (url, init) => {
    const matchedKey = Object.keys(routes).find((key) => url.includes(key));
    const scenario: DegradationScenario = matchedKey ? routes[matchedKey] : "ok";

    switch (scenario) {
      case "ok":
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ result: "0x1" })
        });

      case "reset":
        return Promise.reject(new Error("ECONNRESET: socket hang up"));

      case "partial_receipt":
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32603, message: "node not caught up" }
          })
        });

      case "delayed":
        return new Promise<FetchResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({ ok: true, status: 200, json: async () => ({ result: "0x1" }) });
          }, delayMs);

          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
    }
  };
}
