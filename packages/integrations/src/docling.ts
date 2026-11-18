import { AppError } from "@arcatic/core";

/**
 * Docling Serve client. Contract verified against docling-main/docling/service_client/client.py:
 *  POST /v1/convert/file/async   multipart: files=<file>, to_formats=md, target_type=inbody, [do_ocr, ocr_lang]
 *  GET  /v1/status/poll/{task_id}?wait=N   → { task_id, task_status: pending|started|success|partial_success|failure|skipped, error_message }
 *  GET  /v1/result/{task_id}               → { document: { filename, md_content }, status, errors, processing_time }
 *  Optional X-Api-Key header.
 */
type TaskStatus = { task_id: string; task_status: string; error_message?: string | null };

export class DoclingClient {
  constructor(private readonly opts: { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch; pollWaitSeconds?: number; maxPolls?: number }) {}

  private async call(path: string, init: RequestInit = {}) {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { accept: "application/json", ...(this.opts.apiKey && { "X-Api-Key": this.opts.apiKey }), ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      throw new AppError(res.status === 429 ? "rate_limited" : "upstream_error", `docling ${path} → ${res.status}`, {
        retryable: res.status === 429 || res.status >= 500,
        details: { body: (await res.text().catch(() => "")).slice(0, 300) },
      });
    }
    return res.json();
  }

  async convertFile(bytes: Uint8Array, filename: string, opts: { ocrLang?: string[]; signal?: AbortSignal; onProgress?: (status: string) => void } = {}) {
    const form = new FormData();
    form.append("files", new Blob([bytes.slice()]), filename);
    form.append("to_formats", "md");
    form.append("target_type", "inbody");
    if (opts.ocrLang?.length) {
      form.append("do_ocr", "true");
      for (const l of opts.ocrLang) form.append("ocr_lang", l);
    }
    let status = (await this.call("/v1/convert/file/async", { method: "POST", body: form, signal: opts.signal })) as TaskStatus;
    const wait = this.opts.pollWaitSeconds ?? 10;
    for (let i = 0; i < (this.opts.maxPolls ?? 120) && !["success", "partial_success", "failure", "skipped"].includes(status.task_status); i++) {
      opts.onProgress?.(status.task_status);
      status = (await this.call(`/v1/status/poll/${encodeURIComponent(status.task_id)}?wait=${wait}`, { signal: opts.signal })) as TaskStatus;
    }
    if (status.task_status === "failure" || status.task_status === "skipped") {
      throw new AppError("validation_failed", `Could not read this document: ${status.error_message ?? status.task_status}`);
    }
    if (!["success", "partial_success"].includes(status.task_status)) throw new AppError("upstream_error", "Document conversion timed out.", { retryable: true });
    const result = (await this.call(`/v1/result/${encodeURIComponent(status.task_id)}`, { signal: opts.signal })) as {
      document?: { md_content?: string | null }; status: string; errors?: unknown[];
    };
    const markdown = result.document?.md_content ?? "";
    if (!markdown.trim()) throw new AppError("validation_failed", "The document has no readable text (is it a scanned image without OCR?).");
    return { markdown, partial: result.status === "partial_success", errors: result.errors ?? [] };
  }
}
