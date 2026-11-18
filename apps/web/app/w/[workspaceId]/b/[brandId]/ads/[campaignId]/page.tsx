"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { googleLength, META_CTAS, META_RECOMMENDED, META_SPECIAL_CATEGORIES, RSA, type AdAudience } from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { ConfirmDialog } from "@/components/ads/ConfirmDialog";
import { OBJECTIVES, money, statusTone } from "@/components/ads/format";
import { JobProgress } from "@/components/plan/JobProgress";
import { LineChart } from "@/components/analytics/LineChart";
import { MediaPicker } from "@/components/media/MediaPicker";

type Issue = { code: string; severity: "error" | "warning"; field: string; message: string };
type Action = { id: string; action: string; status: string; summary: string; payload: { confirm?: string }; requested_by: string | null; decided_by: string | null; created_at: string; executed_at: string | null; error: string | null };
type Campaign = {
  id: string; connection_id: string; platform: "google" | "meta"; name: string; objective: string; status: string; brief: { offer?: string; audience?: string; goal?: string; notes?: string; summary?: string; angles?: string[] };
  audience: AdAudience; creative: Record<string, unknown>; landing_url: string | null; daily_budget_minor: number | null; currency: string; start_date: string | null; end_date: string | null;
  special_ad_categories: string[]; compliance: { passed: boolean; issues: Issue[]; checkedAt: string } | null; revision: number; external: Record<string, string>; last_error: string | null; source_content_item_id: string | null;
  actions: Action[]; allowedActions: string[]; policy: { manage_enabled: boolean; max_daily_budget_minor: number; require_separate_approver: boolean } | null;
};
type Report = { series: Array<{ date: string; impressions: number; clicks: number; spendMinor: number; conversions: number }>; totals: { impressions: number; clicks: number; spendMinor: number; conversions: number; ctr: number | null; cpcMinor: number | null; cpaMinor: number | null } | null; account?: { monthSpendMinor: number; capMinor: number | null; level: string }; note?: string };
type G = { headlines: string[]; descriptions: string[]; path1?: string | null; path2?: string | null };
type M = { primaryText: string; headline: string; description?: string | null; cta: string; mediaAssetId?: string | null; alternatives?: { primaryTexts: string[]; headlines: string[]; descriptions: string[] } };
const LABEL: Record<string, string> = { launch: "Request launch (create paused)", activate: "Request: turn on", pause: "Pause now", budget_change: "Request budget change", end: "End campaign" };
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function Counter({ text, max, measure = (s: string) => [...s].length }: { text: string; max: number; measure?: (s: string) => number }) {
  const n = measure(text);
  return <span className={cn("tabular-nums text-xs", n > max ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>{n}/{max}</span>;
}

export default function CampaignPage() {
  const { workspaceId, brandId, campaignId } = useParams<{ workspaceId: string; brandId: string; campaignId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const role = ws.data?.role ?? "";
  const canManage = ["owner", "admin", "editor"].includes(role);
  const canApprove = ["owner", "admin"].includes(role);
  const { data: c, reload } = useApi<Campaign>(`${base}/ads/campaigns/${campaignId}`);
  const report = useApi<Report>(`${base}/ads/campaigns/${campaignId}/report?days=30`);
  const [draft, setDraft] = useState<Campaign>();
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [job, setJob] = useState<string>();
  const [confirm, setConfirm] = useState<{ title: string; summary: string; phrase: string | null; label: string; run: (t?: string) => Promise<void>; danger?: boolean }>();
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState<{ kind: "geo" | "interest"; q: string; results: Array<Record<string, unknown>> }>({ kind: "geo", q: "", results: [] });
  const [newBudget, setNewBudget] = useState("");

  useEffect(() => { if (c) setDraft(c); }, [c?.id, c?.revision]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ch = supabase().channel(`ad:${campaignId}`).on("postgres_changes", { event: "UPDATE", schema: "public", table: "ad_campaigns", filter: `id=eq.${campaignId}` }, () => void reload()).subscribe();
    return () => void supabase().removeChannel(ch);
  }, [campaignId]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (!c || !draft) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  const editable = canManage && (c.status === "draft" || c.status === "failed") && !job;
  const dirty = JSON.stringify(draft) !== JSON.stringify(c);
  const g = draft.creative as unknown as G;
  const m = draft.creative as unknown as M;
  const setCreative = (x: Partial<G & M>) => setDraft({ ...draft, creative: { ...draft.creative, ...x } });
  const setAud = (x: Partial<AdAudience>) => setDraft({ ...draft, audience: { ...draft.audience, ...x } });
  const issues = c.compliance?.issues ?? [];
  const open = c.actions.find((a) => ["pending", "approved", "executing"].includes(a.status));
  const fail = (e: unknown) => setMsg({ err: true, text: e instanceof ApiError && e.code === "insufficient_credits" ? "Not enough credits." : (e as Error).message });

  async function save() {
    setMsg(undefined);
    try {
      await api(`${base}/ads/campaigns/${c!.id}`, { method: "PATCH", body: JSON.stringify({
        name: draft!.name, objective: draft!.objective, brief: { offer: draft!.brief.offer, audience: draft!.brief.audience, goal: draft!.brief.goal, notes: draft!.brief.notes },
        audience: draft!.audience, creative: draft!.creative, landingUrl: draft!.landing_url || null, dailyBudgetMinor: draft!.daily_budget_minor, startDate: draft!.start_date || null, endDate: draft!.end_date || null,
        specialAdCategories: draft!.special_ad_categories,
      }) });
      setMsg({ text: open ? "Saved. The open request was cancelled because the campaign changed." : "Saved and checked." });
      await reload();
    } catch (e) { fail(e); }
  }
  async function aiDraft() {
    setMsg(undefined);
    try { const r = await api<{ job: { id: string } }>(`${base}/ads/campaigns/${c!.id}/draft`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: "{}" }); setJob(r.job.id); } catch (e) { fail(e); }
  }
  async function request(action: string, extra: Record<string, unknown> = {}) {
    setMsg(undefined);
    try {
      await api(`${base}/ads/campaigns/${c!.id}/actions`, { method: "POST", body: JSON.stringify({ action, ...extra }) });
      setMsg({ text: action === "pause" || action === "end" ? "Done — the platform updates in a moment." : canApprove && !c!.policy?.require_separate_approver ? "Requested. Approve it below." : "Requested. An owner or admin needs to approve it." });
      await reload();
    } catch (e) { fail(e); }
  }
  async function runSearch() {
    try { const r = await api<{ data: Array<Record<string, unknown>> }>(`/workspaces/${workspaceId}/ads/accounts/${c!.connection_id}/search?kind=${search.kind}&q=${encodeURIComponent(search.q)}`); setSearch({ ...search, results: r.data }); } catch (e) { fail(e); }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href={`/w/${workspaceId}/b/${brandId}/ads`} className="text-sm text-[var(--text-muted)] hover:underline">← Ads</Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{c.name}</h1><Badge>{c.platform === "google" ? "Google Search" : "Meta"}</Badge><Badge tone={statusTone(c.status)}>{c.status}</Badge>
          {c.external.campaignId && <span className="text-xs text-[var(--text-muted)]">platform id {c.external.campaignId}</span>}
        </div>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      {c.last_error && <p className="text-sm text-[var(--danger)]">{c.last_error}</p>}
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
      {job && <JobProgress workspaceId={workspaceId} jobId={job} label="Drafting brief, audience and copy" onDone={() => { setJob(undefined); void reload(); }} />}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2"><h2 className="font-semibold">Brief</h2>{editable && <Button variant="secondary" className="ml-auto h-8" onClick={() => void aiDraft()} disabled={dirty}>Draft with AI · 3 credits</Button>}</div>
            {draft.brief.summary && <p className="rounded bg-[var(--surface-2)] p-2">{draft.brief.summary}{draft.brief.angles?.length ? <><br /><span className="text-xs text-[var(--text-muted)]">Angles: {draft.brief.angles.join(" · ")}</span></> : null}</p>}
            <label className="flex flex-col gap-1">Name<Input value={draft.name} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="flex flex-col gap-1">Offer<Input value={draft.brief.offer ?? ""} disabled={!editable} onChange={(e) => setDraft({ ...draft, brief: { ...draft.brief, offer: e.target.value } })} placeholder="What are you promoting?" /></label>
            <label className="flex flex-col gap-1">Who should see it<Input value={draft.brief.audience ?? ""} disabled={!editable} onChange={(e) => setDraft({ ...draft, brief: { ...draft.brief, audience: e.target.value } })} /></label>
            <div className="flex flex-wrap gap-2">
              <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" disabled={!editable} value={draft.objective} onChange={(e) => setDraft({ ...draft, objective: e.target.value })} aria-label="Objective">
                {Object.entries(OBJECTIVES[c.platform]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <label className="flex items-center gap-1">₹/day<Input className="w-28" type="number" min={1} disabled={!editable} value={draft.daily_budget_minor != null ? draft.daily_budget_minor / 100 : ""} onChange={(e) => setDraft({ ...draft, daily_budget_minor: e.target.value ? Math.round(Number(e.target.value) * 100) : null })} aria-label="Daily budget" /></label>
              <label className="flex items-center gap-1">Start<Input type="date" disabled={!editable} value={draft.start_date ?? ""} onChange={(e) => setDraft({ ...draft, start_date: e.target.value || null })} /></label>
              <label className="flex items-center gap-1">End<Input type="date" disabled={!editable} value={draft.end_date ?? ""} onChange={(e) => setDraft({ ...draft, end_date: e.target.value || null })} /></label>
            </div>
            <label className="flex flex-col gap-1">Landing page<Input type="url" disabled={!editable} value={draft.landing_url ?? ""} onChange={(e) => setDraft({ ...draft, landing_url: e.target.value })} placeholder="https://" /></label>
          </Card>

          <Card className="flex flex-col gap-2 text-sm">
            <h2 className="font-semibold">Audience</h2>
            <div className="flex flex-wrap gap-1">{draft.audience.locations.map((l) => <Badge key={l.key}>{l.name}{editable && <button className="ml-1" aria-label={`Remove ${l.name}`} onClick={() => setAud({ locations: draft.audience.locations.filter((x) => x.key !== l.key) })}>×</button>}</Badge>)}</div>
            {c.platform === "meta" && <div className="flex flex-wrap gap-1">{draft.audience.interests.map((i) => <Badge key={i.id} tone="success">{i.name}{editable && <button className="ml-1" aria-label={`Remove ${i.name}`} onClick={() => setAud({ interests: draft.audience.interests.filter((x) => x.id !== i.id) })}>×</button>}</Badge>)}</div>}
            {editable && (
              <div className="flex flex-col gap-1">
                <div className="flex gap-2">
                  {c.platform === "meta" && <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={search.kind} onChange={(e) => setSearch({ kind: e.target.value as "geo" | "interest", q: "", results: [] })} aria-label="Search for"><option value="geo">Locations</option><option value="interest">Interests</option></select>}
                  <Input value={search.q} onChange={(e) => setSearch({ ...search, q: e.target.value })} placeholder={search.kind === "geo" ? "Search a city, state or country" : "Search interests"} aria-label="Search" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void runSearch(); } }} />
                  <Button variant="secondary" onClick={() => void runSearch()}>Search</Button>
                </div>
                <div className="flex flex-wrap gap-1">{search.results.slice(0, 12).map((r) => (
                  <button key={String(r.key ?? r.id)} className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:border-[var(--accent)]" onClick={() => {
                    if (search.kind === "interest") setAud({ interests: [...draft.audience.interests.filter((x) => x.id !== String(r.id)), { id: String(r.id), name: String(r.name) }] });
                    else setAud({ locations: [...draft.audience.locations.filter((x) => x.key !== String(r.key)), { key: String(r.key), name: String(r.name), type: (c.platform === "google" ? "geo_target" : (r.type as "country" | "region" | "city")) }] });
                  }}>+ {String(r.name)}{r.type ? ` (${String(r.type)})` : ""}</button>
                ))}</div>
                <p className="text-xs text-[var(--text-muted)]">Locations and interests come from the ad platform itself, so their ids are real.</p>
              </div>
            )}
            {c.platform === "google" ? (
              <>
                <label className="flex flex-col gap-1">Keywords (one per line; prefix [exact] or "phrase")<textarea className="min-h-24 rounded border border-[var(--border)] bg-[var(--surface)] p-2" disabled={!editable}
                  value={draft.audience.keywords.map((k) => (k.match === "EXACT" ? `[${k.text}]` : k.match === "PHRASE" ? `"${k.text}"` : k.text)).join("\n")}
                  onChange={(e) => setAud({ keywords: lines(e.target.value).slice(0, 50).map((l) => (l.startsWith("[") ? { text: l.replace(/^\[|\]$/g, ""), match: "EXACT" as const } : l.startsWith('"') ? { text: l.replace(/^"|"$/g, ""), match: "PHRASE" as const } : { text: l, match: "BROAD" as const })) })} /></label>
                <label className="flex flex-col gap-1">Negative keywords (one per line)<textarea className="min-h-16 rounded border border-[var(--border)] bg-[var(--surface)] p-2" disabled={!editable} value={draft.audience.negativeKeywords.join("\n")} onChange={(e) => setAud({ negativeKeywords: lines(e.target.value).slice(0, 50) })} /></label>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1">Age<Input className="w-16" type="number" min={18} max={65} disabled={!editable || draft.special_ad_categories.length > 0} value={draft.audience.ageMin} onChange={(e) => setAud({ ageMin: Number(e.target.value) })} />–<Input className="w-16" type="number" min={18} max={65} disabled={!editable || draft.special_ad_categories.length > 0} value={draft.audience.ageMax} onChange={(e) => setAud({ ageMax: Number(e.target.value) })} /></label>
                <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" disabled={!editable || draft.special_ad_categories.length > 0} value={draft.audience.genders.join(",")} onChange={(e) => setAud({ genders: e.target.value ? [e.target.value as "male" | "female"] : [] })} aria-label="Gender"><option value="">All genders</option><option value="female">Women</option><option value="male">Men</option></select>
                <fieldset className="flex flex-wrap gap-2 text-xs"><legend className="sr-only">Special ad categories</legend>
                  {META_SPECIAL_CATEGORIES.map((k) => <label key={k} className="flex items-center gap-1"><input type="checkbox" disabled={!editable} checked={draft.special_ad_categories.includes(k)} onChange={(e) => setDraft({ ...draft, special_ad_categories: e.target.checked ? [...draft.special_ad_categories, k] : draft.special_ad_categories.filter((x) => x !== k), ...(e.target.checked && { audience: { ...draft.audience, ageMin: 18, ageMax: 65, genders: [] } }) })} />{k.toLowerCase().replace(/_/g, " ")}</label>)}
                </fieldset>
              </div>
            )}
          </Card>

          <Card className="flex flex-col gap-2 text-sm">
            <h2 className="font-semibold">Ad</h2>
            {c.platform === "google" ? (
              <>
                <p className="text-xs text-[var(--text-muted)]">Responsive search ad: {RSA.headlines.min}–{RSA.headlines.max} headlines (≤ {RSA.headlines.chars} characters), {RSA.descriptions.min}–{RSA.descriptions.max} descriptions (≤ {RSA.descriptions.chars}). Google mixes them.</p>
                {Array.from({ length: Math.min(RSA.headlines.max, Math.max(3, (g.headlines ?? []).length + (editable ? 1 : 0))) }, (_, i) => (
                  <div key={`h${i}`} className="flex items-center gap-2"><Input disabled={!editable} value={g.headlines?.[i] ?? ""} placeholder={`Headline ${i + 1}`} onChange={(e) => { const h = [...(g.headlines ?? [])]; h[i] = e.target.value; setCreative({ headlines: h.filter((x, j) => x || j < i) }); }} /><Counter text={g.headlines?.[i] ?? ""} max={RSA.headlines.chars} measure={googleLength} /></div>
                ))}
                {Array.from({ length: Math.min(RSA.descriptions.max, Math.max(2, (g.descriptions ?? []).length + (editable ? 1 : 0))) }, (_, i) => (
                  <div key={`d${i}`} className="flex items-center gap-2"><Input disabled={!editable} value={g.descriptions?.[i] ?? ""} placeholder={`Description ${i + 1}`} onChange={(e) => { const d = [...(g.descriptions ?? [])]; d[i] = e.target.value; setCreative({ descriptions: d.filter((x, j) => x || j < i) }); }} /><Counter text={g.descriptions?.[i] ?? ""} max={RSA.descriptions.chars} measure={googleLength} /></div>
                ))}
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">{(draft.landing_url ?? "example.com").replace(/^https?:\/\//, "").split("/")[0]}/<Input className="w-28" disabled={!editable} value={g.path1 ?? ""} onChange={(e) => setCreative({ path1: e.target.value })} aria-label="Path 1" />/<Input className="w-28" disabled={!editable} value={g.path2 ?? ""} onChange={(e) => setCreative({ path2: e.target.value })} aria-label="Path 2" /></div>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1"><span className="flex justify-between">Primary text <Counter text={m.primaryText ?? ""} max={META_RECOMMENDED.primaryText} /></span><textarea className="min-h-20 rounded border border-[var(--border)] bg-[var(--surface)] p-2" disabled={!editable} value={m.primaryText ?? ""} onChange={(e) => setCreative({ primaryText: e.target.value })} /></label>
                <label className="flex flex-col gap-1"><span className="flex justify-between">Headline <Counter text={m.headline ?? ""} max={META_RECOMMENDED.headline} /></span><Input disabled={!editable} value={m.headline ?? ""} onChange={(e) => setCreative({ headline: e.target.value })} /></label>
                <label className="flex flex-col gap-1"><span className="flex justify-between">Description <Counter text={m.description ?? ""} max={META_RECOMMENDED.description} /></span><Input disabled={!editable} value={m.description ?? ""} onChange={(e) => setCreative({ description: e.target.value })} /></label>
                <div className="flex flex-wrap items-center gap-2">
                  <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" disabled={!editable} value={m.cta ?? "LEARN_MORE"} onChange={(e) => setCreative({ cta: e.target.value })} aria-label="Button">{META_CTAS.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ").toLowerCase()}</option>)}</select>
                  {editable && <Button variant="secondary" onClick={() => setPicker(true)}>{m.mediaAssetId ? "Change image" : "Choose image"}</Button>}
                  {m.mediaAssetId && <Badge tone="success">image chosen</Badge>}
                </div>
                {m.alternatives && editable && (
                  <details className="text-xs"><summary className="cursor-pointer text-[var(--text-muted)]">AI alternatives</summary>
                    {m.alternatives.primaryTexts.map((t) => <button key={t} className="mt-1 block text-left hover:underline" onClick={() => setCreative({ primaryText: t })}>{t}</button>)}
                    {m.alternatives.headlines.map((t) => <button key={t} className="mt-1 block text-left font-medium hover:underline" onClick={() => setCreative({ headline: t })}>{t}</button>)}
                  </details>
                )}
              </>
            )}
            {editable && <div className="flex gap-2"><Button disabled={!dirty} onClick={() => void save()}>Save & check</Button>{dirty && <Button variant="ghost" onClick={() => setDraft(c)}>Discard</Button>}</div>}
            {!editable && c.status !== "draft" && c.status !== "failed" && <p className="text-xs text-[var(--text-muted)]">This campaign exists on the platform: only budget, pausing and ending can change here.</p>}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-2 text-sm">
            <h2 className="font-semibold">Pre-launch checks</h2>
            {!c.compliance ? <p className="text-[var(--text-muted)]">Not checked yet.</p> : (
              <>
                <Badge tone={c.compliance.passed ? "success" : "danger"}>{c.compliance.passed ? "No blocking issues" : `${issues.filter((i) => i.severity === "error").length} blocking`}</Badge>
                <ul className="flex flex-col gap-1">{issues.map((i, k) => <li key={k} className={cn("text-xs", i.severity === "error" ? "text-[var(--danger)]" : "text-[var(--warning)]")}>{i.severity === "error" ? "✕" : "!"} {i.message}</li>)}</ul>
                <p className="text-xs text-[var(--text-muted)]">Catches common reasons for disapproval and claims a reviewer should check. The platform still reviews every ad.</p>
              </>
            )}
          </Card>

          <Card className="flex flex-col gap-2 text-sm">
            <h2 className="font-semibold">Actions</h2>
            {!c.policy?.manage_enabled && <p className="text-xs text-[var(--warning)]">Campaign management is off for this ad account. An owner can switch it on in Settings → Ad accounts.</p>}
            {open && <p className="text-xs"><Badge tone="warning">{open.action.replace("_", " ")} · {open.status}</Badge> {open.summary}</p>}
            {canManage && !open && c.allowedActions.map((a) => a === "budget_change" ? (
              <div key={a} className="flex items-center gap-2"><Input className="w-28" type="number" min={1} placeholder="₹/day" value={newBudget} onChange={(e) => setNewBudget(e.target.value)} aria-label="New daily budget" />
                <Button variant="secondary" disabled={!newBudget} onClick={() => void request("budget_change", { dailyBudgetMinor: Math.round(Number(newBudget) * 100) })}>{LABEL[a]}</Button></div>
            ) : (
              <Button key={a} variant={a === "pause" || a === "end" ? "secondary" : "primary"} disabled={dirty || (a === "launch" && !c.compliance?.passed)}
                onClick={() => a === "end" ? setConfirm({ title: "End campaign", summary: `"${c.name}" will be paused on the platform permanently.`, phrase: null, label: "End", danger: true, run: () => request("end") }) : void request(a)}>{LABEL[a]}</Button>
            ))}
            {canApprove && open?.status === "pending" && (
              <div className="flex gap-2">
                <Button onClick={() => setConfirm({ title: `Approve: ${open.action.replace("_", " ")}`, summary: open.summary, phrase: open.payload.confirm ?? null, label: "Approve", danger: true, run: async (t) => { await api(`${base}/ads/requests/${open.id}/decide`, { method: "POST", body: JSON.stringify({ decision: "approved", confirmation: t }) }); await reload(); } })}>Approve…</Button>
                <Button variant="ghost" onClick={() => void api(`${base}/ads/requests/${open.id}/decide`, { method: "POST", body: JSON.stringify({ decision: "rejected" }) }).then(reload).catch(fail)}>Reject</Button>
              </div>
            )}
            {canManage && open?.status === "pending" && <Button variant="ghost" onClick={() => void api(`${base}/ads/requests/${open.id}/cancel`, { method: "POST", body: "{}" }).then(reload).catch(fail)}>Withdraw request</Button>}
            <ul className="mt-2 flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              {c.actions.slice(0, 8).map((a) => <li key={a.id}>{new Date(a.created_at).toLocaleString()} · {a.action.replace("_", " ")} · <span className={a.status === "failed" ? "text-[var(--danger)]" : ""}>{a.status}</span>{a.error ? ` — ${a.error}` : ""}</li>)}
            </ul>
          </Card>

          <Card className="flex flex-col gap-2 text-sm">
            <h2 className="font-semibold">Results (30 days)</h2>
            {!report.data?.totals ? <p className="text-[var(--text-muted)]">{report.data?.note ?? "No data yet. Numbers arrive with the next ads sync (every 2 hours)."}</p> : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div>Spend <b>{money(report.data.totals.spendMinor, c.currency)}</b></div><div>Clicks <b>{report.data.totals.clicks.toLocaleString("en-IN")}</b></div>
                  <div>CTR <b>{report.data.totals.ctr == null ? "—" : `${(report.data.totals.ctr * 100).toFixed(2)}%`}</b></div><div>CPC <b>{money(report.data.totals.cpcMinor, c.currency)}</b></div>
                  <div>Conversions <b>{report.data.totals.conversions}</b></div><div>Cost / conv. <b>{money(report.data.totals.cpaMinor, c.currency)}</b></div>
                </div>
                <LineChart label="Spend per day" points={report.data.series.map((s) => ({ date: s.date, value: s.spendMinor / 100 }))} format={(n) => `₹${n.toLocaleString("en-IN")}`} height={120} />
              </>
            )}
            {report.data?.account?.capMinor != null && <p className={cn("text-xs", report.data.account.level === "ok" ? "text-[var(--text-muted)]" : "text-[var(--warning)]")}>Ad account this month: {money(report.data.account.monthSpendMinor, c.currency)} of {money(report.data.account.capMinor, c.currency)} cap.</p>}
          </Card>
        </div>
      </div>

      {picker && <MediaPicker workspaceId={workspaceId} kinds={["image"]} title="Ad image" onClose={() => setPicker(false)} onPick={(a) => { setCreative({ mediaAssetId: a[0]?.id ?? null }); setPicker(false); }} />}
      {confirm && <ConfirmDialog title={confirm.title} summary={confirm.summary} phrase={confirm.phrase} actionLabel={confirm.label} danger={confirm.danger} onClose={() => setConfirm(undefined)} onConfirm={async (t) => { await confirm.run(t); }} />}
    </div>
  );
}
