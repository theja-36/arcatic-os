import { AppError } from "@arcatic/core";
import { HttpClient } from "./http.js";

/**
 * Embedding providers. The DB column is vector(1024), so every provider must return 1024 dims.
 *  - TEI (Hugging Face text-embeddings-inference, Apache-2.0) serving BAAI/bge-m3 (MIT, multilingual incl. Telugu) — default, self-hosted.
 *  - Voyage (hosted) — voyage-3.5 with output_dimension 1024.
 * Neither service is in the project folder; contracts follow their public HTTP APIs and are
 * covered by fixture tests. Verify against a running instance before production (docs/11).
 */
export const EMBEDDING_DIMS = 1024;
export type EmbedKind = "document" | "query";

export interface Embedder {
  readonly model: string;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<number[][]>;
}

function checkDims(vectors: number[][], expected: number, model: string) {
  for (const v of vectors) {
    if (v.length !== expected) throw new AppError("upstream_error", `${model} returned ${v.length} dims; expected ${expected}.`, { retryable: false });
  }
  return vectors;
}

async function inBatches(texts: string[], size: number, fn: (batch: string[]) => Promise<number[][]>) {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) out.push(...(await fn(texts.slice(i, i + size))));
  return out;
}

export class TeiEmbedder implements Embedder {
  private readonly http: HttpClient;
  constructor(private readonly opts: { baseUrl: string; model?: string; apiKey?: string; batchSize?: number; fetchImpl?: typeof fetch }) {
    this.http = new HttpClient({ baseUrl: opts.baseUrl, service: "embeddings", headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}, fetchImpl: opts.fetchImpl, timeoutMs: 60_000 });
  }
  get model() {
    return this.opts.model ?? "bge-m3";
  }
  embed(texts: string[], _kind: EmbedKind, signal?: AbortSignal) {
    // bge-m3 dense retrieval uses no query/document instruction prefix
    return inBatches(texts, this.opts.batchSize ?? 32, async (inputs) =>
      checkDims(await this.http.request<number[][]>("POST", "/embed", { inputs, normalize: true, truncate: true }, { idempotent: true, signal }), EMBEDDING_DIMS, this.model));
  }
}

export class VoyageEmbedder implements Embedder {
  private readonly http: HttpClient;
  constructor(private readonly opts: { apiKey: string; model?: string; baseUrl?: string; batchSize?: number; fetchImpl?: typeof fetch }) {
    this.http = new HttpClient({ baseUrl: opts.baseUrl ?? "https://api.voyageai.com/v1", service: "voyage", headers: { authorization: `Bearer ${opts.apiKey}` }, fetchImpl: opts.fetchImpl, timeoutMs: 60_000 });
  }
  get model() {
    return this.opts.model ?? "voyage-3.5";
  }
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal) {
    return inBatches(texts, this.opts.batchSize ?? 64, async (input) => {
      const r = await this.http.request<{ data: Array<{ embedding: number[]; index: number }> }>(
        "POST", "/embeddings", { input, model: this.model, input_type: kind, output_dimension: EMBEDDING_DIMS }, { idempotent: true, signal },
      );
      return checkDims([...r.data].sort((a, b) => a.index - b.index).map((d) => d.embedding), EMBEDDING_DIMS, this.model);
    });
  }
}

export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const provider = env.EMBEDDINGS_PROVIDER ?? (env.EMBEDDINGS_URL ? "tei" : env.VOYAGE_API_KEY ? "voyage" : "none");
  if (provider === "tei" && env.EMBEDDINGS_URL) return new TeiEmbedder({ baseUrl: env.EMBEDDINGS_URL, model: env.EMBEDDINGS_MODEL, apiKey: env.EMBEDDINGS_API_KEY });
  if (provider === "voyage" && env.VOYAGE_API_KEY) return new VoyageEmbedder({ apiKey: env.VOYAGE_API_KEY, model: env.EMBEDDINGS_MODEL });
  return null;   // search runs full-text only
}

/** pgvector text literal for PostgREST inserts and RPC args. */
export const toPgVector = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(7)) : 0)).join(",")}]`;
