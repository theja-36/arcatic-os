"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CONTENT_TYPE_DEFS, missingFields, wizardById, wizardDefaults, wizardToRequest, type WizardField, type WizardValues } from "@arcatic/core";
import { Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { JobProgress } from "@/components/plan/JobProgress";
import { MediaPicker } from "@/components/media/MediaPicker";
import { useSignedUrl } from "@/lib/media";

function ImageField({ workspaceId, value, onChange }: { workspaceId: string; value?: string; onChange: (id: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const url = useSignedUrl(workspaceId, value);
  return (
    <div className="flex items-center gap-2">
      {url && <img src={url} alt="" className="h-14 w-14 rounded object-cover" />}
      <Button type="button" variant="secondary" className="h-8 px-3 text-xs" onClick={() => setOpen(true)}>{value ? "Change photo" : "Choose photo"}</Button>
      {value && <Button type="button" variant="ghost" className="h-8 px-2 text-xs" onClick={() => onChange(undefined)}>Remove</Button>}
      {open && <MediaPicker workspaceId={workspaceId} kinds={["image"]} title="Choose a background photo" onClose={() => setOpen(false)} onPick={(a) => { onChange(a[0]?.id); setOpen(false); }} />}
    </div>
  );
}

function Wizard() {
  const { workspaceId, brandId, wizardId } = useParams<{ workspaceId: string; brandId: string; wizardId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const w = wizardById(wizardId);
  const [v, setV] = useState<WizardValues>(() => (w ? { ...wizardDefaults(w), ...(search.get("project") && { __project: search.get("project") }) } : {}));
  const [step, setStep] = useState(0);
  const [missing, setMissing] = useState<string[]>([]);
  const [cost, setCost] = useState<{ estimate: number; max: number }>();
  const [job, setJob] = useState<string>();
  const [err, setErr] = useState("");
  const brand = useApi<{ languages: string[] }>(base);
  const sources = useApi<{ data: Array<{ id: string; title: string; type: string }> }>(`${base}/sources?limit=100&status=ready`);
  const projects = useApi<{ data: Array<{ id: string; name: string }> }>(`${base}/projects`);
  useEffect(() => { if (brand.data?.languages?.[0] && v.language === "en") setV((x) => ({ ...x, language: brand.data!.languages[0] })); }, [brand.data]);  // eslint-disable-line react-hooks/exhaustive-deps
  const type = String(v.__type ?? w?.type ?? "");
  useEffect(() => {
    if (!type) return;
    api<{ estimate: number; max: number }>(`${base}/content/estimate`, { method: "POST", body: JSON.stringify({ type }) }).then(setCost).catch(() => setCost(undefined));
  }, [base, type]);

  if (!w || !w.steps.length) return <p className="text-sm">Unknown guide. <Link className="text-[var(--accent)]" href={`/w/${workspaceId}/b/${brandId}/create`}>Back to Create</Link></p>;
  const steps = w.steps;
  const last = step === steps.length - 1;
  const set = (k: string, val: unknown) => setV((x) => ({ ...x, [k]: val }));

  function next() {
    const m = missingFields(steps[step]!, v);
    setMissing(m);
    if (m.length) return;
    if (!last) setStep(step + 1);
    else void generate();
  }
  async function generate() {
    setErr("");
    try {
      const req = wizardToRequest(w!, v);
      const r = await api<{ job: { id: string } }>(`${base}/content`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify(req) });
      setJob(r.job.id);
    } catch (e) {
      const details = e instanceof ApiError && Array.isArray(e.details) ? ` (${(e.details as Array<{ path: string; message: string }>).map((d) => `${d.path}: ${d.message}`).join("; ")})` : "";
      setErr(e instanceof ApiError && e.code === "insufficient_credits" ? "Not enough credits." : `${(e as Error).message}${details}`);
    }
  }

  const field = (f: WizardField) => {
    const bad = missing.includes(f.key);
    const label = <span className="font-medium">{f.label}{f.required && <span className="text-[var(--danger)]"> *</span>}</span>;
    const help = f.help && <span className="text-xs text-[var(--text-muted)]">{f.help}</span>;
    const cls = cn(bad && "border-[var(--danger)]");
    switch (f.kind) {
      case "textarea":
        return <label key={f.key} className="flex flex-col gap-1 text-sm sm:col-span-2">{label}<textarea className={cn("min-h-24 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2", cls)} maxLength={f.maxLength} placeholder={f.placeholder} value={String(v[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />{help}</label>;
      case "number":
        return <label key={f.key} className="flex flex-col gap-1 text-sm">{label}<Input type="number" min={f.min} max={f.max} value={Number(v[f.key] ?? f.default ?? 0)} onChange={(e) => set(f.key, Number(e.target.value))} className={cls} />{help}</label>;
      case "select": case "language":
        return <label key={f.key} className="flex flex-col gap-1 text-sm">{label}<select className={cn("h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2", cls)} value={String(v[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
          {f.kind === "language" ? (f.options ?? []).filter(([k]) => !brand.data || brand.data.languages.includes(k) || k === "en").map(([k, l]) => <option key={k} value={k}>{l}</option>) : f.options?.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>{help}</label>;
      case "multiselect": {
        const cur = (v[f.key] as string[] | undefined) ?? [];
        return <fieldset key={f.key} className="flex flex-col gap-1 text-sm sm:col-span-2"><legend className="mb-1">{label}</legend><div className="flex flex-wrap gap-2">
          {f.options?.map(([k, l]) => <button key={k} type="button" aria-pressed={cur.includes(k)} onClick={() => set(f.key, cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k])} className={cn("rounded-full border px-3 py-1 text-xs", cur.includes(k) ? "border-[var(--accent)] bg-[var(--surface-2)] font-medium" : "border-[var(--border)]")}>{l}</button>)}
        </div>{help}</fieldset>;
      }
      case "sources": {
        const cur = (v[f.key] as string[] | undefined) ?? [];
        return <fieldset key={f.key} className="flex flex-col gap-1 text-sm sm:col-span-2"><legend className="mb-1">{label}</legend>
          {sources.data?.data.length ? <div className="flex max-h-40 flex-col gap-1 overflow-auto rounded border border-[var(--border)] p-2">
            {sources.data.data.map((s) => <label key={s.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={cur.includes(s.id)} onChange={(e) => set(f.key, e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id))} /> {s.title} <span className="text-[var(--text-muted)]">({s.type})</span></label>)}
          </div> : <span className="text-xs text-[var(--text-muted)]">No Knowledge sources yet.</span>}{help}</fieldset>;
      }
      case "image":
        return <div key={f.key} className="flex flex-col gap-1 text-sm">{label}<ImageField workspaceId={workspaceId} value={v[f.key] as string | undefined} onChange={(id) => set(f.key, id)} /></div>;
      case "toggle":
        return <label key={f.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v[f.key]} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}</label>;
      default:
        return <label key={f.key} className="flex flex-col gap-1 text-sm">{label}<Input maxLength={f.maxLength} placeholder={f.placeholder} value={String(v[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} className={cls} />{help}</label>;
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold"><Link href={`/w/${workspaceId}/b/${brandId}/create`} className="text-[var(--text-muted)] hover:underline">Create</Link> / {w.label}</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Steps">
        {steps.map((s, i) => <li key={s.title} className={cn("rounded-full border px-3 py-1", i === step ? "border-[var(--accent)] font-medium" : i < step ? "border-[var(--border)] text-[var(--text-muted)]" : "border-dashed border-[var(--border)] text-[var(--text-muted)]")}>{i + 1}. {s.title}</li>)}
      </ol>
      <Card className="flex flex-col gap-4">
        {step === 0 && w.typeChoice && (
          <div className="flex gap-2" role="radiogroup" aria-label="Kind">
            {w.typeChoice.map(([t, l]) => <button key={t} type="button" role="radio" aria-checked={v.__type === t} onClick={() => set("__type", t)} className={cn("rounded-md border px-3 py-1.5 text-sm", v.__type === t ? "border-[var(--accent)] bg-[var(--surface-2)] font-medium" : "border-[var(--border)]")}>{l}</button>)}
          </div>
        )}
        <h2 className="font-semibold">{steps[step]!.title}</h2>
        <div className="grid gap-3 sm:grid-cols-2">{steps[step]!.fields.map(field)}</div>
        {last && (
          <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3 text-sm">
            <label className="flex items-center gap-2"><span>File in project</span>
              <select className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-2" value={String(v.__project ?? "")} onChange={(e) => set("__project", e.target.value || undefined)}>
                <option value="">None</option>{projects.data?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <span className="text-[var(--text-muted)]">{CONTENT_TYPE_DEFS[type as keyof typeof CONTENT_TYPE_DEFS]?.label}: {cost ? `about ${cost.estimate} credit${cost.estimate === 1 ? "" : "s"} (up to ${cost.max} held)` : "…"}</span>
          </div>
        )}
        {missing.length > 0 && <p className="text-sm text-[var(--danger)]">Please fill in the marked fields.</p>}
        {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
        <div className="flex gap-2">
          {step > 0 && <Button variant="secondary" onClick={() => { setMissing([]); setStep(step - 1); }} disabled={!!job}>Back</Button>}
          <Button onClick={next} disabled={!!job}>{last ? "Write the draft" : "Next"}</Button>
        </div>
      </Card>
      {job && <JobProgress workspaceId={workspaceId} jobId={job} label="Writing" onDone={(j) => {
        const out = j.output as { contentItemId?: string } | null;
        if (j.status === "succeeded" && out?.contentItemId) router.push(`/w/${workspaceId}/b/${brandId}/content/${out.contentItemId}`);
        else setJob(undefined);
      }} />}
    </div>
  );
}

export default function WizardPage() {
  return <Suspense><Wizard /></Suspense>;
}
