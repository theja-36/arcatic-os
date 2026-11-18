"use client";
import { overlayRenderKey, type Overlay, type Timeline } from "@arcatic/core";
import { uploadFile } from "@/lib/upload";

/** CSS font stack used both on the editor stage and when drawing the PNG, so they match. */
export const fontStack = (family?: string) => `${family ? `"${family}", ` : ""}"Noto Sans Telugu", "Noto Sans", system-ui, sans-serif`;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth || !line) line = next;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Draw a text overlay at export size with the browser's text shaper (correct for Telugu and
 * other complex scripts), so the server composites a PNG instead of FFmpeg drawtext.
 */
export async function drawTextOverlay(o: Overlay, t: Pick<Timeline, "width" | "height">): Promise<Blob> {
  const W = Math.max(2, Math.round(o.w * t.width));
  const H = Math.max(2, Math.round(o.h * t.height));
  const size = o.fontSize ?? 64;
  const font = `${o.fontWeight ?? "700"} ${size}px ${fontStack(o.fontFamily)}`;
  await document.fonts?.load(font, o.text ?? "").catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  if (o.fill) {
    ctx.fillStyle = o.fill;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.font = font;
  ctx.fillStyle = o.color ?? "#FFFFFF";
  ctx.textBaseline = "middle";
  const pad = Math.round(size * 0.3);
  const align = o.align ?? "center";
  ctx.textAlign = align;
  const lines = wrap(ctx, o.text ?? "", W - pad * 2);
  const lh = size * 1.25;
  const top = H / 2 - ((lines.length - 1) * lh) / 2;
  const x = align === "left" ? pad : align === "right" ? W - pad : W / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, top + i * lh));
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not draw text"))), "image/png"));
}

/** Render + upload every text overlay whose PNG is missing or stale. Returns the updated timeline. */
export async function renderStaleText(workspaceId: string, brandId: string, t: Timeline): Promise<Timeline> {
  const overlays = await Promise.all(t.overlays.map(async (o) => {
    if (o.kind !== "text" || !o.text?.trim()) return o;
    const key = overlayRenderKey(o, t);
    if (o.renderedAssetId && o.renderedKey === key) return o;
    const blob = await drawTextOverlay(o, t);
    const asset = await uploadFile(workspaceId, new File([blob], `video-text-${o.id}.png`, { type: "image/png" }), brandId);
    return { ...o, renderedAssetId: asset.id, renderedKey: key };
  }));
  return { ...t, overlays };
}
