"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Badge, Button, Card, EmptyState, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { MediaPicker } from "@/components/media/MediaPicker";
import { stageTone } from "@/components/services/format";

type Field = { key: string; label: string; type: "text" | "textarea" | "select"; required: boolean; max?: number; options?: string[] };
type Offering = { key: string; name: string; description: string; category: string; credits: number; turnaround_hours: number; included_revisions: number; extra_revision_credits: number; deliverable_kind: string; needs_source_content: boolean; intake_fields: Field[] };
type Req = { id: string; title: string; offering_key: string; status: string; stage: string; due_at: string | null; credits: number | null; updated_at: string };
const turnaround = (h: number) => (h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`);

function Services() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const router = useRouter();
  const pre = useSearchParams();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const offerings = useApi<{ data: Offering[] }>(`/workspaces/${workspaceId}/services/offerings`);
  const list = useApi<{ data: Req[] }>(`${base}/services`);
  const content = useApi<{ data: Array<{ id: string; title: string | null; type: string }> }>(`${base}/content?limit=50`);
  const [pick, setPick] = useState<string | null>(pre.get("offering"));
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [source, setSource] = useState(pre.get("content") ?? "");
  const [refs, setRefs] = useState<Array<{ id: string; title: string | null }>>([]);
  const [picker, setPicker] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const o = offerings.data?.data.find((x) => x.key === pick);

  async function create(submit: boolean) {
    if (!o) return;
    setBusy(true); setMsg(undefined); setErrors({});
    try {
      const r = await api<{ id: string }>(`${base}/services`, { method: "POST", body: JSON.stringify({ offeringKey: o.key, title: title || o.name, intake: values, sourceContentItemId: source || null, referenceAssetIds: refs.map((x) => x.id) }) });
      if (submit) await api(`${base}/services/${r.id}/submit`, { method: "POST", body: "{}" });
      router.push(`/w/${workspaceId}/b/${brandId}/services/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === "object") setErrors(e.details as Record<string, string>);
      setMsg({ err: true, text: e instanceof ApiError && e.code === "insufficient_credits" ? "Not enough credits for this service." : (e as Error).message });
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Services</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <p className="text-sm text-[var(--text-muted)]">Hand work to Arcatic's service team when it needs a human touch. You see the price before you submit; credits are held and only charged when you approve the delivery. Cancel any time before work starts.</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {offerings.data?.data.map((x) => (
          <button key={x.key} onClick={() => { setPick(x.key); setValues({}); setErrors({}); }} className="text-left">
            <Card className={cn("flex h-full flex-col gap-1 p-4 hover:border-[var(--accent)]", pick === x.key && "border-[var(--accent)]")}>
              <div className="flex items-center gap-2"><span className="font-medium">{x.name}</span><Badge>{x.category}</Badge></div>
              <p className="text-sm text-[var(--text-muted)]">{x.description}</p>
              <p className="mt-auto pt-2 text-xs"><b>{x.credits} credits</b> · about {turnaround(x.turnaround_hours)} · {x.included_revisions} revision{x.included_revisions === 1 ? "" : "s"} included</p>
            </Card>
          </button>
        ))}
      </div>

      {o && (
        <Card className="flex flex-col gap-3 text-sm">
          <h2 className="font-semibold">{o.name}</h2>
          <label className="flex flex-col gap-1">Title<Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={o.name} maxLength={200} /></label>
          {o.needs_source_content && (
            <label className="flex flex-col gap-1">Draft to finish
              <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Choose a draft…</option>
                {content.data?.data.map((c) => <option key={c.id} value={c.id}>{c.title ?? "Untitled"} · {c.type.replace(/_/g, " ")}</option>)}
              </select>
            </label>
          )}
          {o.intake_fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span>{f.label}{f.required && <span className="text-[var(--danger)]"> *</span>}</span>
              {f.type === "textarea" ? <textarea className="min-h-20 rounded border border-[var(--border)] bg-[var(--surface)] p-2" maxLength={f.max} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                : f.type === "select" ? <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}><option value="">Choose…</option>{f.options?.map((x) => <option key={x}>{x}</option>)}</select>
                : <Input maxLength={f.max} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
              {errors[f.key] && <span className="text-xs text-[var(--danger)]">{errors[f.key]}</span>}
            </label>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setPicker(true)}>Attach reference files</Button>
            {refs.map((r) => <Badge key={r.id}>{r.title ?? "file"}</Badge>)}
          </div>
          <p className="text-xs text-[var(--text-muted)]">The team sees this form, your Brand Kit essentials and the files you attach — not the rest of your workspace.</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void create(true)}>Submit · {o.credits} credits held</Button>
            <Button variant="ghost" disabled={busy} onClick={() => void create(false)}>Save as draft</Button>
          </div>
          {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
        </Card>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Requests</h2>
        {list.data?.data.length === 0 && <EmptyState title="No requests yet" body="Pick a service above." />}
        {list.data?.data.map((r) => (
          <Link key={r.id} href={`/w/${workspaceId}/b/${brandId}/services/${r.id}`}>
            <Card className="flex flex-wrap items-center gap-2 p-3 text-sm hover:border-[var(--accent)]">
              <span className="font-medium">{r.title}</span>
              <Badge>{offerings.data?.data.find((x) => x.key === r.offering_key)?.name ?? r.offering_key}</Badge>
              <Badge tone={stageTone(r.status)}>{r.stage}</Badge>
              {r.due_at && !["approved", "cancelled", "delivered", "draft"].includes(r.status) && <span className="text-xs text-[var(--text-muted)]">due {new Date(r.due_at).toLocaleDateString()}</span>}
              <span className="ml-auto text-xs text-[var(--text-muted)]">{new Date(r.updated_at).toLocaleString()}</span>
            </Card>
          </Link>
        ))}
      </section>
      {picker && <MediaPicker workspaceId={workspaceId} kinds={["image", "video", "audio"]} multiple title="Reference files" onClose={() => setPicker(false)} onPick={(a) => { setRefs(a.map((x) => ({ id: x.id, title: x.title }))); setPicker(false); }} />}
    </div>
  );
}

export default function ServicesPage() {
  return <Suspense><Services /></Suspense>;
}
