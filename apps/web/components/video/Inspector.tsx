"use client";
import {
  moveClip, removeAudio, removeClip, removeOverlay, setClipAudio, trimClip, updateAudio, updateOverlay,
  type Timeline,
} from "@arcatic/core";
import { Button, Input } from "@arcatic/ui";
import type { Selection } from "./TimelineStrip";

type Apply = (fn: (t: Timeline) => Timeline) => void;

const sec = (ms: number) => Math.round(ms / 100) / 10;
function Num({ label, value, onChange, min = 0, max, step = 0.1, suffix = "s" }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[var(--text-muted)]">{label}{suffix ? ` (${suffix})` : ""}</span>
      <Input type="number" className="h-8" value={value} min={min} max={max} step={step} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(v); }} />
    </label>
  );
}
const Row = ({ children }: { children: React.ReactNode }) => <div className="grid grid-cols-2 gap-2">{children}</div>;
const Color = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
  <label className="flex items-center justify-between gap-2 text-xs"><span className="text-[var(--text-muted)]">{label}</span><input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-8 w-12 rounded border border-[var(--border)]" /></label>
);

export function Inspector({ t, selection, apply, onSelect, onPickImage }: { t: Timeline; selection: Selection; apply: Apply; onSelect: (s: Selection) => void; onPickImage: (overlayId: string) => void }) {
  if (!selection) return <p className="text-sm text-[var(--text-muted)]">Select a clip, overlay or audio track on the timeline to edit it. Drag overlays on the preview to move them.</p>;

  if (selection.type === "clip") {
    const i = t.clips.findIndex((c) => c.id === selection.id);
    const c = t.clips[i];
    if (!c) return null;
    return (
      <div className="flex flex-col gap-3">
        <h3 className="font-semibold">Clip {i + 1} · {c.kind === "video" ? "video" : "image"}</h3>
        {c.kind === "video" ? (
          <>
            <Row>
              <Num label="Start in source" value={sec(c.inMs)} max={sec(c.outMs) - 0.2} onChange={(v) => apply((t) => trimClip(t, c.id, v * 1000, c.outMs))} />
              <Num label="End in source" value={sec(c.outMs)} max={c.sourceDurationMs ? sec(c.sourceDurationMs) : undefined} onChange={(v) => apply((t) => trimClip(t, c.id, c.inMs, v * 1000))} />
            </Row>
            <p className="text-xs text-[var(--text-muted)]">Source is {sec(c.sourceDurationMs ?? 0)}s; using {sec(c.outMs - c.inMs)}s.</p>
          </>
        ) : (
          <Num label="Show for" value={sec(c.outMs - c.inMs)} min={0.2} max={60} onChange={(v) => apply((t) => trimClip(t, c.id, 0, v * 1000))} />
        )}
        <label className="flex items-center justify-between text-xs"><span className="text-[var(--text-muted)]">Framing</span>
          <select className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-1" value={c.fit} onChange={(e) => apply((t) => ({ ...t, clips: t.clips.map((x) => (x.id === c.id ? { ...x, fit: e.target.value as "cover" | "contain" } : x)) }))}>
            <option value="cover">Fill frame (crop)</option><option value="contain">Fit whole (bars)</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={c.fadeIn} onChange={(e) => apply((t) => ({ ...t, clips: t.clips.map((x) => (x.id === c.id ? { ...x, fadeIn: e.target.checked } : x)) }))} /> Fade in</label>
        {c.kind === "video" && (c.hasAudio ? (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={c.muted} onChange={(e) => apply((t) => setClipAudio(t, c.id, { muted: e.target.checked }))} /> Mute this clip&apos;s sound</label>
            <label className="flex flex-col gap-1 text-xs"><span className="text-[var(--text-muted)]">Clip volume {Math.round(c.volume * 100)}%</span>
              <input type="range" min={0} max={2} step={0.05} value={c.volume} disabled={c.muted} onChange={(e) => apply((t) => setClipAudio(t, c.id, { volume: Number(e.target.value) }))} /></label>
          </div>
        ) : <p className="text-xs text-[var(--text-muted)]">This clip has no sound.</p>)}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="h-8 px-2 text-xs" disabled={i === 0} onClick={() => apply((t) => moveClip(t, c.id, i - 1))}>← Earlier</Button>
          <Button variant="secondary" className="h-8 px-2 text-xs" disabled={i === t.clips.length - 1} onClick={() => apply((t) => moveClip(t, c.id, i + 1))}>Later →</Button>
          <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => { apply((t) => removeClip(t, c.id)); onSelect(undefined); }}>Remove</Button>
        </div>
      </div>
    );
  }

  if (selection.type === "overlay") {
    const o = t.overlays.find((x) => x.id === selection.id);
    if (!o) return null;
    const set = (patch: Parameters<typeof updateOverlay>[2]) => apply((t) => updateOverlay(t, o.id, patch));
    const pct = (v: number) => Math.round(v * 1000) / 10;
    return (
      <div className="flex flex-col gap-3">
        <h3 className="font-semibold capitalize">{o.kind === "rect" ? "Shape" : o.kind} overlay</h3>
        {o.kind === "text" && (
          <>
            <label className="flex flex-col gap-1 text-xs"><span className="text-[var(--text-muted)]">Text (any language)</span>
              <textarea className="min-h-16 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" maxLength={500} value={o.text ?? ""} onChange={(e) => set({ text: e.target.value })} /></label>
            <Row>
              <Num label="Size" suffix="px" step={2} min={8} max={400} value={o.fontSize ?? 64} onChange={(v) => set({ fontSize: v })} />
              <label className="flex flex-col gap-1 text-xs"><span className="text-[var(--text-muted)]">Weight</span>
                <select className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-1" value={o.fontWeight ?? "700"} onChange={(e) => set({ fontWeight: e.target.value as "400" })}>
                  <option value="400">Regular</option><option value="600">Semibold</option><option value="700">Bold</option><option value="800">Extra bold</option>
                </select></label>
            </Row>
            <Row>
              <label className="flex flex-col gap-1 text-xs"><span className="text-[var(--text-muted)]">Font</span><Input className="h-8" value={o.fontFamily ?? ""} placeholder="Brand font" onChange={(e) => set({ fontFamily: e.target.value || undefined })} /></label>
              <label className="flex flex-col gap-1 text-xs"><span className="text-[var(--text-muted)]">Align</span>
                <select className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-1" value={o.align ?? "center"} onChange={(e) => set({ align: e.target.value as "center" })}>
                  <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                </select></label>
            </Row>
            <Color label="Text colour" value={o.color ?? "#FFFFFF"} onChange={(v) => set({ color: v })} />
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!o.fill} onChange={(e) => set({ fill: e.target.checked ? "#000000" : undefined })} /> Background box</label>
            {o.fill && <Color label="Box colour" value={o.fill} onChange={(v) => set({ fill: v })} />}
          </>
        )}
        {o.kind === "rect" && <Color label="Fill" value={o.fill ?? "#000000"} onChange={(v) => set({ fill: v })} />}
        {(o.kind === "image" || o.kind === "logo") && <Button variant="secondary" className="h-8 text-xs" onClick={() => onPickImage(o.id)}>{o.assetId ? "Change image" : "Choose image"}</Button>}
        <Row>
          <Num label="Appears at" value={sec(o.startMs)} onChange={(v) => set({ startMs: Math.round(v * 1000) })} />
          <Num label="Disappears at" value={sec(o.endMs)} onChange={(v) => set({ endMs: Math.round(v * 1000) })} />
        </Row>
        <Row>
          <Num label="Left" suffix="%" step={1} max={100} value={pct(o.x)} onChange={(v) => set({ x: Math.min(1 - o.w, v / 100) })} />
          <Num label="Top" suffix="%" step={1} max={100} value={pct(o.y)} onChange={(v) => set({ y: Math.min(1 - o.h, v / 100) })} />
          <Num label="Width" suffix="%" step={1} min={1} max={100} value={pct(o.w)} onChange={(v) => set({ w: Math.min(1 - o.x, Math.max(0.01, v / 100)) })} />
          <Num label="Height" suffix="%" step={1} min={1} max={100} value={pct(o.h)} onChange={(v) => set({ h: Math.min(1 - o.y, Math.max(0.01, v / 100)) })} />
        </Row>
        <label className="flex flex-col gap-1 text-xs"><span className="text-[var(--text-muted)]">Opacity {Math.round(o.opacity * 100)}%</span>
          <input type="range" min={0.05} max={1} step={0.05} value={o.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} /></label>
        <Button variant="ghost" className="h-8 text-xs" onClick={() => { apply((t) => removeOverlay(t, o.id)); onSelect(undefined); }}>Remove overlay</Button>
      </div>
    );
  }

  const a = t.audio.find((x) => x.id === selection.id);
  if (!a) return null;
  const set = (patch: Parameters<typeof updateAudio>[2]) => apply((t) => updateAudio(t, a.id, patch));
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-semibold">Audio track</h3>
      <Num label="Starts on the video at" value={sec(a.startMs)} onChange={(v) => set({ startMs: Math.round(v * 1000) })} />
      <Row>
        <Num label="Use from" value={sec(a.inMs)} max={sec(a.outMs) - 0.2} onChange={(v) => set({ inMs: Math.round(v * 1000) })} />
        <Num label="Use until" value={sec(a.outMs)} max={sec(a.sourceDurationMs)} onChange={(v) => set({ outMs: Math.round(v * 1000) })} />
      </Row>
      <Row>
        <Num label="Fade in" value={sec(a.fadeInMs)} max={10} onChange={(v) => set({ fadeInMs: Math.round(v * 1000) })} />
        <Num label="Fade out" value={sec(a.fadeOutMs)} max={10} onChange={(v) => set({ fadeOutMs: Math.round(v * 1000) })} />
      </Row>
      <label className="flex flex-col gap-1 text-xs"><span className="text-[var(--text-muted)]">Volume {Math.round(a.volume * 100)}%</span>
        <input type="range" min={0} max={2} step={0.05} value={a.volume} onChange={(e) => set({ volume: Number(e.target.value) })} /></label>
      <p className="text-xs text-[var(--text-muted)]">Audio past the end of the video is cut off.</p>
      <Button variant="ghost" className="h-8 text-xs" onClick={() => { apply((t) => removeAudio(t, a.id)); onSelect(undefined); }}>Remove audio</Button>
    </div>
  );
}
