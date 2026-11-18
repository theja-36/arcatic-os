"use client";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CHANNELS, CONTENT_TYPES, canTransition, mondayOf, type CampaignStatus } from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";

type Topic = { id: string; title: string; angle: string | null; pillar: string | null; channel: string | null; content_type: string; planned_for: string | null; cta: string | null; notes: string | null; status: string; status_note: string | null; origin: string; content_item_id: string | null };
type Campaign = {
  id: string; name: string; goal: string | null; status: CampaignStatus; revision: number; starts_on: string | null; ends_on: string | null; channels: string[]; content_types: string[];
  review_window_hours: number; generation_schedule: { mode: "immediate" | "scheduled" | "manual"; leadDays: number; maxPerDay: number };
  brief: { theme: string; keyMessage: string; offer: string; cta: string; audience: string; kpis: string[] };
  last_runner_event: { message: string; at: string } | null; next_generation_at: string | null;
  topics: Topic[]; runner: { paused: boolean; generated: number; inFlight: number; lastEvent: string } | null;
};
const topicTone = (s: string) => (s === "done" ? "success" : s === "approved" ? "accent" : s === "failed" || s === "blocked" ? "danger" : s === "in_production" ? "warning" : "neutral");
const ACTIONS: Array<{ action: string; to: CampaignStatus; label: string; variant?: "primary" | "secondary" | "danger" | "ghost" }> = [
  { action: "start", to: "active", label: "Start", variant: "primary" },
  { action: "resume", to: "active", label: "Resume", variant: "primary" },
  { action: "pause", to: "paused", label: "Pause", variant: "secondary" },
  { action: "complete", to: "completed", label: "Mark complete", variant: "ghost" },
  { action: "cancel", to: "cancelled", label: "Cancel campaign", variant: "danger" },
];

export default function CampaignPage() {
  const { workspaceId, brandId, campaignId } = useParams<{ workspaceId: string; brandId: string; campaignId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const { data, reload, error } = useApi<Campaign>(`${base}/campaigns/${campaignId}`);
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const canEdit = ["owner", "admin", "editor"].includes(ws.data?.role ?? "");
  const [draft, setDraft] = useState<Campaign>();
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string>();
  const [adding, setAdding] = useState(false);

  useEffect(() => { if (data) setDraft(data); }, [data]);
  useEffect(() => {
    const ch = supabase().channel(`campaign:${campaignId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "campaign_topics", filter: `campaign_id=eq.${campaignId}` }, () => void reload())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "campaigns", filter: `id=eq.${campaignId}` }, () => void reload())
      .subscribe();
    return () => void supabase().removeChannel(ch);
  }, [campaignId, reload]);

  const weeks = useMemo(() => {
    const m = new Map<string, Topic[]>();
    for (const t of data?.topics ?? []) {
      const k = t.planned_for ? mondayOf(t.planned_for) : "unscheduled";
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data?.topics]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ text: ok });
      await reload();
    } catch (e) {
      setMsg({ err: true, text: e instanceof ApiError && e.code === "conflict" ? `${e.message}` : (e as Error).message });
    }
  };

  if (error) return <p className="text-sm text-[var(--danger)]">{error}</p>;
  if (!data || !draft) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  const closed = data.status === "completed" || data.status === "cancelled";
  const dirty = JSON.stringify({ ...draft, topics: [], runner: null }) !== JSON.stringify({ ...data, topics: [], runner: null });

  async function saveSettings() {
    await run(() => api(`${base}/campaigns/${campaignId}`, { method: "PATCH", body: JSON.stringify({
      revision: data!.revision, name: draft!.name, goal: draft!.goal, startsOn: draft!.starts_on, endsOn: draft!.ends_on, channels: draft!.channels,
      contentTypes: draft!.content_types, reviewWindowHours: draft!.review_window_hours, generationSchedule: draft!.generation_schedule, brief: draft!.brief,
    }) }), "Saved.");
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">{data.name}</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>

      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Badge tone={data.status === "active" ? "success" : data.status === "paused" ? "warning" : data.status === "cancelled" ? "danger" : "accent"}>{data.status}</Badge>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {data.runner ? `${data.runner.paused ? "Paused" : data.runner.inFlight ? `Generating ${data.runner.inFlight} draft(s)` : data.runner.lastEvent} · ${data.runner.generated} drafted` : data.last_runner_event?.message ?? (data.status === "active" ? "Scheduler starting…" : "Not running")}
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {ACTIONS.filter((a) => canTransition(data.status, a.to) && !(a.action === "start" && data.status === "paused") && !(a.action === "resume" && data.status !== "paused")).map((a) => (
              <Button key={a.action} variant={a.variant} onClick={() => { if (a.action !== "cancel" || confirm("Cancel this campaign? Drafts in progress stop and unused topics are dropped.")) void run(() => api(`${base}/campaigns/${campaignId}/${a.action}`, { method: "POST" }), `Campaign ${a.to}.`); }}>{a.label}</Button>
            ))}
          </div>
        )}
      </Card>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      <Card className="grid gap-3 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Brief & schedule</h2>
        {([["theme", "Theme"], ["keyMessage", "Key message"]] as const).map(([k, label]) => (
          <label key={k} className="flex flex-col gap-1 text-sm sm:col-span-2">{label}
            <textarea disabled={!canEdit || closed} className="min-h-16 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2" value={draft.brief[k]} onChange={(e) => setDraft({ ...draft, brief: { ...draft.brief, [k]: e.target.value } })} />
          </label>
        ))}
        {([["offer", "Offer"], ["cta", "Call to action"], ["audience", "Audience"]] as const).map(([k, label]) => (
          <label key={k} className="flex flex-col gap-1 text-sm">{label}<Input disabled={!canEdit || closed} value={draft.brief[k]} onChange={(e) => setDraft({ ...draft, brief: { ...draft.brief, [k]: e.target.value } })} /></label>
        ))}
        <label className="flex flex-col gap-1 text-sm">Goal<Input disabled={!canEdit || closed} value={draft.goal ?? ""} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-sm">Starts<Input type="date" disabled={!canEdit || closed} value={draft.starts_on ?? ""} onChange={(e) => setDraft({ ...draft, starts_on: e.target.value || null })} /></label>
        <label className="flex flex-col gap-1 text-sm">Ends<Input type="date" disabled={!canEdit || closed} value={draft.ends_on ?? ""} onChange={(e) => setDraft({ ...draft, ends_on: e.target.value || null })} /></label>
        <div className="flex flex-col gap-1 text-sm sm:col-span-2">Channels
          <div className="flex flex-wrap gap-2">{CHANNELS.filter((c) => c !== "website").map((c) => (
            <label key={c} className="flex items-center gap-1"><input type="checkbox" disabled={!canEdit || closed} checked={draft.channels.includes(c)} onChange={(e) => setDraft({ ...draft, channels: e.target.checked ? [...draft.channels, c] : draft.channels.filter((x) => x !== c) })} />{c}</label>
          ))}</div>
        </div>
        <label className="flex flex-col gap-1 text-sm">Draft generation
          <select disabled={!canEdit || closed} className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={draft.generation_schedule.mode} onChange={(e) => setDraft({ ...draft, generation_schedule: { ...draft.generation_schedule, mode: e.target.value as never } })}>
            <option value="scheduled">Before each post's date</option><option value="immediate">As soon as topics are approved</option><option value="manual">Only when I click Generate</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">Days ahead / max per day
          <div className="flex gap-2">
            <Input type="number" min={0} max={30} disabled={!canEdit || closed} value={draft.generation_schedule.leadDays} onChange={(e) => setDraft({ ...draft, generation_schedule: { ...draft.generation_schedule, leadDays: Number(e.target.value) } })} aria-label="Lead days" />
            <Input type="number" min={1} max={50} disabled={!canEdit || closed} value={draft.generation_schedule.maxPerDay} onChange={(e) => setDraft({ ...draft, generation_schedule: { ...draft.generation_schedule, maxPerDay: Number(e.target.value) } })} aria-label="Max per day" />
          </div>
        </label>
        <label className="flex flex-col gap-1 text-sm">Review window (hours)<Input type="number" min={0} disabled={!canEdit || closed} value={draft.review_window_hours} onChange={(e) => setDraft({ ...draft, review_window_hours: Number(e.target.value) })} /></label>
        {canEdit && !closed && dirty && <div className="flex gap-2 sm:col-span-2"><Button onClick={saveSettings}>Save</Button><Button variant="ghost" onClick={() => setDraft(data)}>Discard</Button></div>}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Topics</h2>
        {canEdit && !closed && (
          <div className="flex flex-wrap gap-2">
            {selected.size > 0 && (<>
              <Button variant="secondary" onClick={() => run(() => api(`${base}/campaigns/${campaignId}/topics/bulk`, { method: "POST", body: JSON.stringify({ ids: [...selected], action: "approve" }) }).then(() => setSelected(new Set())), "Approved.")}>Approve {selected.size}</Button>
              <Button variant="ghost" onClick={() => run(() => api(`${base}/campaigns/${campaignId}/topics/bulk`, { method: "POST", body: JSON.stringify({ ids: [...selected], action: "reset" }) }).then(() => setSelected(new Set())), "Ready to retry.")}>Retry</Button>
              <Button variant="ghost" onClick={() => run(() => api(`${base}/campaigns/${campaignId}/topics/bulk`, { method: "POST", body: JSON.stringify({ ids: [...selected], action: "drop" }) }).then(() => setSelected(new Set())), "Dropped.")}>Drop</Button>
            </>)}
            <Button variant="secondary" onClick={() => setAdding((x) => !x)}>{adding ? "Close" : "Add topic"}</Button>
          </div>
        )}
      </div>
      {adding && <TopicForm channels={data.channels.length ? data.channels : [...CHANNELS]} onSubmit={(t) => run(() => api(`${base}/campaigns/${campaignId}/topics`, { method: "POST", body: JSON.stringify(t) }).then(() => setAdding(false)), "Topic added.")} />}
      {weeks.length === 0 && <p className="text-sm text-[var(--text-muted)]">No topics yet. Plan weeks from the Strategy page, or add topics here.</p>}
      {weeks.map(([week, topics]) => (
        <section key={week} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-[var(--text-muted)]">{week === "unscheduled" ? "Unscheduled" : `Week of ${week}`}</h3>
          <Card className="divide-y divide-[var(--border)] p-0">
            {topics.map((t) => editing === t.id ? (
              <div key={t.id} className="p-3"><TopicForm initial={t} channels={data.channels.length ? data.channels : [...CHANNELS]} onCancel={() => setEditing(undefined)}
                onSubmit={(v) => run(() => api(`${base}/topics/${t.id}`, { method: "PATCH", body: JSON.stringify(v) }).then(() => setEditing(undefined)), "Saved.")} /></div>
            ) : (
              <div key={t.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
                {canEdit && !closed && <input type="checkbox" className="mt-1" aria-label={`Select ${t.title}`} checked={selected.has(t.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })} />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.title}</span>
                    <Badge tone={topicTone(t.status)}>{t.status.replace("_", " ")}</Badge>
                    <Badge>{t.channel} · {t.content_type.replace("_", " ")}</Badge>
                    {t.planned_for && <span className="text-xs text-[var(--text-muted)]">{t.planned_for}</span>}
                  </div>
                  {t.angle && <p className="text-sm text-[var(--text-muted)]">{t.angle}</p>}
                  {t.status_note && <p className={cn("text-xs", t.status === "blocked" || t.status === "failed" ? "text-[var(--danger)]" : "text-[var(--warning)]")}>{t.status_note}</p>}
                </div>
                {canEdit && !closed && (
                  <div className="flex shrink-0 gap-1">
                    {["idea", "approved", "failed", "blocked"].includes(t.status) && <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEditing(t.id)}>Edit</Button>}
                    {["approved", "done", "failed"].includes(t.status) && (
                      <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => run(() => api(`${base}/topics/${t.id}/generate`, { method: "POST", idempotencyKey: crypto.randomUUID() }), "Generating a draft…")}>
                        {t.content_item_id ? "Regenerate" : "Generate now"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}

function TopicForm({ initial, channels, onSubmit, onCancel }: { initial?: Partial<Topic>; channels: readonly string[]; onSubmit: (t: Record<string, unknown>) => void; onCancel?: () => void }) {
  const [t, setT] = useState({
    title: initial?.title ?? "", angle: initial?.angle ?? "", channel: initial?.channel ?? channels[0] ?? "instagram", contentType: initial?.content_type ?? "social_post",
    plannedFor: initial?.planned_for ?? new Date().toISOString().slice(0, 10), cta: initial?.cta ?? "", notes: initial?.notes ?? "",
  });
  return (
    <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...t, angle: t.angle || undefined, cta: t.cta || undefined, notes: t.notes || undefined }); }}>
      <Input required placeholder="Topic title" value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} aria-label="Title" className="sm:col-span-2" />
      <textarea placeholder="Angle: what the post says and why it matters" className="min-h-16 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm sm:col-span-2" value={t.angle} onChange={(e) => setT({ ...t, angle: e.target.value })} aria-label="Angle" />
      <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={t.channel} onChange={(e) => setT({ ...t, channel: e.target.value })} aria-label="Channel">{channels.map((c) => <option key={c}>{c}</option>)}</select>
      <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={t.contentType} onChange={(e) => setT({ ...t, contentType: e.target.value })} aria-label="Format">{CONTENT_TYPES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select>
      <Input type="date" value={t.plannedFor} onChange={(e) => setT({ ...t, plannedFor: e.target.value })} aria-label="Date" />
      <Input placeholder="CTA (optional)" value={t.cta} onChange={(e) => setT({ ...t, cta: e.target.value })} aria-label="CTA" />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit">Save</Button>{onCancel && <Button variant="ghost" type="button" onClick={onCancel}>Cancel</Button>}</div>
    </form>
  );
}
