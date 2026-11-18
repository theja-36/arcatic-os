import { HttpClient, type HttpOptions } from "./http.js";

/** Langflow: `POST /api/v1/run/{flow_id_or_name}` (langflow-main/src/backend/base/langflow/api/v1/endpoints.py). */
export class LangflowClient {
  private readonly http: HttpClient;

  constructor(opts: { baseUrl: string; apiKey: string } & Partial<Pick<HttpOptions, "fetchImpl" | "timeoutMs">>) {
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      headers: { "x-api-key": opts.apiKey },
      service: "langflow",
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  run(flow: string, input: { input_value: string; tweaks?: Record<string, unknown>; session_id?: string }) {
    return this.http.request<{ outputs: unknown[]; session_id?: string }>(
      "POST",
      `/api/v1/run/${encodeURIComponent(flow)}?stream=false`,
      { input_type: "text", output_type: "text", ...input },
      { idempotent: true },
    );
  }
}
