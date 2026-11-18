"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  EXPORT_PRESETS, addAudio, addClip, addOverlay, replaceAudio, splitClip, timelineDuration, updateOverlay, validateTimeline,
  type ExportPreset, type Timeline,
} from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { useSignedUrl, type MediaAsset } from "@/lib/media";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { MediaPicker } from "@/components/media/MediaPicker";
import { JobProgress } from "@/components/plan/JobProgress";
import { Inspector } from "@/components/video/Inspector";
import { Stage } from "@/components/video/Stage";
import { TimelineStrip, type Selection } from "@/components/video/TimelineStrip";
import { renderStaleText } from "@/components/video/render-text";

type Project = {
  id: string; title: string; export_preset: ExportPreset; status: string; revision: number; rendered_revision: number | null; duration_ms: number;
  preview_asset_id: string | null; output_asset_id: string | null; content_item_id: string | null; last_render_job_id: string | null; timeline: Timeline;
};
type PickFor = { what: "clips" | "image" | "audio" | "replace-audio" } | { what: "overlay-image"; overlayId: string };
const CHANNELS = ["instagram", "facebook", "youtube", "tiktok", "linkedin", "x", "threads"] as const;

function Rendered({ workspaceId, assetId, label }: { workspaceId: string; assetId: string; label: string }) {
  const url = useSignedUrl(workspaceId, assetId);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium">{label}</span>
      {url ? <video src={url} controls preload="metadata" className="max-h-72 w-full rounded-md bg-black" /> : <div className="h-40 rounded-md bg-[var(--surface-2)]" />}
      {url && <a className="text-xs text-[var(--accent)] hover:underline" href={url} target="_blank" rel="noreferrer">Open file</a>}
    </div>
  );
}

export default function VideoEditor() {
  const { workspaceId, brandId, projectId } = useParams<{ workspaceId: string; brandId: string; projectId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const proj = useApi<Project>(`${base}/video-projects/${projectId}`);
  const brand = useApi<{ logo_asset_id: string | null; name: string }>(`/workspaces/${workspaceId}/brands/${brandId}`);
  const [t, setT] = useState<Timeline>();
  const [title, setTitle] = useState("");
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const past = useRef<Timeline[]>([]);
  const lastPush = useRef(0);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState<Selection>();
  const [pick, setPick] = useState<PickFor>();
  const [job, setJob] = useState<{ id: string; label: string }>();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [send, setSend] = useState({ channel: "instagram" as (typeof CHANNELS)[number], caption: "", hashtags: "" });

  const p = proj.data;
  useEffect(() => {
    if (!p) return;
    setT(p.timeline);
    setTitle(p.title);
    setRevision(p.revision);
    setDirty(false);
    past.current = [];
    if (p.status === "rendering" && p.last_render_job_id) setJob((j) => j ?? { id: p.last_render_job_id!, label: "Rendering final video" });
  }, [p?.id, p?.revision, p?.status]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function apply(fn: (t: Timeline) => Timeline) {
    if (!t) return;
    try {
      const next = fn(t);
      if (Date.now() - lastPush.current > 600) past.current = [...past.current.slice(-49), t];
      lastPush.current = Date.now();
      setT(next);
      setDirty(true);
      setMsg(undefined);
    } catch (e) {
      setMsg({ err: true, text: (e as Error).message });
    }
  }
  function undo() {
    const prev = past.current.pop();
    if (prev) { setT(prev); setDirty(true); lastPush.current = 0; }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "z" || e.shiftKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (proj.error) return <p className="text-sm text-[var(--danger)]">{proj.error}</p>;
  if (!p || !t) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;

  const dur = timelineDuration(t);
  const v = validateTimeline(t);
  const rendering = p.status === "rendering" || !!job;
  const finalCost = Math.max(1, Math.ceil(dur / 60_000)) * 0.5;
  const upToDate = !!p.output_asset_id && p.rendered_revision === revision && !dirty;

  async function run<T>(label: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    setBusy(label);
    setMsg(undefined);
    try {
      const r = await fn();
      if (ok) setMsg({ text: ok });
      return r;
    } catch (e) {
      setMsg({ err: true, text: (e as Error).message });
      return undefined;
    } finally {
      setBusy("");
    }
  }

  async function save(): Promise<boolean> {
    setBusy("Saving");
    setMsg(undefined);
    try {
      const withText = await renderStaleText(workspaceId, brandId, t!);
      const res = await api<{ revision: number }>(`${base}/video-projects/${projectId}/timeline`, { method: "PUT", body: JSON.stringify({ revision, timeline: withText, title }) });
      setT(withText);
      setRevision(res.revision);
      setDirty(false);
      setMsg({ text: "Saved." });
      return true;
    } catch (e) {
      setMsg({ err: true, text: (e as Error).message });
      if (e instanceof ApiError && e.status === 409 && /changed/.test(e.message) && confirm("This video was changed somewhere else. Load the latest version? Your unsaved edits here will be lost.")) void proj.reload();
      return false;
    } finally {
      setBusy("");
    }
  }

  async function render(mode: "preview" | "final") {
    if ((dirty || title !== p!.title) && !(await save())) return;
    if (mode === "final" && !confirm(`Render the final video? This uses up to ${finalCost} credit(s).`)) return;
    const r = await run("Starting render", () => api<{ job: { id: string } }>(`${base}/video-projects/${projectId}/render`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ mode }) }));
    if (r) { setJob({ id: r.job.id, label: mode === "final" ? "Rendering final video" : "Rendering preview" }); void proj.reload(); }
  }

  function onPicked(assets: MediaAsset[]) {
    const f = pick;
    setPick(undefined);
    if (!f) return;
    if (f.what === "clips") {
      const skipped = assets.filter((a) => a.kind === "video" && !a.duration_ms).length;
      apply((t) => assets.reduce((acc, a) => (a.kind === "video"
        ? a.duration_ms ? addClip(acc, { assetId: a.id, kind: "video", inMs: 0, outMs: a.duration_ms, sourceDurationMs: a.duration_ms, hasAudio: !!a.metadata?.hasAudio, volume: 1, muted: false, fit: "cover", fadeIn: false }) : acc
        : addClip(acc, { assetId: a.id, kind: "image", inMs: 0, outMs: 3000, sourceDurationMs: null, hasAudio: false, volume: 1, muted: false, fit: "cover", fadeIn: true })), t));
      if (skipped) setMsg({ err: true, text: `${skipped} video(s) are still processing and were skipped.` });
      return;
    }
    const a = assets[0]!;
    if (f.what === "image") {
      const w = 0.3;
      const h = Math.min(0.9, a.width && a.height ? w * (a.height / a.width) * (t!.width / t!.height) : w);
      apply((t) => addOverlay(t, { kind: "image", assetId: a.id, startMs: Math.min(playhead, Math.max(0, dur - 1000)), endMs: Math.max(dur, 1000), x: 0.35, y: 0.35, w, h, opacity: 1 }));
    } else if (f.what === "overlay-image") {
      apply((t) => updateOverlay(t, f.overlayId, { assetId: a.id }));
    } else if (!a.duration_ms) {
      setMsg({ err: true, text: "That audio file is still processing." });
    } else if (f.what === "audio") {
      apply((t) => addAudio(t, { assetId: a.id, startMs: playhead >= dur ? 0 : Math.round(playhead), sourceDurationMs: a.duration_ms!, volume: 1, fadeInMs: 0, fadeOutMs: 0 }));
    } else {
      apply((t) => replaceAudio(t, { assetId: a.id, sourceDurationMs: a.duration_ms! }));
    }
  }

  const start = Math.min(Math.round(playhead), Math.max(0, dur - 500));
  const addText = () => apply((t) => addOverlay(t, {
    kind: "text", text: "Your message", startMs: start, endMs: start + 3000, x: 0.08, y: 0.72, w: 0.84, h: 0.12, opacity: 1,
    fontSize: Math.round(Math.min(t.width, t.height) * 0.06), fontWeight: "700", color: "#FFFFFF", align: "center",
  }));
  const addLogo = () => {
    if (!brand.data?.logo_asset_id) return setMsg({ err: true, text: "Add a logo to the Brand Kit first, or use “Image” to place any picture." });
    const w = 0.18;
    apply((t) => addOverlay(t, { kind: "logo", assetId: brand.data!.logo_asset_id, startMs: 0, endMs: Math.max(dur, 1000), x: 0.78, y: 0.03, w, h: Math.min(0.3, w * (t.width / t.height)), opacity: 1 }));
  };
  const addShape = () => apply((t) => addOverlay(t, { kind: "rect", fill: "#000000", startMs: start, endMs: start + 3000, x: 0, y: 0.68, w: 1, h: 0.2, opacity: 0.5 }));
  const setPreset = (preset: ExportPreset) => apply((t) => ({ ...t, preset, width: EXPORT_PRESETS[preset].width, height: EXPORT_PRESETS[preset].height, fps: EXPORT_PRESETS[preset].fps }));
  const tool = "h-8 px-3 text-xs";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/w/${workspaceId}/b/${brandId}/videos`} className="text-sm text-[var(--text-muted)] hover:underline">Videos</Link><span className="text-[var(--text-muted)]">/</span>
          <Input value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} className="h-8 max-w-sm font-semibold" aria-label="Title" maxLength={200} />
          <Badge tone={rendering ? "warning" : upToDate ? "success" : "neutral"}>{rendering ? "rendering" : upToDate ? "rendered" : dirty ? "unsaved changes" : "draft"}</Badge>
        </div>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Button variant="secondary" className={tool} onClick={() => setPick({ what: "clips" })}>+ Clips</Button>
        <Button variant="secondary" className={tool} onClick={addText}>+ Text</Button>
        <Button variant="secondary" className={tool} onClick={() => setPick({ what: "image" })}>+ Image</Button>
        <Button variant="secondary" className={tool} onClick={addLogo}>+ Logo</Button>
        <Button variant="secondary" className={tool} onClick={addShape}>+ Shape</Button>
        <Button variant="secondary" className={tool} onClick={() => setPick({ what: "audio" })}>+ Audio</Button>
        <Button variant="secondary" className={tool} onClick={() => setPick({ what: "replace-audio" })} disabled={!t.clips.length}>Replace sound</Button>
        <Button variant="secondary" className={tool} onClick={() => apply((t) => splitClip(t, playhead))} disabled={!t.clips.length}>Split at playhead</Button>
        <Button variant="ghost" className={tool} onClick={undo} disabled={!past.current.length}>Undo</Button>
        <span className="mx-1 h-6 w-px bg-[var(--border)]" />
        <select className="h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs" value={t.preset} onChange={(e) => setPreset(e.target.value as ExportPreset)} aria-label="Export format">
          {Object.entries(EXPORT_PRESETS).map(([k, x]) => <option key={k} value={k}>{x.label} · {x.width}×{x.height}</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">Background<input type="color" value={t.background} onChange={(e) => apply((t) => ({ ...t, background: e.target.value.toUpperCase() }))} className="h-7 w-9 rounded border border-[var(--border)]" /></label>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" className={tool} disabled={!!busy || rendering || (!dirty && title === p.title)} onClick={() => void save()}>{busy === "Saving" ? "Saving…" : "Save"}</Button>
        </div>
      </Card>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="p-3">
            <Stage workspaceId={workspaceId} t={t} playhead={playhead} playing={playing} onPlayhead={setPlayhead} onPlaying={setPlaying}
              selectedId={selection?.type === "overlay" ? selection.id : undefined} onSelect={(id) => setSelection({ type: "overlay", id })}
              onMoveOverlay={(id, x, y) => apply((t) => updateOverlay(t, id, { x, y }))} />
          </Card>
          <TimelineStrip t={t} playhead={playhead} onPlayhead={(ms) => { setPlaying(false); setPlayhead(ms); }} selection={selection} onSelect={setSelection} />
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-4"><Inspector t={t} selection={selection} apply={apply} onSelect={setSelection} onPickImage={(overlayId) => setPick({ what: "overlay-image", overlayId })} /></Card>

          <Card className="flex flex-col gap-2 p-4">
            <h3 className="font-semibold">Checks</h3>
            {v.issues.length === 0 ? <p className="text-sm text-[var(--success)]">Ready to render.</p> : (
              <ul className="flex flex-col gap-1 text-sm">
                {v.issues.map((i, k) => (
                  <li key={k}>
                    <button type="button" className={cn("text-left", i.severity === "error" ? "text-[var(--danger)]" : "text-[var(--warning)]")} disabled={!i.ref}
                      onClick={() => i.ref && setSelection({ type: t.clips.some((c) => c.id === i.ref) ? "clip" : t.overlays.some((o) => o.id === i.ref) ? "overlay" : "audio", id: i.ref })}>
                      {i.severity === "error" ? "✕" : "!"} {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-[var(--text-muted)]">Text in Telugu and other scripts is drawn in your browser when you save, so it renders exactly as typed.</p>
          </Card>

          <Card className="flex flex-col gap-3 p-4">
            <h3 className="font-semibold">Render</h3>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" className={tool} disabled={!!busy || rendering || !v.passed} onClick={() => void render("preview")}>Preview (free, low-res)</Button>
              <Button className={tool} disabled={!!busy || rendering || !v.passed} onClick={() => void render("final")}>Final · {finalCost} credit{finalCost === 1 ? "" : "s"}</Button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">{EXPORT_PRESETS[t.preset].label}: {t.width}×{t.height}, {t.fps} fps, H.264 MP4.</p>
            {job && <JobProgress workspaceId={workspaceId} jobId={job.id} label={job.label} onDone={(j) => { setJob(undefined); void proj.reload(); setMsg(j.status === "succeeded" ? { text: `${job.label.replace("Rendering", "").trim()} ready.` } : { err: true, text: j.error?.message ?? "Render failed." }); }} />}
            {p.preview_asset_id && <Rendered key={p.preview_asset_id} workspaceId={workspaceId} assetId={p.preview_asset_id} label="Latest preview" />}
            {p.output_asset_id && <Rendered key={p.output_asset_id} workspaceId={workspaceId} assetId={p.output_asset_id} label={upToDate ? "Final video" : "Final video (from an earlier version)"} />}
          </Card>

          <Card className="flex flex-col gap-2 p-4">
            <h3 className="font-semibold">Send to content</h3>
            {p.content_item_id && <Link className="text-sm text-[var(--accent)] hover:underline" href={`/w/${workspaceId}/b/${brandId}/content/${p.content_item_id}`}>Open the post for this video →</Link>}
            {!upToDate ? <p className="text-sm text-[var(--text-muted)]">Render the final video first; it then goes through review and scheduling like any post.</p> : (
              <form className="flex flex-col gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); void run("Sending", () => api<{ contentItemId: string }>(`${base}/video-projects/${projectId}/send-to-content`, { method: "POST", body: JSON.stringify(send) }).then(() => proj.reload()), "Sent. Review the caption and submit it for approval."); }}>
                <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={send.channel} onChange={(e) => setSend({ ...send, channel: e.target.value as typeof send.channel })} aria-label="Channel">
                  {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <textarea className="min-h-20 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2" placeholder="Caption" maxLength={5000} value={send.caption} onChange={(e) => setSend({ ...send, caption: e.target.value })} />
                <Input placeholder="#hashtags" value={send.hashtags} onChange={(e) => setSend({ ...send, hashtags: e.target.value })} maxLength={500} />
                <Button type="submit" disabled={!!busy}>{p.content_item_id ? "Send again as a new post" : "Send to content"}</Button>
              </form>
            )}
          </Card>
        </div>
      </div>

      {pick && (
        <MediaPicker workspaceId={workspaceId} onClose={() => setPick(undefined)} onPick={onPicked}
          kinds={pick.what === "clips" ? ["video", "image"] : pick.what === "audio" || pick.what === "replace-audio" ? ["audio"] : ["image"]}
          multiple={pick.what === "clips"}
          title={pick.what === "clips" ? "Add clips and images" : pick.what === "replace-audio" ? "Replace all sound with…" : pick.what === "audio" ? "Add music or voice-over" : "Choose an image"} />
      )}
    </div>
  );
}
