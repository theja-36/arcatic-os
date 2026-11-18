"use client";
import { useState } from "react";
import { Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { uploadFile } from "@/lib/upload";
import { DriveImport } from "./DriveImport";

const MODES = [
  { id: "url", label: "Web page" },
  { id: "crawl", label: "Whole website" },
  { id: "file", label: "Document" },
  { id: "media", label: "Video / audio" },
  { id: "text", label: "Note" },
  { id: "social_reference", label: "Social post" },
  { id: "drive", label: "Google Drive" },
] as const;
type Mode = (typeof MODES)[number]["id"];

const DOC_ACCEPT = ".pdf,.docx,.pptx,.xlsx,.html,.htm,.txt,.md,.csv";
const MEDIA_ACCEPT = "audio/*,video/*";

export function AddSource({ workspaceId, brandId, onAdded }: { workspaceId: string; brandId: string; onAdded: () => void }) {
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [limit, setLimit] = useState(25);
  const [refreshDays, setRefreshDays] = useState<number | "">("");
  const [language, setLanguage] = useState("auto");
  const [maxMinutes, setMaxMinutes] = useState(60);
  const [platform, setPlatform] = useState("instagram");
  const [visibility, setVisibility] = useState<"brand" | "private">("brand");
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();

  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(undefined);
    try {
      let payload: Record<string, unknown> = { type: mode, tags: tagList, visibility, ...(title && { title }) };
      if (mode === "url" || mode === "crawl") payload = { ...payload, url, ...(refreshDays && { refreshDays }), ...(mode === "crawl" && { limit }) };
      if (mode === "text") payload = { ...payload, title: title || "Note", body: text };
      if (mode === "social_reference") payload = { ...payload, platform, body: text, ...(url && { url }) };
      if (mode === "file" || mode === "media") {
        if (!file) throw new Error("Choose a file first.");
        setBusy("Uploading…");
        const asset = await uploadFile(workspaceId, file, brandId);
        payload = { ...payload, mediaAssetId: asset.id, ...(mode === "media" && { language, maxMinutes }) };
      }
      setBusy("Starting…");
      const r = await api<{ credits: { estimate: number; reserved: number } | null }>(`${base}/sources`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify(payload) });
      setMsg({ text: `Added. ${r.credits ? `About ${r.credits.estimate} credits (up to ${r.credits.reserved} held until it finishes).` : ""}` });
      setUrl(""); setTitle(""); setText(""); setFile(null); setTags("");
      onAdded();
    } catch (err) {
      setMsg({ err: true, text: err instanceof ApiError && err.code === "insufficient_credits" ? "Not enough credits for this source." : (err as Error).message });
    } finally {
      setBusy("");
    }
  }

  return (
    <Card>
      <div className="mb-4 flex gap-1 overflow-x-auto" role="tablist">
        {MODES.map((m) => (
          <button key={m.id} role="tab" aria-selected={mode === m.id} onClick={() => { setMode(m.id); setMsg(undefined); }}
            className={cn("whitespace-nowrap rounded-full px-3 py-1.5 text-sm", mode === m.id ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "bg-[var(--surface-2)]")}>{m.label}</button>
        ))}
      </div>

      {mode === "drive" ? (
        <DriveImport workspaceId={workspaceId} brandId={brandId} onDone={onAdded} />
      ) : (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          {(mode === "url" || mode === "crawl" || mode === "social_reference") && (
            <Input className="sm:col-span-2" type="url" required={mode !== "social_reference"} placeholder={mode === "social_reference" ? "Link to the post (optional)" : "https://"} value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" />
          )}
          {mode === "crawl" && (
            <label className="flex items-center gap-2 text-sm">Up to
              <select className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                {[10, 25, 50, 100, 200].map((n) => <option key={n}>{n}</option>)}
              </select> pages · {(limit * 0.1).toFixed(1)} credits max
            </label>
          )}
          {(mode === "url" || mode === "crawl") && (
            <label className="flex items-center gap-2 text-sm">Re-check every
              <select className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={refreshDays} onChange={(e) => setRefreshDays(e.target.value ? Number(e.target.value) : "")}>
                <option value="">never</option><option value={7}>week</option><option value={30}>month</option><option value={90}>quarter</option>
              </select>
            </label>
          )}
          {(mode === "file" || mode === "media") && (
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="font-medium">{mode === "file" ? "PDF, Word, PowerPoint, Excel, HTML, text, Markdown or CSV (up to 50 MB)" : "Video or audio (up to 500 MB)"}</span>
              <input type="file" accept={mode === "file" ? DOC_ACCEPT : MEDIA_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          )}
          {mode === "media" && (<>
            <label className="flex items-center gap-2 text-sm">Spoken language
              <select className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="auto">Detect</option><option value="te">Telugu</option><option value="en">English</option><option value="hi">Hindi</option><option value="ta">Tamil</option><option value="kn">Kannada</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">Transcribe up to
              <select className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))}>
                {[15, 30, 60, 120].map((n) => <option key={n} value={n}>{n} min</option>)}
              </select> · 0.5 credits/min
            </label>
          </>)}
          {mode === "social_reference" && (
            <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform">
              {["instagram", "facebook", "linkedin", "x", "youtube", "tiktok", "threads", "other"].map((p) => <option key={p}>{p}</option>)}
            </select>
          )}
          {(mode === "text" || mode === "social_reference") && (
            <textarea required className="min-h-32 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm sm:col-span-2" placeholder={mode === "text" ? "Paste or write anything your marketing should know: FAQs, policies, product details…" : "Paste the text of one of your own posts"} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text" />
          )}
          <Input placeholder={mode === "text" ? "Title" : "Title (optional)"} value={title} required={mode === "text"} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <Input placeholder="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={visibility === "private"} onChange={(e) => setVisibility(e.target.checked ? "private" : "brand")} />
            Private (only me and admins)
          </label>
          <div className="sm:text-right"><Button type="submit" disabled={!!busy}>{busy || "Add to knowledge"}</Button></div>
          {mode === "social_reference" && <p className="text-xs text-[var(--text-muted)] sm:col-span-2">Only add posts from your own accounts. Automatic import from connected accounts comes with channel connections.</p>}
          {msg && <p className={cn("text-sm sm:col-span-2", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")}>{msg.text}</p>}
        </form>
      )}
    </Card>
  );
}
