"use client";
import { useEffect, useRef, useState } from "react";
import { clipDuration, clipStarts, timelineDuration, type AudioTrack, type Overlay, type Timeline } from "@arcatic/core";
import { cn } from "@arcatic/ui";
import { useSignedUrl } from "@/lib/media";
import { fontStack } from "./render-text";

/**
 * Live editor preview. It approximates the export (the browser plays each source file);
 * the FFmpeg preview render is the exact result.
 */
function ClipLayer({ workspaceId, t, playhead, playing }: { workspaceId: string; t: Timeline; playhead: number; playing: boolean }) {
  const starts = clipStarts(t);
  const i = t.clips.findIndex((c, k) => playhead >= starts[k]! && playhead < starts[k]! + clipDuration(c));
  const clip = t.clips[i < 0 ? t.clips.length - 1 : i];
  const url = useSignedUrl(workspaceId, clip?.assetId);
  const ref = useRef<HTMLVideoElement>(null);
  const local = clip ? Math.min(playhead - (starts[i < 0 ? t.clips.length - 1 : i] ?? 0), clipDuration(clip)) : 0;
  const sourceSec = clip ? (clip.kind === "video" ? clip.inMs + local : 0) / 1000 : 0;

  useEffect(() => {
    const v = ref.current;
    if (!v || !clip || clip.kind !== "video") return;
    v.muted = clip.muted || !clip.hasAudio;
    v.volume = Math.min(1, clip.volume);
    if (!playing || Math.abs(v.currentTime - sourceSec) > 0.3) v.currentTime = sourceSec;
    if (playing && v.paused) void v.play().catch(() => undefined);
    if (!playing && !v.paused) v.pause();
  }, [clip, sourceSec, playing]);

  if (!clip) return null;
  const fit = clip.fit === "contain" ? "object-contain" : "object-cover";
  const fade = clip.fadeIn ? Math.min(1, local / 500) : 1;
  if (!url) return null;
  return clip.kind === "video"
    ? <video key={clip.assetId} ref={ref} src={url} className={cn("absolute inset-0 h-full w-full", fit)} style={{ opacity: fade }} playsInline preload="auto" />
    : <img src={url} alt="" className={cn("absolute inset-0 h-full w-full", fit)} style={{ opacity: fade }} />;
}

function AudioLayer({ workspaceId, a, playhead, playing }: { workspaceId: string; a: AudioTrack; playhead: number; playing: boolean }) {
  const url = useSignedUrl(workspaceId, a.assetId);
  const ref = useRef<HTMLAudioElement>(null);
  const len = a.outMs - a.inMs;
  const active = playhead >= a.startMs && playhead < a.startMs + len;
  const pos = (a.inMs + playhead - a.startMs) / 1000;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const local = playhead - a.startMs;
    const fade = Math.min(1, a.fadeInMs ? local / a.fadeInMs : 1, a.fadeOutMs ? (len - local) / a.fadeOutMs : 1);
    el.volume = Math.max(0, Math.min(1, a.volume * fade));
    if (!active || !playing) { if (!el.paused) el.pause(); return; }
    if (Math.abs(el.currentTime - pos) > 0.3) el.currentTime = pos;
    if (el.paused) void el.play().catch(() => undefined);
  }, [active, playing, pos, playhead, a, len]);
  return url ? <audio ref={ref} src={url} preload="auto" /> : null;
}

function OverlayView({ workspaceId, o, scale, selected, onPointerDown }: { workspaceId: string; o: Overlay; scale: number; selected: boolean; onPointerDown: (e: React.PointerEvent) => void }) {
  const url = useSignedUrl(workspaceId, o.kind === "image" || o.kind === "logo" ? o.assetId : null);
  const style: React.CSSProperties = { left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${o.h * 100}%`, opacity: o.opacity };
  return (
    <div style={style} onPointerDown={onPointerDown} className={cn("absolute cursor-move touch-none select-none", selected && "outline outline-2 outline-offset-1 outline-[var(--accent)]")}>
      {o.kind === "rect" && <div className="h-full w-full" style={{ background: o.fill ?? "#000000" }} />}
      {(o.kind === "image" || o.kind === "logo") && url && <img src={url} alt="" draggable={false} className={cn("h-full w-full", o.kind === "logo" ? "object-contain" : "object-fill")} />}
      {o.kind === "text" && (
        <div className="flex h-full w-full items-center overflow-hidden" style={{
          background: o.fill ?? "transparent", color: o.color ?? "#FFFFFF", fontFamily: fontStack(o.fontFamily), fontWeight: Number(o.fontWeight ?? "700"),
          fontSize: (o.fontSize ?? 64) * scale, lineHeight: 1.25, textAlign: o.align ?? "center", justifyContent: o.align === "left" ? "flex-start" : o.align === "right" ? "flex-end" : "center",
          padding: `0 ${(o.fontSize ?? 64) * 0.3 * scale}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word",
        }}><span className="w-full">{o.text}</span></div>
      )}
    </div>
  );
}

export function Stage({ workspaceId, t, playhead, playing, onPlayhead, onPlaying, selectedId, onSelect, onMoveOverlay }: {
  workspaceId: string; t: Timeline; playhead: number; playing: boolean; onPlayhead: (ms: number) => void; onPlaying: (p: boolean) => void;
  selectedId?: string; onSelect: (id: string) => void; onMoveOverlay: (id: string, x: number, y: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  const dur = timelineDuration(t);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // playback clock
  const head = useRef(playhead);
  head.current = playhead;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = head.current + (now - last);
      last = now;
      if (next >= dur) { onPlayhead(dur); onPlaying(false); return; }
      onPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, dur]);  // eslint-disable-line react-hooks/exhaustive-deps

  function drag(o: Overlay, e: React.PointerEvent) {
    e.preventDefault();
    onSelect(o.id);
    const rect = box.current!.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const move = (ev: PointerEvent) => {
      const x = Math.max(0, Math.min(1 - o.w, o.x + (ev.clientX - sx) / rect.width));
      const y = Math.max(0, Math.min(1 - o.h, o.y + (ev.clientY - sy) / rect.height));
      onMoveOverlay(o.id, Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const portrait = t.height > t.width;
  return (
    <div className="flex flex-col items-center gap-2">
      <div ref={box} className="relative w-full overflow-hidden rounded-md" style={{ aspectRatio: `${t.width} / ${t.height}`, maxWidth: portrait ? 300 : 640, background: t.background }}>
        <ClipLayer workspaceId={workspaceId} t={t} playhead={playhead} playing={playing} />
        {t.overlays.filter((o) => playhead >= o.startMs && playhead < o.endMs).map((o) => (
          <OverlayView key={o.id} workspaceId={workspaceId} o={o} scale={width / t.width} selected={selectedId === o.id} onPointerDown={(e) => drag(o, e)} />
        ))}
        {t.audio.map((a) => <AudioLayer key={a.id} workspaceId={workspaceId} a={a} playhead={playhead} playing={playing} />)}
        {!t.clips.length && <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white/70">Add clips or images to start.</p>}
      </div>
      <div className="flex items-center gap-3 text-sm">
        <button type="button" className="rounded-md bg-[var(--surface-2)] px-3 py-1" onClick={() => { if (playhead >= dur) onPlayhead(0); onPlaying(!playing); }} disabled={!dur}>{playing ? "Pause" : "Play"}</button>
        <span className="tabular-nums text-[var(--text-muted)]">{(playhead / 1000).toFixed(1)}s / {(dur / 1000).toFixed(1)}s</span>
      </div>
    </div>
  );
}
