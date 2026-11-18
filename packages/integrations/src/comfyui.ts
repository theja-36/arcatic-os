import { AppError } from "@arcatic/core";
import { HttpClient, type HttpOptions } from "./http.js";

/**
 * ComfyUI client. Verified against ComfyUI-master source:
 *  server.py: POST /prompt → { prompt_id, number, node_errors } (400: { error, node_errors }); routes are also served under /api.
 *  server.py: GET /api/jobs/{id}, POST /api/jobs/{id}/cancel; comfy_execution/jobs.py: status ∈ pending|in_progress|completed|failed|cancelled,
 *             outputs: { [nodeId]: { images: [{ filename, subfolder, type }] } }, execution_error.
 *  server.py: GET /view?filename&subfolder&type → file bytes; POST /upload/image (multipart "image", "type", "overwrite") → { name, subfolder, type }.
 * ComfyUI has no multi-tenant auth: run it on a private network behind a shared-secret proxy.
 */
export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}
export interface ComfyJob {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  execution_error?: { exception_message?: string; node_type?: string } | null;
  outputs?: Record<string, { images?: ComfyImageRef[] } & Record<string, unknown>>;
}

export class ComfyUiClient {
  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; sharedSecret?: string } & Partial<Pick<HttpOptions, "fetchImpl" | "timeoutMs">>) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.headers = opts.sharedSecret ? { "x-arcatic-secret": opts.sharedSecret } : {};
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.http = new HttpClient({ baseUrl: this.baseUrl, headers: this.headers, service: "comfyui", fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  }

  /** `promptId` makes the submission idempotent across retries (ComfyUI accepts a client UUID). */
  async submit(graph: Record<string, unknown>, promptId: string, clientId = "arcatic"): Promise<{ prompt_id: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/prompt`, {
      method: "POST", headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: promptId }),
    });
    const body = (await res.json().catch(() => ({}))) as { prompt_id?: string; error?: { message?: string; type?: string }; node_errors?: unknown };
    if (!res.ok) {
      throw new AppError(res.status >= 500 ? "upstream_error" : "validation_failed", `ComfyUI rejected the workflow: ${body.error?.message ?? res.status}`, {
        retryable: res.status >= 500, details: { node_errors: body.node_errors, type: body.error?.type },
      });
    }
    return { prompt_id: body.prompt_id ?? promptId };
  }

  /** null when ComfyUI doesn't know the job (never submitted, or history pruned). */
  async job(promptId: string): Promise<ComfyJob | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/jobs/${encodeURIComponent(promptId)}`, { headers: this.headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError("upstream_error", `ComfyUI job lookup → ${res.status}`, { retryable: true });
    return (await res.json()) as ComfyJob;
  }

  cancel(promptId: string) {
    return this.http.request<unknown>("POST", `/api/jobs/${encodeURIComponent(promptId)}/cancel`, {}, { idempotent: true });
  }

  async view(ref: ComfyImageRef): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
    const res = await this.fetchImpl(`${this.baseUrl}/api/view?${q}`, { headers: this.headers });
    if (!res.ok) throw new AppError("upstream_error", `ComfyUI view → ${res.status}`, { retryable: true });
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
  }

  async uploadImage(bytes: Uint8Array, filename: string): Promise<{ name: string; subfolder: string; type: string }> {
    const form = new FormData();
    form.append("image", new Blob([bytes.slice()]), filename);
    form.append("type", "input");
    form.append("overwrite", "true");
    const res = await this.fetchImpl(`${this.baseUrl}/api/upload/image`, { method: "POST", body: form, headers: this.headers });
    if (!res.ok) throw new AppError("upstream_error", `ComfyUI upload → ${res.status}`, { retryable: res.status >= 500 });
    return (await res.json()) as { name: string; subfolder: string; type: string };
  }

  /** Every image produced by SaveImage nodes. */
  static outputImages(job: ComfyJob): ComfyImageRef[] {
    return Object.values(job.outputs ?? {}).flatMap((o) => (Array.isArray(o.images) ? o.images : [])).filter((i) => i.type === "output");
  }
}

// ---------------------------------------------------------------- workflow graphs (API format)
export interface SamplerParams {
  checkpoint: string;
  positive: string;
  negative: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  filenamePrefix: string;
}

/** Text → image with core nodes only (CheckpointLoaderSimple, CLIPTextEncode, EmptyLatentImage, KSampler, VAEDecode, SaveImage). */
export function txt2imgGraph(p: SamplerParams & { width: number; height: number; batch: number }) {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: p.positive, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: p.negative, clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: p.batch } },
    "5": { class_type: "KSampler", inputs: { model: ["1", 0], seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], denoise: 1 } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: p.filenamePrefix } },
  };
}

/** Image → image (product photo restyle): LoadImage → VAEEncode → KSampler(denoise) → VAEDecode → SaveImage. */
export function img2imgGraph(p: SamplerParams & { inputImage: string; denoise: number }) {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: p.positive, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: p.negative, clip: ["1", 1] } },
    "4": { class_type: "LoadImage", inputs: { image: p.inputImage } },
    "5": { class_type: "VAEEncode", inputs: { pixels: ["4", 0], vae: ["1", 2] } },
    "6": { class_type: "KSampler", inputs: { model: ["1", 0], seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, positive: ["2", 0], negative: ["3", 0], latent_image: ["5", 0], denoise: p.denoise } },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: p.filenamePrefix } },
  };
}
