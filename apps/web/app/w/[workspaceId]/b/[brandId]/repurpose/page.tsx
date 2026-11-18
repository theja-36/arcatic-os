"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { LANGUAGES } from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { JobProgress } from "@/components/plan/JobProgress";

type Output = { id: string; label: string; type: string; channel?: string; cost: { estimate: number; max: number } };
type Source = { id: string; type: string; title: string; url: string | null; status: string };
type Run = {
  id: string; source_ref: { kind: string; title: string; url?: string | null; sourceType?: string | null }; status: string; created_at: string; generation_job_id: string | null;
  outputs: Array<{ outputId: string; status: string; contentItemId?: string; error?: string }>; digest: { summary: string; key_points: Array<{ point: string }> } | null;
};
const KIND: Record<string, string> = { url: "Web page", crawl: "Website", file: "Document", text: "Text", media: "Video / audio", drive: "Google Drive" };
const tone = (s: string) => (s === "succeeded" ? "success" : s === "failed" ? "danger" : s === "partial" ? "warning" : "neutral");

function Repurpose() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const project = useSearchParams().get("project");
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const opts = useApi<{ outputs: Output[]; digestCost: { estimate: number; max: number }; sources: Source[]; content: Array<{ id: string; type: string; title: string | null }> }>(`${base}/repurpose/options`);
  const runs = useApi<{ data: Run[] }>(`${base}/repurpose`);
  const projects = useApi<{ data: Array<{ id: string; name: string }> }>(`${base}/projects`);
  const brand = useApi<{ languages: string[] }>(base);
  const [pick, setPick] = useState<{ kind: "source" | "content"; id: string } | null>(null);
  const [outputs, setOutputs] = useState<string[]>(["instagram_post", "linkedin_post", "x_thread", "blog", "newsletter"]);
  const [language, setLanguage] = useState("");
  const [projectId, setProjectId] = useState(project ?? "");
  const [url, setUrl] = useState("");
  const [job, setJob] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  useEffect(() => { if (!language && brand.data?.languages?.[0]) setLanguage(brand.data.languages[0]); }, [brand.data, language]);
  useEffect(() => {
    const ch = supabase().channel(`repurpose:${brandId}`).on("postgres_changes", { event: "*", schema: "public", table: "repurpose_runs", filter: `brand_id=eq.${brandId}` }, () => void runs.reload()).subscribe();
    return () => void supabase().removeChannel(ch);
  }, [brandId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const o = opts.data;
  const cost = useMemo(() => {
    if (!o) return null;
    const sel = o.outputs.filter((x) => outputs.includes(x.id));
    return { estimate: o.digestCost.estimate + sel.reduce((s, x) => s + x.cost.estimate, 0), max: o.digestCost.max + sel.reduce((s, x) => s + x.cost.max, 0) };
  }, [o, outputs]);
  const ready = (o?.sources ?? []).filter((s) => s.status === "ready");
  const pending = (o?.sources ?? []).filter((s) => s.status === "pending" || s.status === "processing");

  async function addUrl(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(undefined);
    try {
      await api(`${base}/sources`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ type: "url", url, tags: [], visibility: "brand" }) });
      setUrl("");
      setMsg({ text: "Reading the page into Knowledge… it appears below when ready (usually under a minute)." });
      setTimeout(() => void opts.reload(), 15_000);
    } catch (e) { setMsg({ err: true, text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function start() {
    if (!pick) return;
    setBusy(true); setMsg(undefined);
    try {
      const r = await api<{ job: { id: string } }>(`${base}/repurpose`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ ...(pick.kind === "source" ? { sourceId: pick.id } : { contentItemId: pick.id }), outputs, language, projectId: projectId || null }) });
      setJob(r.job.id);
      void runs.reload();
    } catch (e) { setMsg({ err: true, text: e instanceof ApiError && e.code === "insufficient_credits" ? "Not enough credits." : (e as Error).message }); } finally { setBusy(false); }
  }
  const choice = (kind: "source" | "content", id: string, title: string, sub: string) => (
    <label key={id} className={cn("flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm", pick?.id === id ? "border-[var(--accent)] bg-[var(--surface-2)]" : "border-[var(--border)]")}>
      <input type="radio" name="src" checked={pick?.id === id} onChange={() => setPick({ kind, id })} />
      <span className="min-w-0 flex-1 truncate">{title}</span><span className="text-xs text-[var(--text-muted)]">{sub}</span>
    </label>
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Repurpose</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <p className="text-sm text-[var(--text-muted)]">One video, document, web page or article becomes many channel-specific pieces. Arcatic reads the source once, then writes each piece from it; every piece links back to the source and cites the passages it used.</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <h2 className="font-semibold">1. Source</h2>
          <form className="flex gap-2" onSubmit={addUrl}><Input type="url" required placeholder="Paste a web page or blog URL" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" /><Button type="submit" variant="secondary" disabled={busy}>Add</Button></form>
          <p className="text-xs text-[var(--text-muted)]">Videos and documents: add them in <Link className="text-[var(--accent)] hover:underline" href={`/w/${workspaceId}/b/${brandId}/knowledge`}>Knowledge</Link> (videos are transcribed), then pick them here.</p>
          {pending.length > 0 && <p className="text-xs text-[var(--text-muted)]">Still processing: {pending.map((s) => s.title).join(", ")}</p>}
          <div className="flex max-h-72 flex-col gap-1 overflow-auto">
            {ready.map((s) => choice("source", s.id, s.title, KIND[s.type] ?? s.type))}
            {(o?.content ?? []).map((c) => choice("content", c.id, c.title ?? "Untitled", c.type.replace("_", " ")))}
            {!ready.length && !o?.content.length && <p className="text-sm text-[var(--text-muted)]">No sources yet.</p>}
          </div>
        </Card>
        <Card className="flex flex-col gap-3">
          <h2 className="font-semibold">2. What to make</h2>
          <div className="grid grid-cols-2 gap-1">
            {o?.outputs.map((x) => (
              <label key={x.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={outputs.includes(x.id)} onChange={(e) => setOutputs(e.target.checked ? [...outputs, x.id] : outputs.filter((y) => y !== x.id))} />
                {x.label} <span className="text-xs text-[var(--text-muted)]">{x.cost.estimate}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">
              {Object.entries(LANGUAGES).filter(([k]) => !brand.data || brand.data.languages.includes(k) || k === "en").map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
              <option value="">No project</option>{projects.data?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <p className="text-sm text-[var(--text-muted)]">{outputs.length} piece{outputs.length === 1 ? "" : "s"} · about {cost?.estimate ?? "…"} credits (up to {cost?.max ?? "…"} held; you're charged only for pieces that get written).</p>
          <div><Button disabled={busy || !pick || !outputs.length || !!job} onClick={() => void start()}>Repurpose</Button></div>
          {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
        </Card>
      </div>
      {job && <JobProgress workspaceId={workspaceId} jobId={job} label="Repurposing" onDone={() => { setJob(undefined); void runs.reload(); }} />}

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Runs</h2>
        {runs.data?.data.length === 0 && <p className="text-sm text-[var(--text-muted)]">Nothing repurposed yet.</p>}
        {runs.data?.data.map((r) => (
          <Card key={r.id} className="flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.source_ref.title}</span><Badge>{KIND[r.source_ref.sourceType ?? ""] ?? r.source_ref.sourceType ?? r.source_ref.kind}</Badge>
              <Badge tone={tone(r.status)}>{r.status}</Badge><span className="ml-auto text-xs text-[var(--text-muted)]">{new Date(r.created_at).toLocaleString()}</span>
            </div>
            {r.digest && <p className="text-sm text-[var(--text-muted)]">{r.digest.summary}</p>}
            <ul className="flex flex-wrap gap-2 text-xs">
              {r.outputs.map((x, i) => (
                <li key={i}>{x.contentItemId ? <Link className="rounded border border-[var(--border)] px-2 py-1 hover:border-[var(--accent)]" href={`/w/${workspaceId}/b/${brandId}/content/${x.contentItemId}`}>{o?.outputs.find((y) => y.id === x.outputId)?.label ?? x.outputId} →</Link>
                  : <span className={cn("rounded border px-2 py-1", x.status === "failed" ? "border-[var(--danger)] text-[var(--danger)]" : "border-dashed border-[var(--border)] text-[var(--text-muted)]")} title={x.error}>{o?.outputs.find((y) => y.id === x.outputId)?.label ?? x.outputId} · {x.status}</span>}</li>
              ))}
            </ul>
          </Card>
        ))}
      </section>
    </div>
  );
}

export default function RepurposePage() {
  return <Suspense><Repurpose /></Suspense>;
}
