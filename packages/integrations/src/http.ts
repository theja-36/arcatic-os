import { AppError } from "@arcatic/core";

export interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  service: string;
}

/**
 * Minimal JSON HTTP client for internal services. Retries idempotent requests on
 * network errors / 5xx / 429 with exponential backoff (Temporal adds its own retries on top).
 */
export class HttpClient {
  constructor(private readonly opts: HttpOptions) {}

  async request<T>(method: string, path: string, body?: unknown, init: { idempotent?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const { baseUrl, headers = {}, timeoutMs = 30_000, retries = 2, fetchImpl = fetch, service } = this.opts;
    const idempotent = init.idempotent ?? (method === "GET" || method === "DELETE" || method === "PUT");
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= (idempotent ? retries : 0); attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
      const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (err) {
        lastErr = err;
        if (init.signal?.aborted) throw new AppError("upstream_error", `${service}: cancelled`, { retryable: false, cause: err });
        continue;
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const detail = await res.text().catch(() => "");
      lastErr = new AppError(res.status === 429 ? "rate_limited" : "upstream_error", `${service} ${method} ${path} → ${res.status}`, {
        retryable: res.status === 429 || res.status >= 500,
        details: { status: res.status, body: detail.slice(0, 500) },
      });
      if (!(res.status === 429 || res.status >= 500)) throw lastErr;
    }
    if (lastErr instanceof AppError) throw lastErr;
    throw new AppError("upstream_error", `${service} unreachable`, { cause: lastErr });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
