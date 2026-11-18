"use client";
import { useEffect, useRef, useState } from "react";
import type { Scene } from "@arcatic/core";
import { Button } from "@arcatic/ui";
import { api } from "@/lib/api";
import { uploadFile } from "@/lib/upload";

/**
 * Fabric.js canvas for a scene. Text is editable in place; boxes can be moved and resized.
 * Changes flow back into the scene (fractions of the canvas) so validation and re-layout keep working.
 */
export function VisualEditor({ scene, workspaceId, brandId, readOnly, onChange, onExported }: {
  scene: Scene; workspaceId: string; brandId: string; readOnly: boolean; onChange: (s: Scene) => void; onExported: (assetId: string) => void;
}) {
  const el = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<import("fabric").Canvas | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const displayW = Math.min(520, typeof window === "undefined" ? 520 : window.innerWidth - 48);
  const scale = displayW / scene.width;

  useEffect(() => {
    let disposed = false;
    (async () => {
      const fabric = await import("fabric");
      if (disposed || !el.current) return;
      canvasRef.current?.dispose();
      const s = sceneRef.current;
      const c = new fabric.Canvas(el.current, { width: s.width * scale, height: s.height * scale, selection: !readOnly, backgroundColor: s.background.transparent ? undefined : s.background.color });
      canvasRef.current = c;
      c.setZoom(scale);
      const url = async (assetId: string) => (await api<{ url: string }>(`/workspaces/${workspaceId}/media/${assetId}/url`)).url;

      if (s.background.imageAssetId) {
        try {
          const img = await fabric.FabricImage.fromURL(await url(s.background.imageAssetId), { crossOrigin: "anonymous" });
          const k = Math.max(s.width / img.width!, s.height / img.height!);
          img.set({ left: (s.width - img.width! * k) / 2, top: (s.height - img.height! * k) / 2, scaleX: k, scaleY: k, selectable: false, evented: false });
          c.add(img);
        } catch { /* missing image is reported by validation */ }
        if (s.background.overlay) c.add(new fabric.Rect({ left: 0, top: 0, width: s.width, height: s.height, fill: s.background.overlay.color, opacity: s.background.overlay.opacity, selectable: false, evented: false }));
      }
      for (const l of s.layers) {
        const box = { left: l.x * s.width, top: l.y * s.height, width: l.w * s.width, height: l.h * s.height };
        if (l.type === "rect") c.add(new fabric.Rect({ ...box, fill: l.fill, opacity: l.opacity, selectable: false }));
        if (l.type === "image" && l.assetId) {
          try {
            const img = await fabric.FabricImage.fromURL(await url(l.assetId), { crossOrigin: "anonymous" });
            const k = Math.max(box.width / img.width!, box.height / img.height!);
            img.set({ left: box.left, top: box.top, scaleX: k, scaleY: k, selectable: false, clipPath: new fabric.Rect({ left: box.left, top: box.top, width: box.width, height: box.height, absolutePositioned: true }) });
            c.add(img);
          } catch { /* reported by validation */ }
        }
        if (l.type === "logo" && (l.assetId || l.url)) {
          try {
            const img = await fabric.FabricImage.fromURL(l.assetId ? await url(l.assetId) : l.url!, { crossOrigin: "anonymous" });
            const k = Math.min(box.width / img.width!, box.height / img.height!);
            img.set({ left: box.left, top: box.top, scaleX: k, scaleY: k, selectable: !readOnly });
            c.add(img);
          } catch { /* skip */ }
        }
        if (l.type === "text") {
          if (l.fill) c.add(new fabric.Rect({ ...box, fill: l.fill, rx: (l.radius ?? 0) * box.height / 2, ry: (l.radius ?? 0) * box.height / 2, selectable: false, evented: false }));
          const t = new fabric.Textbox(l.text, {
            left: box.left + (l.fill ? box.height * 0.3 : 0), top: box.top + (l.fill ? (box.height - l.fontSize * 1.15) / 2 : 0), width: box.width - (l.fill ? box.height * 0.6 : 0),
            fontSize: l.fontSize, fontFamily: l.fontFamily, fontWeight: l.fontWeight, fill: l.color, textAlign: l.align, lineHeight: 1.15, editable: !readOnly, selectable: !readOnly,
          });
          (t as unknown as { layerId: string }).layerId = l.id;
          c.add(t);
        }
      }
      c.on("object:modified", (e) => {
        const o = e.target as unknown as { layerId?: string; left: number; top: number; width: number; scaleX: number; text?: string; getScaledHeight: () => number } | undefined;
        if (!o?.layerId) return;
        const cur = sceneRef.current;
        onChange({ ...cur, exportAssetId: null, layers: cur.layers.map((l) => (l.id === o.layerId && l.type === "text" ? { ...l, x: Math.max(0, o.left / cur.width), y: Math.max(0, o.top / cur.height), w: Math.min(1, (o.width * o.scaleX) / cur.width), text: o.text ?? l.text } : l)) });
      });
      c.on("text:changed", (e) => {
        const o = e.target as unknown as { layerId?: string; text: string };
        const cur = sceneRef.current;
        if (o.layerId) onChange({ ...cur, exportAssetId: null, layers: cur.layers.map((l) => (l.id === o.layerId && l.type === "text" ? { ...l, text: o.text } : l)) });
      });
      c.requestRenderAll();
    })();
    return () => {
      disposed = true;
    };
    // re-render when the layout (not just text) changes
  }, [scene.template, scene.preset, scene.background.imageAssetId, workspaceId, readOnly, scale]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => void canvasRef.current?.dispose(), []);

  async function exportPng() {
    const c = canvasRef.current;
    if (!c) return;
    setBusy(true);
    setErr("");
    try {
      c.discardActiveObject();
      const blob = await c.toBlob({ format: "png", multiplier: 1 / scale, enableRetinaScaling: false });
      if (!blob) throw new Error("Could not render the image.");
      const asset = await uploadFile(workspaceId, new File([blob], `${scene.preset}.png`, { type: "image/png" }), brandId);
      onExported(asset.id);
    } catch (e) {
      setErr((e as Error).message.includes("tainted") ? "An image couldn't be loaded for export (storage CORS). Check the media bucket's CORS settings." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-md border border-[var(--border)]" style={{ width: scene.width * scale, background: "repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 50% / 16px 16px" }}>
        <canvas ref={el} />
      </div>
      <p className="text-xs text-[var(--text-muted)]">{scene.width}×{scene.height}px · double-click text to edit · drag to move</p>
      {!readOnly && <div><Button variant="secondary" onClick={exportPng} disabled={busy}>{busy ? "Exporting…" : scene.exportAssetId ? "Export again" : "Export PNG to media"}</Button></div>}
      {err && <p className="text-xs text-[var(--danger)]">{err}</p>}
    </div>
  );
}
