"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CHANNELS, CONTENT_TYPES, StrategyPlanSchema, addDays, checkPlan, nextMonday, type StrategyPlan } from "@arcatic/core";
import { Badge, Button, Card, EmptyState, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { JobProgress } from "@/components/plan/JobProgress";
import { RowsEditor } from "@/components/plan/RowsEditor";

type StrategyRow = { id: string; title: string; status: string; starts_on: string; ends_on: string; revision: number; generation_job_id: string | null; activated_at: string | null };
type Strategy = StrategyRow & { plan: StrategyPlan | null; validation: { notes?: string[]; error?: string } | null; issues: string[] };
const uid = () => crypto.randomUUID().slice(0, 8);

function NewStrategy({ base, defaultChannels, onStarted }: { base: string; defaultChannels: string[]; onStarted: (strategyId: string, jobId: string) => void }) {
  const [channels, setChannels] = useState<string[]>(defaultChannels);
  const [startsOn, setStartsOn] = useState(nextMonday(addDays(new Date().toISOString().slice(0, 10), 1)));
  const [weeks, setWeeks] = useState(13);
  const [goals, setGoals] = useState("");
  const [constraints, setConstraints] = useState("");
  const [focus, setFocus] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setChannels(defaultChannels), [defaultChannels]);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ strategy: { id: string }; job: { id: string } }>(`${base}/strategies`, {
        method: "POST", idempotencyKey: crypto.randomUUID(),
        body: JSON.stringify({ startsOn, weeks, channels, goals: goals.split("\n").map((g) => g.trim()).filter(Boolean), constraints: constraints || undefined, focus: focus || undefined }),
      });
      onStarted(r.strategy.id, r.job.id);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "insufficient_credits" ? "Not enough credits (a strategy uses about 10)." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <form onSubmit={go} className="grid gap-4 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">New marketing strategy</h2>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Start (Monday)</span><Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Length</span>
          <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            <option value={4}>4 weeks</option><option value={8}>8 weeks</option><option value={13}>13 weeks (90 days)</option><option value={26}>26 weeks</option>
          </select>
        </label>
        <div className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="font-medium">Channels</span>
          <div className="flex flex-wrap gap-2">{CHANNELS.filter((c) => c !== "website").map((c) => (
            <button type="button" key={c} aria-pressed={channels.includes(c)} onClick={() => setChannels((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))}
              className={cn("rounded-full border px-3 py-1 text-sm", channels.includes(c) ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)]")}>{c}</button>
          ))}</div>
        </div>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Goals (optional, one per line)</span><textarea className="min-h-20 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2" value={goals} onChange={(e) => setGoals(e.target.value)} placeholder="Defaults to your onboarding goals" /></label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Constraints</span><textarea className="min-h-20 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2" value={constraints} onChange={(e) => setConstraints(e.target.value)} placeholder="Budget, team time, things to avoid" /></label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="font-medium">Anything specific?</span><Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="e.g. launch the new lunch subscription in February" /></label>
        {err && <p className="text-sm text-[var(--danger)] sm:col-span-2">{err}</p>}
        <div className="sm:col-span-2"><Button type="submit" disabled={busy || !channels.length}>{busy ? "Starting…" : "Generate strategy (≈10 credits)"}</Button></div>
      </form>
    </Card>
  );
}

function Section({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3">
      <div><h3 className="font-semibold">{title}</h3>{hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}</div>
      {children}
    </Card>
  );
}

function Editor({ base, workspaceId, strategy, canEdit, onSaved }: { base: string; workspaceId: string; strategy: Strategy; canEdit: boolean; onSaved: () => void }) {
  const [plan, setPlan] = useState<StrategyPlan>(strategy.plan!);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [weekStart, setWeekStart] = useState(strategy.plan!.weeks.find((w) => w.weekStart >= nextMonday(new Date().toISOString().slice(0, 10)))?.weekStart ?? strategy.plan!.weeks[0]?.weekStart ?? "");
  const [weeksToPlan, setWeeksToPlan] = useState(1);
  const [autoApprove, setAutoApprove] = useState(false);
  const [planJob, setPlanJob] = useState<string>();
  useEffect(() => { setPlan(strategy.plan!); setDirty(false); }, [strategy.revision, strategy.plan]);
  const update = <K extends keyof StrategyPlan>(k: K, v: StrategyPlan[K]) => { setPlan((p) => ({ ...p, [k]: v })); setDirty(true); };
  const issues = useMemo(() => checkPlan(plan, { startsOn: strategy.starts_on, endsOn: strategy.ends_on }), [plan, strategy.starts_on, strategy.ends_on]);
  const channelsInPlan = useMemo(() => [...new Set(plan.channelMix.map((m) => m.channel))], [plan.channelMix]);
  const ro = !canEdit;

  async function save() {
    try {
      const parsed = StrategyPlanSchema.parse(plan);
      const r = await api<{ revision: number; warnings: string[] }>(`${base}/strategies/${strategy.id}/plan`, { method: "PUT", body: JSON.stringify({ revision: strategy.revision, plan: parsed }) });
      setMsg({ text: `Saved (revision ${r.revision}).${r.warnings.length ? ` Note: ${r.warnings.join(" ")}` : ""}` });
      setDirty(false);
      onSaved();
    } catch (e) {
      const details = e instanceof ApiError && Array.isArray(e.details) ? ` ${(e.details as Array<{ message: string }>).map((d) => d.message).join(" ")}` : "";
      setMsg({ err: true, text: e instanceof ApiError && e.code === "conflict" ? "Someone else saved this strategy. Reload to see their changes." : `${(e as Error).message}${details}` });
    }
  }
  async function activate() {
    try {
      const r = await api<{ campaigns: { created: number; kept: number } }>(`${base}/strategies/${strategy.id}/activate`, { method: "POST" });
      setMsg({ text: `Strategy is active. ${r.campaigns.created} campaign(s) created${r.campaigns.kept ? `, ${r.campaigns.kept} kept as you edited them` : ""}.` });
      onSaved();
    } catch (e) {
      setMsg({ err: true, text: (e as Error).message });
    }
  }
  async function planWeeks() {
    try {
      const r = await api<{ job: { id: string } }>(`${base}/strategies/${strategy.id}/weekly-plan`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ weekStart, weeks: weeksToPlan, autoApprove }) });
      setPlanJob(r.job.id);
    } catch (e) {
      setMsg({ err: true, text: (e as Error).message });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {strategy.validation?.notes?.length ? (
        <Card className="border-[var(--warning)]">
          <p className="mb-1 text-sm font-medium">Adjusted automatically</p>
          <ul className="list-disc pl-5 text-sm text-[var(--text-muted)]">{strategy.validation.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </Card>
      ) : null}

      <Section title="Summary & positioning">
        <textarea disabled={ro} className="min-h-24 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={plan.summary} onChange={(e) => update("summary", e.target.value)} aria-label="Summary" />
        <textarea disabled={ro} className="min-h-16 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={plan.positioning} onChange={(e) => update("positioning", e.target.value)} aria-label="Positioning" />
      </Section>
      <Section title="Goals">
        <RowsEditor readOnly={ro} rows={plan.goals} onChange={(v) => update("goals", v)} newRow={() => ({ id: uid(), goal: "", metric: "", target: "", timeframe: "" })}
          columns={[{ key: "goal", label: "Goal" }, { key: "metric", label: "Metric" }, { key: "target", label: "Target" }, { key: "timeframe", label: "Timeframe" }]} />
      </Section>
      <Section title="Audiences">
        <RowsEditor readOnly={ro} rows={plan.audiences} onChange={(v) => update("audiences", v)} newRow={() => ({ id: uid(), name: "", insight: "", message: "" })}
          columns={[{ key: "name", label: "Audience" }, { key: "insight", label: "Insight", type: "textarea" }, { key: "message", label: "What we tell them", type: "textarea" }]} />
      </Section>
      <Section title="Content pillars" hint={`Shares should add up to 100% (now ${plan.pillars.reduce((s, p) => s + Number(p.share || 0), 0)}%).`}>
        <RowsEditor readOnly={ro} rows={plan.pillars} onChange={(v) => update("pillars", v)} newRow={() => ({ id: uid(), name: "", description: "", share: 0, exampleTopics: [] })}
          columns={[{ key: "name", label: "Pillar" }, { key: "share", label: "Share %", type: "number" }, { key: "description", label: "Description", type: "textarea" }, { key: "exampleTopics", label: "Example topics", type: "list" }]} />
      </Section>
      <Section title="Channel mix & frequency">
        <RowsEditor readOnly={ro} rows={plan.channelMix} onChange={(v) => update("channelMix", v)} newRow={() => ({ channel: "instagram", role: "", postsPerWeek: 1, contentTypes: ["social_post" as const] })}
          columns={[{ key: "channel", label: "Channel", type: "select", options: CHANNELS }, { key: "postsPerWeek", label: "Posts / week", type: "number" }, { key: "role", label: "Role", type: "textarea" }, { key: "contentTypes", label: "Content types", type: "multiselect", options: CONTENT_TYPES }]} />
      </Section>
      <Section title="Offers & CTAs">
        <RowsEditor readOnly={ro} rows={plan.offers} onChange={(v) => update("offers", v)} newRow={() => ({ id: uid(), offer: "", cta: "", timing: "" })}
          columns={[{ key: "offer", label: "Offer" }, { key: "cta", label: "Call to action" }, { key: "timing", label: "When" }]} />
      </Section>
      <Section title="Campaigns" hint="Activating the strategy turns these into campaigns you can run.">
        <RowsEditor readOnly={ro} rows={plan.campaigns} onChange={(v) => update("campaigns", v)}
          newRow={() => ({ key: `campaign-${uid()}`, name: "", theme: "", goal: "", startsOn: strategy.starts_on, endsOn: strategy.ends_on, audience: "", keyMessage: "", offer: "", cta: "", channels: channelsInPlan, contentTypes: ["social_post" as const], pillar: "", kpis: [] as string[] })}
          columns={[
            { key: "name", label: "Name" }, { key: "goal", label: "Goal" }, { key: "startsOn", label: "Starts", type: "date" }, { key: "endsOn", label: "Ends", type: "date" },
            { key: "theme", label: "Theme", type: "textarea" }, { key: "keyMessage", label: "Key message", type: "textarea" }, { key: "audience", label: "Audience" }, { key: "pillar", label: "Pillar" },
            { key: "offer", label: "Offer" }, { key: "cta", label: "CTA" }, { key: "channels", label: "Channels", type: "multiselect", options: channelsInPlan },
            { key: "contentTypes", label: "Content types", type: "multiselect", options: CONTENT_TYPES }, { key: "kpis", label: "KPIs", type: "list" },
          ]} />
      </Section>
      <Section title="Week by week">
        <RowsEditor readOnly={ro} rows={plan.weeks} onChange={(v) => update("weeks", v)}
          columns={[{ key: "weekStart", label: "Week of" }, { key: "theme", label: "Theme" }, { key: "focus", label: "Focus", type: "textarea" }, { key: "campaigns", label: "Campaigns", type: "multiselect", options: plan.campaigns.map((c) => c.key) }]} />
      </Section>
      <Section title="Success metrics">
        <RowsEditor readOnly={ro} rows={plan.metrics} onChange={(v) => update("metrics", v)} newRow={() => ({ metric: "", target: "", howMeasured: "" })}
          columns={[{ key: "metric", label: "Metric" }, { key: "target", label: "Target" }, { key: "howMeasured", label: "How we measure it" }]} />
      </Section>
      <Section title="Assumptions">
        <textarea disabled={ro} className="min-h-20 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={plan.assumptions.join("\n")} onChange={(e) => update("assumptions", e.target.value.split("\n").filter((x) => x.trim()))} aria-label="Assumptions" />
      </Section>
      {plan.moments.length > 0 && <Section title="Seasonal moments used"><div className="flex flex-wrap gap-2">{plan.moments.map((m) => <Badge key={m.name + m.date}>{m.name} · {m.date}</Badge>)}</div></Section>}

      {strategy.status === "active" && canEdit && (
        <Card className="flex flex-col gap-3">
          <h3 className="font-semibold">Plan topics</h3>
          <p className="text-sm text-[var(--text-muted)]">Arcatic decides the posting slots from your channel mix and campaign dates, then writes a topic for each. Existing topics are never duplicated.</p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} aria-label="Week">
              {plan.weeks.map((w) => <option key={w.weekStart} value={w.weekStart}>Week of {w.weekStart}{w.theme ? ` — ${w.theme}` : ""}</option>)}
            </select>
            <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={weeksToPlan} onChange={(e) => setWeeksToPlan(Number(e.target.value))} aria-label="Weeks">
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} week{n > 1 ? "s" : ""}</option>)}
            </select>
            <label className="flex items-center gap-2"><input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />Approve topics automatically</label>
            <Button onClick={planWeeks} disabled={!!planJob}>Plan {weeksToPlan} week{weeksToPlan > 1 ? "s" : ""} (≈{weeksToPlan} credit{weeksToPlan > 1 ? "s" : ""})</Button>
          </div>
          {planJob && <JobProgress workspaceId={workspaceId} jobId={planJob} label="Planning topics" onDone={(j) => {
            setPlanJob(undefined);
            const out = j.output as { created?: number; flagged?: number } | null;
            setMsg(j.status === "succeeded" ? { text: `${out?.created ?? 0} topic(s) added${out?.flagged ? `, ${out.flagged} flagged for review` : ""}. See Campaigns or Planner.` } : { err: true, text: j.error?.message ?? "Planning failed." });
          }} />}
        </Card>
      )}

      {(issues.length > 0 || msg) && (
        <div className="flex flex-col gap-1 text-sm">
          {issues.map((i) => <p key={i} className="text-[var(--warning)]">{i}</p>)}
          {msg && <p className={msg.err ? "text-[var(--danger)]" : "text-[var(--success)]"}>{msg.text}</p>}
        </div>
      )}
      {canEdit && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-lg">
          {dirty && <span className="mr-auto text-sm">Unsaved changes</span>}
          {dirty && <Button variant="ghost" onClick={() => { setPlan(strategy.plan!); setDirty(false); }}>Discard</Button>}
          <Button variant={dirty ? "primary" : "secondary"} onClick={save} disabled={!dirty}>Save</Button>
          {strategy.status !== "active" && <Button onClick={activate} disabled={dirty}>Activate strategy</Button>}
        </div>
      )}
    </div>
  );
}

export default function StrategyPage() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const list = useApi<{ data: StrategyRow[] }>(`${base}/strategies`);
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const onboarding = useApi<{ answers: { channels?: string[] } }>(`${base}/onboarding`);
  const canEdit = ["owner", "admin", "editor"].includes(ws.data?.role ?? "");
  const selectedId = search.get("s") ?? list.data?.data.find((s) => s.status === "active")?.id ?? list.data?.data[0]?.id;
  const selected = useApi<Strategy>(selectedId ? `${base}/strategies/${selectedId}` : null);
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState<string>();
  const defaultChannels = useMemo(() => (onboarding.data?.answers.channels ?? []).filter((c) => c !== "website"), [onboarding.data]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Strategy</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {list.data?.data.map((s) => (
          <button key={s.id} onClick={() => router.push(`?s=${s.id}`)} className={cn("rounded-md border px-3 py-1.5 text-sm", s.id === selectedId ? "border-[var(--accent)]" : "border-[var(--border)]")}>
            {s.title} <Badge tone={s.status === "active" ? "success" : s.status === "failed" ? "danger" : "neutral"}>{s.status}</Badge>
          </button>
        ))}
        {canEdit && <Button variant="secondary" onClick={() => setCreating((x) => !x)}>{creating ? "Close" : "New strategy"}</Button>}
      </div>
      {creating && <NewStrategy base={base} defaultChannels={defaultChannels} onStarted={(sid, jid) => { setCreating(false); setJob(jid); router.push(`?s=${sid}`); void list.reload(); }} />}
      {job && <JobProgress workspaceId={workspaceId} jobId={job} label="Writing your strategy" onDone={() => { setJob(undefined); void list.reload(); void selected.reload(); }} />}
      {list.data?.data.length === 0 && !creating && <EmptyState title="No strategy yet" body="Generate a 90-day plan from your Brand Kit, knowledge and goals. You can edit every part of it before activating." />}
      {selected.data?.status === "failed" && <p className="text-sm text-[var(--danger)]">This strategy couldn't be generated: {selected.data.validation?.error ?? "unknown error"}.</p>}
      {selected.data?.status === "generating" && !job && selected.data.generation_job_id && <JobProgress workspaceId={workspaceId} jobId={selected.data.generation_job_id} label="Writing your strategy" onDone={() => { void selected.reload(); void list.reload(); }} />}
      {selected.data?.plan && <Editor key={selected.data.id} base={base} workspaceId={workspaceId} strategy={selected.data} canEdit={canEdit} onSaved={() => { void selected.reload(); void list.reload(); }} />}
    </div>
  );
}
