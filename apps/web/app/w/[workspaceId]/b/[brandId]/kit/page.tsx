"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { applyKitOps, BrandKitSchema, estimateCredits, type AnyFact, type BrandKit, type KitOp } from "@arcatic/core";
import { Badge, Button, Card, Input, ProgressBar, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { FactCard } from "@/components/kit/FactCard";
import { ListSection } from "@/components/kit/ListSection";
import { History } from "@/components/kit/History";
import { TABS } from "@/components/kit/fields";
import { BrandTabs } from "@/components/BrandTabs";

type KitResponse = {
  brand: { id: string; name: string; websiteUrl: string | null };
  version: number;
  status: "draft" | "approved" | "superseded" | null;
  note: string | null;
  kit: BrandKit;
  completeness: { score: number; missing: Array<{ key: string; label: string }>; pendingSuggestions: number };
  active: { id: string; version: number } | null;
  runningAnalysis: { id: string; status: string; progress: number } | null;
};
type Job = { status: string; progress: number; error: { message: string } | null; events: Array<{ message: string | null }> };

export default function BrandKitPage() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const { data, reload, error } = useApi<KitResponse>(`${base}/kit`);
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const canEdit = ["owner", "admin", "editor"].includes(ws.data?.role ?? "");

  const [tab, setTab] = useState("profile");
  const [pending, setPending] = useState<KitOp[]>([]);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string }>();
  const [saving, setSaving] = useState(false);
  const [analysisJob, setAnalysisJob] = useState<string | null>(null);

  // preview = server kit + unsaved ops, using the same pure function the API runs
  const preview = useMemo(() => {
    if (!data) return undefined;
    try {
      return applyKitOps(BrandKitSchema.parse(data.kit), pending, { now: new Date().toISOString(), newId: () => crypto.randomUUID().slice(0, 8) }).kit;
    } catch (e) {
      return BrandKitSchema.parse(data.kit);
    }
  }, [data, pending]);

  useEffect(() => {
    if (data?.runningAnalysis) setAnalysisJob(data.runningAnalysis.id);
  }, [data?.runningAnalysis]);

  const queue = (ops: KitOp[]) => {
    try {
      applyKitOps(preview!, ops, { now: new Date().toISOString(), newId: () => "x" });
      setPending((p) => [...p, ...ops]);
      setMsg(undefined);
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    }
  };

  async function save() {
    if (!data || !pending.length) return;
    setSaving(true);
    try {
      await api(`${base}/kit/ops`, { method: "POST", body: JSON.stringify({ baseVersion: data.version, ops: pending }) });
      setPending([]);
      setMsg({ tone: "ok", text: "Saved as a new draft version." });
      await reload();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof ApiError && e.code === "conflict" ? "Someone else changed this Brand Kit. Reload to see their changes (your unsaved edits will be lost)." : (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function approve() {
    if (!data) return;
    try {
      const r = await api<{ unreviewedSuggestions: number; impact: { affectedContent: unknown[] } }>(`${base}/kit/versions/${data.version}/approve`, { method: "POST" });
      setMsg({
        tone: "ok",
        text: `Version ${data.version} is now active.${r.unreviewedSuggestions ? ` ${r.unreviewedSuggestions} unreviewed suggestion(s) are not used until you approve them.` : ""}${r.impact.affectedContent.length ? ` ${r.impact.affectedContent.length} draft(s) were written with the old details and can be regenerated.` : ""}`,
      });
      await reload();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    }
  }

  if (error) return <p className="text-sm text-[var(--danger)]">{error}</p>;
  if (!data || !preview) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;

  const facts = preview.facts as Record<string, AnyFact>;
  const isActive = data.active?.version === data.version;
  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-[var(--text-muted)]"><Link href={`/w/${workspaceId}/brands`} className="hover:underline">Brands</Link> /</p>
          <h1 className="text-xl font-semibold">{data.brand.name} · Brand Kit</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            {data.version === 0 ? <Badge>not started</Badge> : <Badge tone={isActive ? "success" : "warning"}>{isActive ? `v${data.version} active` : `v${data.version} draft`}</Badge>}
            {data.active && !isActive && <span className="text-[var(--text-muted)]">Generation uses v{data.active.version} until you approve this draft.</span>}
            {!data.active && data.version > 0 && <span className="text-[var(--text-muted)]">Approve a version before generating content.</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/w/${workspaceId}/b/${brandId}/onboarding`}><Button variant="ghost">Onboarding answers</Button></Link>
          {canEdit && <AnalyzeButton base={base} defaultUrl={data.brand.websiteUrl} onStarted={setAnalysisJob} />}
          {canEdit && data.version > 0 && !isActive && !pending.length && <Button onClick={approve}>Approve v{data.version}</Button>}
        </div>
      </div>

      <BrandTabs workspaceId={workspaceId} brandId={brandId} />

      {analysisJob && <AnalysisProgress workspaceId={workspaceId} jobId={analysisJob} onDone={() => { setAnalysisJob(null); void reload(); }} />}

      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex-1">
          <div className="mb-1 flex justify-between text-sm"><span className="font-medium">Brand Kit {data.completeness.score}% complete</span>
            {data.completeness.pendingSuggestions > 0 && <span className="text-[var(--accent)]">{data.completeness.pendingSuggestions} suggestion(s) to review</span>}</div>
          <ProgressBar value={data.completeness.score} />
          {data.completeness.missing.length > 0 && <p className="mt-2 text-xs text-[var(--text-muted)]">Still needed: {data.completeness.missing.slice(0, 6).map((m) => m.label).join(", ")}{data.completeness.missing.length > 6 ? "…" : ""}</p>}
        </div>
      </Card>

      {msg && <p className={cn("text-sm", msg.tone === "err" ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      <nav className="flex gap-1 overflow-x-auto border-b border-[var(--border)]" aria-label="Brand Kit sections">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm", tab === t.id ? "border-[var(--accent)] font-medium" : "border-transparent text-[var(--text-muted)]")}>
            {t.label}
          </button>
        ))}
      </nav>

      {current.fields && (
        <div className="grid gap-3 lg:grid-cols-2">
          {current.fields.map((f) => <FactCard key={f.path} def={f} fact={facts[f.path]} canEdit={canEdit} onOps={queue} />)}
          {tab === "channels" && (
            <Card>
              <h3 className="mb-2 text-sm font-medium">Languages & claims</h3>
              <p className="text-sm">Primary: {preview.languages.primary} · Supported: {preview.languages.supported.join(", ")}</p>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={!canEdit} checked={preview.claimsPolicy === "strict"} onChange={(e) => queue([{ op: "set_meta", claimsPolicy: e.target.checked ? "strict" : "relaxed" }])} />
                Strict claims: numbers and prices must cite a source
              </label>
            </Card>
          )}
        </div>
      )}
      {(tab === "audiences" || tab === "offers") && <ListSection list={tab} facts={preview[tab] as AnyFact[]} canEdit={canEdit} onOps={queue} />}
      {tab === "history" && <History base={base} onChanged={reload} />}

      {pending.length > 0 && (
        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-lg">
          <span className="text-sm">{pending.length} unsaved change(s)</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setPending([])}>Discard</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save draft"}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AnalyzeButton({ base, defaultUrl, onStarted }: { base: string; defaultUrl: string | null; onStarted: (jobId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(defaultUrl ?? "");
  const [attest, setAttest] = useState(false);
  const [pages, setPages] = useState(12);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ job: { id: string } }>(`${base}/kit/analyze-website`, {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        body: JSON.stringify({ url, attestOwnership: attest || undefined, maxPages: pages }),
      });
      onStarted(r.job.id);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "insufficient_credits" ? "Not enough credits for this analysis." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Analyse website</Button>;
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="Analyse website">
      <Card className="w-full max-w-md">
        <form onSubmit={start} className="flex flex-col gap-3">
          <h2 className="font-semibold">Analyse website</h2>
          <p className="text-sm text-[var(--text-muted)]">Reads your home, about, services, pricing, FAQ and contact pages and suggests Brand Kit facts with the quote each one came from. Nothing you've approved is overwritten.</p>
          <Input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourbusiness.in" aria-label="Website URL" />
          <label className="flex items-center gap-2 text-sm">Pages to read
            <select className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={pages} onChange={(e) => setPages(Number(e.target.value))}>
              {[5, 8, 12, 20].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="text-[var(--text-muted)]">≈ {cost(pages).estimate} credits (up to {cost(pages).max} held)</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={attest} onChange={(e) => setAttest(e.target.checked)} required />
            I own this website or am authorised to analyse it.
          </label>
          {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !attest}>{busy ? "Starting…" : "Start analysis"}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
/** Same formula the API uses to reserve credits. */
const cost = (pages: number) => {
  const a = estimateCredits({ kind: "ingest.url", quantity: pages });
  const b = estimateCredits({ kind: "brand.extract" });
  return { estimate: +(a.estimate + b.estimate).toFixed(2), max: +(a.max + b.max).toFixed(2) };
};

function AnalysisProgress({ workspaceId, jobId, onDone }: { workspaceId: string; jobId: string; onDone: () => void }) {
  const [job, setJob] = useState<Job>();
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const j = await api<Job>(`/workspaces/${workspaceId}/jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        if (j.status === "succeeded") done.current();
      } catch {
        /* keep last state */
      }
    };
    void load();
    const ch = supabase().channel(`job:${jobId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "generation_jobs", filter: `id=eq.${jobId}` }, () => void load())
      .subscribe();
    const t = setInterval(load, 5000);   // fallback if Realtime is unavailable
    return () => {
      stop = true;
      clearInterval(t);
      void supabase().removeChannel(ch);
    };
  }, [workspaceId, jobId]);

  if (!job || job.status === "succeeded") return null;
  const last = [...job.events].reverse().find((e) => e.message)?.message;
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium">{job.status === "failed" ? "Website analysis failed" : job.status === "cancelled" ? "Analysis cancelled" : "Analysing website…"}</span>
        <span className="text-[var(--text-muted)]">{job.progress}%</span>
      </div>
      <ProgressBar value={job.progress} />
      <p className="mt-2 text-xs text-[var(--text-muted)]">{job.error?.message ?? last}</p>
      {job.status === "failed" && <p className="mt-1 text-xs">No credits were charged for the failed run.</p>}
    </Card>
  );
}
