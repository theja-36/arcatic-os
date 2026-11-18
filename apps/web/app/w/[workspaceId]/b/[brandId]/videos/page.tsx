"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { EXPORT_PRESETS, type ExportPreset } from "@arcatic/core";
import { Badge, Button, Card, EmptyState, Input } from "@arcatic/ui";
import { api } from "@/lib/api";
import { formatDuration, type MediaAsset } from "@/lib/media";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { MediaPicker } from "@/components/media/MediaPicker";

type Project = { id: string; title: string; export_preset: ExportPreset; status: string; duration_ms: number; revision: number; rendered_revision: number | null; content_item_id: string | null; updated_at: string };
const tone = (s: string) => (s === "rendered" ? "success" : s === "rendering" ? "warning" : s === "failed" ? "danger" : "neutral");

export default function Videos() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const router = useRouter();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const { data } = useApi<{ data: Project[] }>(`${base}/video-projects`);
  const [title, setTitle] = useState("");
  const [preset, setPreset] = useState<ExportPreset>("instagram-reel");
  const [picked, setPicked] = useState<MediaAsset[]>([]);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const p = await api<Project>(`${base}/video-projects`, { method: "POST", body: JSON.stringify({ title, preset, assetIds: picked.map((a) => a.id) }) });
      router.push(`/w/${workspaceId}/b/${brandId}/videos/${p.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Videos</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <Card>
        <form className="flex flex-col gap-3" onSubmit={create}>
          <h2 className="font-semibold">New video</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Title</span><Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Diwali offer reel" /></label>
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Format</span>
              <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={preset} onChange={(e) => setPreset(e.target.value as ExportPreset)}>
                {Object.entries(EXPORT_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label} · {p.width}×{p.height}{p.maxSeconds ? ` · up to ${p.maxSeconds}s` : ""}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button type="button" variant="secondary" onClick={() => setPicking(true)}>Choose clips &amp; images</Button>
            <span className="text-[var(--text-muted)]">{picked.length ? `${picked.length} file(s), in this order` : "Optional: you can add clips in the editor."}</span>
          </div>
          {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
          <div><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create and open editor"}</Button></div>
        </form>
      </Card>
      {picking && <MediaPicker workspaceId={workspaceId} kinds={["video", "image"]} multiple title="Choose clips and images" onClose={() => setPicking(false)} onPick={(a) => { setPicked(a); setPicking(false); }} />}
      {data?.data.length === 0 && <EmptyState title="No videos yet" body="Combine your clips, product photos, logo, text and music into a branded video sized for each platform." />}
      <Card className="divide-y divide-[var(--border)] p-0">
        {data?.data.map((p) => (
          <Link key={p.id} href={`/w/${workspaceId}/b/${brandId}/videos/${p.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-[var(--surface-2)] sm:flex-row sm:items-center sm:gap-3">
            <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
            <span className="text-xs text-[var(--text-muted)]">{EXPORT_PRESETS[p.export_preset]?.label} · {formatDuration(p.duration_ms)}</span>
            <Badge tone={tone(p.status)}>{p.status === "rendered" && p.rendered_revision !== p.revision ? "edited since render" : p.status}</Badge>
            {p.content_item_id && <Badge tone="accent">sent to content</Badge>}
          </Link>
        ))}
      </Card>
    </div>
  );
}
