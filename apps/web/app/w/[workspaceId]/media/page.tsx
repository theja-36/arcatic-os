"use client";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { Badge, Button, Card, EmptyState, Input, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { driveConfigured, pickDriveFiles } from "@/lib/google-drive";
import { formatDuration, replaceFile, useSignedUrl, type Collection, type MediaAsset } from "@/lib/media";
import { formatBytes, uploadFile } from "@/lib/upload";
import { useApi } from "@/lib/use-api";
import { MediaThumb } from "@/components/media/MediaThumb";

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,video/*,audio/*";
const SOURCE_LABEL: Record<string, string> = { url_import: "from URL", drive: "from Drive", render: "rendered", ai: "AI", upload: "" };

function Preview({ workspaceId, asset, folders, onChanged, onClose }: { workspaceId: string; asset: MediaAsset; folders: Collection[]; onChanged: (msg: string) => void; onClose: () => void }) {
  const url = useSignedUrl(workspaceId, asset.id, { enabled: asset.status === "ready" });
  const [title, setTitle] = useState(asset.title ?? "");
  const [alt, setAlt] = useState(asset.alt_text ?? "");
  const [tags, setTags] = useState(asset.tags.join(", "));
  const [err, setErr] = useState("");
  const replaceRef = useRef<HTMLInputElement>(null);
  const base = `/workspaces/${workspaceId}/media/${asset.id}`;
  async function act(fn: () => Promise<unknown>, ok: string) {
    setErr("");
    try { await fn(); onChanged(ok); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <Card className="flex flex-col gap-3 lg:sticky lg:top-4">
      <div className="flex items-center justify-between"><h2 className="truncate font-semibold">{asset.title}</h2><Button variant="ghost" className="h-7 px-2" onClick={onClose} aria-label="Close preview">✕</Button></div>
      {asset.status !== "ready" ? <p className="text-sm text-[var(--text-muted)]">{asset.status === "failed" ? "This file couldn't be processed." : "Processing…"}</p>
        : asset.kind === "image" ? url && <img src={url} alt={asset.alt_text ?? ""} className="max-h-80 w-full rounded-md object-contain" />
        : asset.kind === "video" ? url && <video src={url} controls preload="metadata" className="max-h-80 w-full rounded-md bg-black" />
        : asset.kind === "audio" ? url && <audio src={url} controls className="w-full" />
        : <p className="text-sm text-[var(--text-muted)]">No preview for this file type.</p>}
      <div className="flex flex-wrap gap-1 text-xs">
        {asset.width && <Badge>{asset.width}×{asset.height}</Badge>}
        {asset.duration_ms ? <Badge>{formatDuration(asset.duration_ms)}</Badge> : null}
        {asset.bytes ? <Badge>{formatBytes(asset.bytes)}</Badge> : null}
        {asset.kind === "video" && asset.status === "ready" && <Badge>{asset.metadata?.hasAudio ? "has sound" : "no sound"}</Badge>}
      </div>
      <form className="flex flex-col gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); void act(() => api(base, { method: "PATCH", body: JSON.stringify({ title, altText: alt || null, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }) }), "Saved."); }}>
        <label className="flex flex-col gap-1"><span className="font-medium">Name</span><Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
        {asset.kind === "image" && <label className="flex flex-col gap-1"><span className="font-medium">Description (alt text)</span><Input value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={500} /></label>}
        <label className="flex flex-col gap-1"><span className="font-medium">Tags</span><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="logo, diwali, product" /></label>
        <label className="flex flex-col gap-1"><span className="font-medium">Folder</span>
          <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={asset.collection_id ?? ""}
            onChange={(e) => void act(() => api(base, { method: "PATCH", body: JSON.stringify({ collectionId: e.target.value || null }) }), "Moved.")}>
            <option value="">No folder</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="secondary">Save details</Button>
          {url && <a href={url} target="_blank" rel="noreferrer"><Button type="button" variant="ghost">Open</Button></a>}
          {["image", "video", "audio"].includes(asset.kind) && asset.status === "ready" && <Button type="button" variant="ghost" onClick={() => replaceRef.current?.click()}>Replace file</Button>}
          <Button type="button" variant="ghost" onClick={() => { if (confirm("Delete this file? Videos and posts that use it will lose it.")) void act(() => api(base, { method: "DELETE" }).then(onClose), "Deleted."); }}>Delete</Button>
        </div>
        <input ref={replaceRef} type="file" hidden accept={asset.kind === "image" ? "image/png,image/jpeg,image/gif,image/webp" : `${asset.kind}/*`}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void act(() => replaceFile(workspaceId, asset.id, f), "File replaced; everything that uses it now shows the new version."); }} />
      </form>
      {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
    </Card>
  );
}

export default function MediaLibrary() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<string>("");   // "" all, "none", or id
  const term = q.trim();
  const params = new URLSearchParams({ limit: "60", ...(kind && { kind }), ...(term.startsWith("#") ? term.length > 1 && { tag: term.slice(1) } : term && { q: term }), ...(folder && { collectionId: folder }) });
  const list = useApi<{ data: MediaAsset[] }>(`/workspaces/${workspaceId}/media?${params}`);
  const cols = useApi<{ data: Collection[] }>(`/workspaces/${workspaceId}/media/collections`);
  const folders = cols.data?.data ?? [];
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string>();
  const current = folders.find((f) => f.id === folder);
  const openAsset = list.data?.data.find((a) => a.id === open);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(undefined);
    try {
      await fn();
      setMsg({ text: ok });
      await Promise.all([list.reload(), cols.reload()]);
    } catch (e) {
      setMsg({ err: true, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const inFolder = current ? current.id : undefined;
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function importDrive() {
    const { token, files } = await pickDriveFiles({ mimeTypes: "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/aac" });
    if (!files.length) return;
    const r = await api<{ data: Array<{ error?: { message: string } }> }>(`/workspaces/${workspaceId}/media/import-drive`, {
      method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ accessToken: token, files, collectionId: inFolder }),
    });
    const failed = r.data.filter((x) => x.error).length;
    if (failed) throw new Error(`${files.length - failed} importing; ${failed} couldn't start.`);
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Media library</h1>
      <Card className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Upload images, video or audio{current ? ` to “${current.name}”` : ""}</span>
          <input type="file" multiple accept={ACCEPT} disabled={busy}
            onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; void run(async () => { for (const f of files) await uploadFile(workspaceId, f, undefined, inFolder); }, `${files.length} file(s) uploaded. Videos and audio take a moment to process.`); }} />
        </label>
        <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/workspaces/${workspaceId}/media/import-url`, { method: "POST", body: JSON.stringify({ url }) }).then(() => setUrl("")), "Image imported."); }}>
          <Input type="url" required placeholder="https://… image URL" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Image URL" />
          <Button type="submit" variant="secondary" disabled={busy}>Import</Button>
        </form>
        {driveConfigured && <Button variant="secondary" disabled={busy} onClick={() => void run(importDrive, "Importing from Google Drive…")}>Google Drive</Button>}
      </Card>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      <div className="grid gap-4 lg:grid-cols-[200px_1fr_320px]">
        <nav className="flex flex-col gap-1 text-sm" aria-label="Folders">
          {[{ id: "", name: "All files" }, { id: "none", name: "Not in a folder" }, ...folders].map((f) => (
            <button key={f.id || "all"} onClick={() => { setFolder(f.id); setSelected(new Set()); }} className={cn("truncate rounded-md px-2 py-1 text-left", folder === f.id ? "bg-[var(--surface-2)] font-medium" : "text-[var(--text-muted)] hover:bg-[var(--surface-2)]")}>{f.name}</button>
          ))}
          <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); const el = e.currentTarget.elements.namedItem("name") as HTMLInputElement; const name = el.value; void run(() => api(`/workspaces/${workspaceId}/media/collections`, { method: "POST", body: JSON.stringify({ name }) }).then(() => { el.value = ""; }), `Folder “${name}” created.`); }}>
            <Input name="name" placeholder="New folder" required maxLength={120} className="h-8" aria-label="New folder name" />
            <Button type="submit" variant="ghost" className="h-8 px-2" aria-label="Create folder">+</Button>
          </form>
          {current && (
            <div className="mt-1 flex gap-1">
              <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => { const name = prompt("Rename folder", current.name); if (name) void run(() => api(`/workspaces/${workspaceId}/media/collections/${current.id}`, { method: "PATCH", body: JSON.stringify({ name }) }), "Renamed."); }}>Rename</Button>
              <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => { if (confirm(`Delete folder “${current.name}”? Files in it stay in the library.`)) void run(() => api(`/workspaces/${workspaceId}/media/collections/${current.id}`, { method: "DELETE" }).then(() => setFolder("")), "Folder deleted."); }}>Delete</Button>
            </div>
          )}
        </nav>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Search by name, or #tag" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search media" className="max-w-xs" />
            <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
              <option value="">All kinds</option><option value="image">Images</option><option value="video">Video</option><option value="audio">Audio</option><option value="document">Documents</option>
            </select>
            {selected.size > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <span>{selected.size} selected</span>
                <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" defaultValue="" aria-label="Move selected to folder"
                  onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) void run(() => api(`/workspaces/${workspaceId}/media/move`, { method: "POST", body: JSON.stringify({ ids: [...selected], collectionId: v === "none" ? null : v }) }).then(() => setSelected(new Set())), "Moved."); }}>
                  <option value="" disabled>Move to…</option><option value="none">No folder</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <Button variant="ghost" className="h-8 px-2" onClick={() => setSelected(new Set())}>Clear</Button>
              </div>
            )}
          </div>
          {list.data?.data.length === 0 && <EmptyState title="Nothing here yet" body="Upload logos, product photos, videos, music and voice-overs, or import from a URL or Google Drive." />}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {list.data?.data.map((a) => (
              <Card key={a.id} className={cn("relative flex cursor-pointer flex-col gap-2 p-3", open === a.id && "outline outline-2 outline-[var(--accent)]")} onClick={() => setOpen(a.id)}>
                <input type="checkbox" className="absolute left-4 top-4 z-10 h-4 w-4" checked={selected.has(a.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(a.id)} aria-label={`Select ${a.title}`} />
                <MediaThumb workspaceId={workspaceId} asset={a} />
                <p className="truncate text-sm font-medium" title={a.title ?? ""}>{a.title}</p>
                <div className="flex flex-wrap gap-1 text-xs">
                  {a.status !== "ready" && <Badge tone={a.status === "failed" ? "danger" : "warning"}>{a.status}</Badge>}
                  <Badge>{a.kind}</Badge>
                  {SOURCE_LABEL[a.source] ? <Badge>{SOURCE_LABEL[a.source]}</Badge> : null}
                </div>
              </Card>
            ))}
          </div>
        </div>

        <div>{openAsset && <Preview key={openAsset.id + openAsset.status} workspaceId={workspaceId} asset={openAsset} folders={folders} onClose={() => setOpen(undefined)} onChanged={(t) => { setMsg({ text: t }); void list.reload(); }} />}</div>
      </div>
    </div>
  );
}
