"use client";
import { useState } from "react";
import { Button, Card, Input, cn } from "@arcatic/ui";
import { useApi } from "@/lib/use-api";
import type { MediaAsset } from "@/lib/media";
import { MediaThumb } from "./MediaThumb";

/** Modal file chooser over the media library (ready files only). */
export function MediaPicker({ workspaceId, kinds, multiple, title, onPick, onClose }: {
  workspaceId: string; kinds: Array<"image" | "video" | "audio">; multiple?: boolean; title: string;
  onPick: (assets: MediaAsset[]) => void; onClose: () => void;
}) {
  const [kind, setKind] = useState<string>(kinds.length === 1 ? kinds[0]! : "");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<MediaAsset[]>([]);
  const params = new URLSearchParams({ limit: "60", ...(kind && { kind }), ...(q && { q }) });
  const { data, loading } = useApi<{ data: MediaAsset[] }>(`/workspaces/${workspaceId}/media?${params}`);
  const rows = (data?.data ?? []).filter((a) => a.status === "ready" && (kinds as string[]).includes(a.kind));
  const toggle = (a: MediaAsset) => {
    if (!multiple) return onPick([a]);
    setPicked((p) => (p.some((x) => x.id === a.id) ? p.filter((x) => x.id !== a.id) : [...p, a]));
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <Card className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-3">
        <div className="flex items-center justify-between"><h2 className="font-semibold">{title}</h2><Button variant="ghost" onClick={onClose}>Close</Button></div>
        <div className="flex gap-2">
          <Input placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search media" />
          {kinds.length > 1 && (
            <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
              <option value="">All</option>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          )}
        </div>
        <div className="grid flex-1 grid-cols-2 gap-2 overflow-auto sm:grid-cols-4">
          {rows.map((a) => {
            const i = picked.findIndex((x) => x.id === a.id);
            return (
              <button key={a.id} type="button" onClick={() => toggle(a)} className={cn("relative flex flex-col gap-1 rounded-md border p-1 text-left", i >= 0 ? "border-[var(--accent)]" : "border-transparent hover:border-[var(--border)]")}>
                <MediaThumb workspaceId={workspaceId} asset={a} className="h-24 w-full" />
                <span className="truncate text-xs">{a.title}</span>
                {i >= 0 && <span className="absolute left-2 top-2 rounded-full bg-[var(--accent)] px-2 text-xs text-[var(--accent-fg)]">{i + 1}</span>}
              </button>
            );
          })}
          {!loading && rows.length === 0 && <p className="col-span-full text-sm text-[var(--text-muted)]">No ready {kinds.join(" / ")} files. Upload some in the media library first.</p>}
        </div>
        {multiple && <div className="flex justify-end gap-2"><span className="self-center text-sm text-[var(--text-muted)]">{picked.length} selected (in order)</span><Button disabled={!picked.length} onClick={() => onPick(picked)}>Add</Button></div>}
      </Card>
    </div>
  );
}
