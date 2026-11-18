import { describe, expect, it, vi } from "vitest";
import { ComfyUiClient, img2imgGraph, txt2imgGraph } from "../src/comfyui.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const params = { checkpoint: "sd_xl_base_1.0.safetensors", positive: "idli", negative: "text", seed: 7, steps: 30, cfg: 6.5, sampler: "dpmpp_2m", scheduler: "karras", filenamePrefix: "arcatic/job1" };

describe("ComfyUI client", () => {
  it("submits with a client prompt_id and reports node errors as validation failures", async () => {
    const ok = vi.fn(async () => json({ prompt_id: "p1", number: 3, node_errors: {} }));
    const c = new ComfyUiClient({ baseUrl: "http://gpu:8188", sharedSecret: "s", fetchImpl: ok as never });
    expect(await c.submit(txt2imgGraph({ ...params, width: 1024, height: 1024, batch: 1 }), "p1")).toEqual({ prompt_id: "p1" });
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gpu:8188/api/prompt");
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt_id: "p1", client_id: "arcatic" });
    expect((init.headers as Record<string, string>)["x-arcatic-secret"]).toBe("s");
    const bad = new ComfyUiClient({ baseUrl: "http://gpu", fetchImpl: (async () => json({ error: { type: "prompt_outputs_failed_validation", message: "ckpt missing" }, node_errors: { "1": {} } }, 400)) as never });
    await expect(bad.submit({}, "p2")).rejects.toMatchObject({ code: "validation_failed", retryable: false });
  });
  it("reads job status and output images; unknown jobs are null", async () => {
    const f = vi.fn(async (url: string) => (url.endsWith("/missing") ? new Response("", { status: 404 }) : json({
      id: "p1", status: "completed", outputs: { "7": { images: [{ filename: "job1_00001_.png", subfolder: "arcatic", type: "output" }, { filename: "tmp.png", subfolder: "", type: "temp" }] } },
    })));
    const c = new ComfyUiClient({ baseUrl: "http://gpu", fetchImpl: f as never });
    const job = await c.job("p1");
    expect(ComfyUiClient.outputImages(job!)).toEqual([{ filename: "job1_00001_.png", subfolder: "arcatic", type: "output" }]);
    expect(await c.job("missing")).toBeNull();
  });
  it("fetches images via /api/view with filename, subfolder and type", async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    const r = await new ComfyUiClient({ baseUrl: "http://gpu", fetchImpl: f as never }).view({ filename: "a.png", subfolder: "arcatic", type: "output" });
    expect([...r.bytes]).toEqual([1, 2, 3]);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("http://gpu/api/view?filename=a.png&subfolder=arcatic&type=output");
  });
});

describe("workflow graphs", () => {
  it("wires core nodes with verified input names", () => {
    const g = txt2imgGraph({ ...params, width: 1024, height: 1024, batch: 2 });
    expect(g["5"].inputs).toMatchObject({ model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], sampler_name: "dpmpp_2m" });
    expect(g["4"].inputs).toEqual({ width: 1024, height: 1024, batch_size: 2 });
    const i = img2imgGraph({ ...params, inputImage: "product.png", denoise: 0.55 });
    expect(i["5"]).toEqual({ class_type: "VAEEncode", inputs: { pixels: ["4", 0], vae: ["1", 2] } });
    expect(i["6"].inputs.denoise).toBe(0.55);
  });
});
