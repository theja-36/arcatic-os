"use client";
import { useRef, useState } from "react";
import { clipDuration, clipStarts, timelineDuration, type Timeline } from "@arcatic/core";
import { Button, cn } from "@arcatic/ui";

export type Selection = { type: "clip" | "overlay" | "audio"; id: string } | undefined;

const OVERLAY_LABEL = { text: "Text", image: "Image", logo: "Logo", rect: "Shape" } as const;

/** Clips laid end to end, then one lane per overlay and per audio track, with a shared ruler. */
export function TimelineStrip({ t, playhead, onPlayhead, selection, onSelect }: {
  t: Timeline; playhead: number; onPlayhead: (ms: number) => void; selection: Selection; onSelect: (s: Selection) => void;
}) {
  const [pxPerSec, setPx] = useState(40);
  const scroller = useRef<HTMLDivElement>(null);
  const dur = timelineDuration(t);
  const end = Math.max(dur, ...t.overlays.map((o) => o.endMs), ...t.audio.map((a) => a.startMs + a.outMs - a.inMs), 5000);
  const W = Math.ceil((end / 1000) * pxPerSec) + 40;
  const x = (ms: number) => (ms / 1000) * pxPerSec;
  const starts = clipStarts(t);
  const seek = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    onPlayhead(Math.max(0, Math.min(dur, Math.round(((e.clientX - r.left) / pxPerSec) * 1000))));
  };
  const sel = (type: "clip" | "overlay" | "audio", id: string) => selection?.type === type && selection.id === id;
  const block = "absolute top-1 bottom-1 overflow-hidden rounded px-1 text-left text-[11px] leading-tight";
  const ticks = Array.from({ length: Math.floor(end / 1000) + 1 }, (_, s) => s).filter((s) => pxPerSec >= 20 || s % 5 === 0);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-end gap-1 text-xs">
        <span className="text-[var(--text-muted)]">Zoom</span>
        <Button variant="ghost" className="h-7 px-2" onClick={() => setPx((p) => Math.max(10, p / 1.5))} aria-label="Zoom out">−</Button>
        <Button variant="ghost" className="h-7 px-2" onClick={() => setPx((p) => Math.min(200, p * 1.5))} aria-label="Zoom in">+</Button>
      </div>
      <div ref={scroller} className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)]">
        <div className="relative" style={{ width: W }}>
          <div className="relative h-6 cursor-pointer border-b border-[var(--border)]" onClick={seek} aria-label="Ruler: click to move the playhead">
            {ticks.map((s) => <span key={s} className="absolute top-0 h-full border-l border-[var(--border)] pl-0.5 text-[10px] text-[var(--text-muted)]" style={{ left: x(s * 1000) }}>{s}s</span>)}
          </div>
          <div className="relative h-14" aria-label="Clips">
            {t.clips.map((c, i) => (
              <button key={c.id} type="button" onClick={() => onSelect({ type: "clip", id: c.id })}
                className={cn(block, "border", c.kind === "video" ? "bg-sky-700/80 text-white" : "bg-emerald-700/80 text-white", sel("clip", c.id) ? "border-[var(--accent)] ring-2 ring-[var(--accent)]" : "border-black/20")}
                style={{ left: x(starts[i]!) + 1, width: Math.max(4, x(clipDuration(c)) - 2) }}>
                {i + 1}. {c.kind === "video" ? "Video" : "Image"} · {(clipDuration(c) / 1000).toFixed(1)}s{c.muted && c.hasAudio ? " · muted" : ""}
              </button>
            ))}
          </div>
          {t.overlays.map((o) => (
            <div key={o.id} className="relative h-7 border-t border-[var(--border)]">
              <button type="button" onClick={() => onSelect({ type: "overlay", id: o.id })}
                className={cn(block, "bg-amber-600/80 text-white", sel("overlay", o.id) && "ring-2 ring-[var(--accent)]")}
                style={{ left: x(o.startMs), width: Math.max(4, x(o.endMs - o.startMs)) }}>
                {OVERLAY_LABEL[o.kind]}{o.kind === "text" && o.text ? `: ${o.text}` : ""}
              </button>
            </div>
          ))}
          {t.audio.map((a) => (
            <div key={a.id} className="relative h-7 border-t border-[var(--border)]">
              <button type="button" onClick={() => onSelect({ type: "audio", id: a.id })}
                className={cn(block, "bg-violet-700/80 text-white", sel("audio", a.id) && "ring-2 ring-[var(--accent)]")}
                style={{ left: x(a.startMs), width: Math.max(4, x(a.outMs - a.inMs)) }}>
                Audio · {((a.outMs - a.inMs) / 1000).toFixed(1)}s
              </button>
            </div>
          ))}
          <div className="pointer-events-none absolute bottom-0 top-0 w-0.5 bg-red-500" style={{ left: x(playhead) }} aria-hidden />
          {dur > 0 && <div className="pointer-events-none absolute bottom-0 top-6 border-l border-dashed border-[var(--text-muted)]" style={{ left: x(dur) }} title="Video ends" aria-hidden />}
        </div>
      </div>
    </div>
  );
}
