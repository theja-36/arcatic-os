import { describe, expect, it, vi } from "vitest";
import { DoclingClient } from "../src/docling.js";
import { GoogleDriveClient } from "../src/drive.js";
import { TeiEmbedder, VoyageEmbedder, toPgVector } from "../src/embeddings.js";
import { audioSegmentArgs, parseProbe } from "../src/ffmpeg.js";
import { OpenAiCompatibleTranscriber } from "../src/transcriber.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const vec = (n = 1024) => Array.from({ length: n }, () => 0.01);

describe("embedders", () => {
  it("TEI posts normalised, truncated batches and checks dimensions", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => json(JSON.parse(String(init.body)).inputs.map(() => vec())));
    const e = new TeiEmbedder({ baseUrl: "http://tei:80", batchSize: 2, fetchImpl: f as never });
    const out = await e.embed(["a", "b", "c"], "document");
    expect(out).toHaveLength(3);
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(f.mock.calls[0]![1].body))).toEqual({ inputs: ["a", "b"], normalize: true, truncate: true });
    expect(e.model).toBe("bge-m3");
  });
  it("rejects a model with the wrong dimension", async () => {
    const e = new TeiEmbedder({ baseUrl: "http://tei", fetchImpl: (async () => json([vec(768)])) as never });
    await expect(e.embed(["a"], "query")).rejects.toMatchObject({ code: "upstream_error", retryable: false });
  });
  it("Voyage sends input_type and output_dimension and restores order", async () => {
    const f = vi.fn(async () => json({ data: [{ index: 1, embedding: vec().map(() => 2) }, { index: 0, embedding: vec() }] }));
    const out = await new VoyageEmbedder({ apiKey: "k", fetchImpl: f as never }).embed(["q1", "q2"], "query");
    expect(out[0]![0]).toBe(0.01);
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ input_type: "query", output_dimension: 1024, model: "voyage-3.5" });
  });
  it("formats pgvector literals", () => expect(toPgVector([0.12345678, NaN, 1])).toBe("[0.1234568,0,1]"));
});

describe("DoclingClient", () => {
  it("submits multipart, polls until success, returns markdown", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.endsWith("/v1/convert/file/async")) {
        const form = init.body as FormData;
        expect(form.get("to_formats")).toBe("md");
        expect(form.get("target_type")).toBe("inbody");
        expect((form.get("files") as File).name).toBe("menu.pdf");
        return json({ task_id: "t1", task_status: "pending" });
      }
      if (url.includes("/v1/status/poll/t1")) return json({ task_id: "t1", task_status: calls.length > 2 ? "success" : "started" });
      return json({ document: { filename: "menu.pdf", md_content: "# Menu\n\nIdli ₹40" }, status: "success", errors: [], processing_time: 1.2 });
    });
    const r = await new DoclingClient({ baseUrl: "http://docling:5001", apiKey: "k", fetchImpl: f as never }).convertFile(new Uint8Array([37, 80, 68, 70]), "menu.pdf");
    expect(r.markdown).toBe("# Menu\n\nIdli ₹40");
    expect(calls).toEqual(["POST /v1/convert/file/async", "GET /v1/status/poll/t1", "GET /v1/status/poll/t1", "GET /v1/result/t1"]);
    expect((f.mock.calls[0]![1].headers as Record<string, string>)["X-Api-Key"]).toBe("k");
  });
  it("reports failed conversions as non-retryable", async () => {
    const f = async (url: string) => (url.endsWith("async") ? json({ task_id: "t", task_status: "failure", error_message: "encrypted PDF" }) : json({}));
    await expect(new DoclingClient({ baseUrl: "http://d", fetchImpl: f as never }).convertFile(new Uint8Array([1]), "x.pdf")).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("transcriber", () => {
  it("requests verbose_json and converts seconds to ms", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get("response_format")).toBe("verbose_json");
      expect(form.get("language")).toBe("te");
      return json({ text: "నమస్కారం", language: "te", segments: [{ start: 0, end: 1.5, text: " నమస్కారం " }] });
    });
    const r = await new OpenAiCompatibleTranscriber({ baseUrl: "http://whisper:8000", fetchImpl: f as never }).transcribeFile(new Uint8Array([1]), "a.ogg", { language: "te" });
    expect(r.segments).toEqual([{ startMs: 0, endMs: 1500, text: "నమస్కారం" }]);
  });
});

describe("GoogleDriveClient", () => {
  it("exports Google Docs as text and enforces the size cap while streaming", async () => {
    const f = vi.fn(async (url: string) => {
      expect(url).toContain("/export?mimeType=text%2Fplain");
      return new Response("x".repeat(2000));
    });
    const d = new GoogleDriveClient("tok", { fetchImpl: f as never, maxBytes: 1000 });
    await expect(d.download({ id: "abc", name: "Notes", mimeType: "application/vnd.google-apps.document" })).rejects.toMatchObject({ code: "validation_failed" });
    const ok = new GoogleDriveClient("tok", { fetchImpl: (async () => new Response("hello")) as never });
    expect(await ok.download({ id: "abc", name: "Notes", mimeType: "application/vnd.google-apps.document" })).toMatchObject({ filename: "Notes.txt" });
  });
  it("maps expired tokens to a re-pick message", async () => {
    const d = new GoogleDriveClient("tok", { fetchImpl: (async () => new Response("", { status: 401 })) as never });
    await expect(d.metadata("abc")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("ffmpeg helpers", () => {
  it("builds mono 16 kHz Opus segment args with an optional duration cap", () => {
    const a = audioSegmentArgs("/tmp/in.mp4", "/tmp/out/%03d.ogg", { maxSeconds: 3600 });
    expect(a.slice(a.indexOf("-t"), a.indexOf("-t") + 2)).toEqual(["-t", "3600"]);
    expect(a).toEqual(expect.arrayContaining(["-ac", "1", "-ar", "16000", "-c:a", "libopus", "-f", "segment", "-segment_time", "600"]));
    expect(a.at(-1)).toBe("/tmp/out/%03d.ogg");
  });
  it("parses ffprobe output", () => {
    expect(parseProbe(JSON.stringify({ format: { duration: "125.48", format_name: "mov,mp4" }, streams: [{ codec_type: "video" }, { codec_type: "audio" }] })))
      .toEqual({ durationMs: 125480, hasAudio: true, hasVideo: true, formatName: "mov,mp4" });
    expect(() => parseProbe("{}")).toThrow();
  });
});
