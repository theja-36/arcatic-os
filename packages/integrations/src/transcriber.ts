import { AppError } from "@arcatic/core";
import type { Transcriber } from "./unverified.js";

/**
 * Whisper via an OpenAI-compatible server (e.g. faster-whisper based "speaches", or whisper.cpp
 * server): POST /v1/audio/transcriptions multipart file, model, [language],
 * response_format=verbose_json → { text, language, segments: [{ start, end, text }] } (seconds).
 * Not in the project folder — verify against the chosen server image (docs/11).
 */
export class OpenAiCompatibleTranscriber implements Transcriber {
  constructor(private readonly opts: { baseUrl: string; model?: string; apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {}

  async transcribeFile(bytes: Uint8Array, filename: string, opts: { language?: string; signal?: AbortSignal } = {}) {
    const form = new FormData();
    form.append("file", new Blob([bytes.slice()]), filename);
    form.append("model", this.opts.model ?? "Systran/faster-whisper-large-v3");
    form.append("response_format", "verbose_json");
    if (opts.language && opts.language !== "auto") form.append("language", opts.language);
    const f = this.opts.fetchImpl ?? fetch;
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(this.opts.timeoutMs ?? 900_000)]) : AbortSignal.timeout(this.opts.timeoutMs ?? 900_000);
    const res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
      method: "POST", body: form, signal, headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
    });
    if (!res.ok) throw new AppError("upstream_error", `transcriber → ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
    const body = (await res.json()) as { text: string; language?: string; segments?: Array<{ start: number; end: number; text: string }> };
    return {
      text: body.text ?? "",
      language: body.language ?? opts.language ?? "unknown",
      segments: (body.segments ?? []).map((s) => ({ startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), text: s.text.trim() })).filter((s) => s.text),
    };
  }
}
