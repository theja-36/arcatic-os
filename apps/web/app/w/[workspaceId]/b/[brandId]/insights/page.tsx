"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { pctFmt } from "@/components/analytics/Stat";

type Insight = { id: string; kind: string; title: string; body: string; evidence: Record<string, unknown>; confidence: number | null; guidance: string | null; applies_to: { channel?: string }; status: string; updated_at: string };
type Quality = { template: string; model: string; items: number; reviewed: number; firstPassApprovalRate: number | null; editRate: number; rejectRate: number | null; avgRegenerations: number; avgEngagementScore: number | null; published: number };
type Learning = { periodDays: number; signals: Record<string, number>; editClasses: Record<string, number>; quality: Quality[]; learningsInUse: Array<{ id: string; title: string; guidance: string }> };
const KIND: Record<string, string> = { recommendation: "Recommendation", trend: "Trend", top_content: "Top post", underperformer: "Underperformer", voice_refinement: "Voice refinement", anomaly: "Anomaly", ai_quality: "AI quality" };
const SIGNAL: Record<string, string> = { edit: "Edits to AI drafts", approve: "Approvals", reject: "Rejections", request_changes: "Changes requested", regenerate: "Regenerations", rating: "Ratings", manual_note: "Notes", engagement_outcome: "Posts scored on engagement", publish_failure: "Publish failures", insight_accept: "Insights accepted", insight_dismiss: "Insights dismissed" };

export default function InsightsPage() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const [status, setStatus] = useState<"" | "accepted" | "dismissed">("");
  const list = useApi<{ data: Insight[] }>(`${base}/insights${status ? `?status=${status}` : ""}`);
  const learning = useApi<Learning>(`${base}/learning`);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();

  async function act(id: string, fn: () => Promise<string>) {
    setBusy(id);
    setMsg(undefined);
    try { setMsg({ text: await fn() }); await Promise.all([list.reload(), learning.reload()]); }
    catch (e) { setMsg({ err: true, text: (e as Error).message }); }
    finally { setBusy(""); }
  }
  const accept = (i: Insight) => act(i.id, async () => {
    const r = await api<{ usedInGeneration: boolean; kit: { baseVersion: number; ops: unknown[] } | null }>(`${base}/insights/${i.id}/accept`, { method: "POST" });
    if (r.kit?.ops.length) {
      await api(`${base}/kit/ops`, { method: "POST", body: JSON.stringify({ baseVersion: r.kit.baseVersion, ops: r.kit.ops, note: `From insight: ${i.title}`.slice(0, 300) }) });
      await api(`${base}/insights/${i.id}/applied`, { method: "POST" });
      return "Saved as a Brand Kit draft. Approve it in Brand Kit to use it in generation.";
    }
    return r.usedInGeneration ? "Accepted. New drafts for matching content will follow it." : "Accepted.";
  });
  const items = list.data?.data ?? [];
  const L = learning.data;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Insights &amp; learning</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <Card className="p-4 text-sm text-[var(--text-muted)]">
        Insights come from your published posts, website and ad figures, and from how your team edits and reviews drafts. Each one shows its evidence.
        Nothing changes how Arcatic writes until someone accepts it: accepted guidance is added to future prompts, and vocabulary changes go through a Brand Kit draft for approval.
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-[var(--radius)] border border-[var(--border)]" role="group" aria-label="Show">
          {([["", "Open"], ["accepted", "Accepted"], ["dismissed", "Dismissed"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setStatus(k)} aria-pressed={status === k} className={cn("px-3 py-1.5 text-sm", status === k ? "bg-[var(--surface-2)] font-medium" : "text-[var(--text-muted)]")}>{l}</button>
          ))}
        </div>
        <Button variant="secondary" className="ml-auto h-8 px-3 text-xs" onClick={() => void act("refresh", async () => { await api(`${base}/insights/refresh`, { method: "POST" }); return "Recalculating in the background; refresh in a minute."; })}>Recalculate</Button>
      </div>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      {items.length === 0 && !list.loading && <EmptyState title="No insights yet" body="They appear once there are enough published posts with figures (at least 8 per channel for recommendations) or enough reviewed drafts." />}
      <div className="grid gap-3 lg:grid-cols-2">
        {items.map((i) => (
          <Card key={i.id} className="flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={i.kind === "underperformer" ? "warning" : i.kind === "voice_refinement" ? "accent" : "neutral"}>{KIND[i.kind] ?? i.kind}</Badge>
              {i.applies_to?.channel && <Badge>{i.applies_to.channel}</Badge>}
              {i.confidence != null && <span className="text-xs text-[var(--text-muted)]">confidence {Math.round(i.confidence * 100)}%</span>}
              {i.status !== "new" && <Badge tone={i.status === "dismissed" ? "neutral" : "success"}>{i.status}</Badge>}
            </div>
            <h3 className="font-medium">{i.title}</h3>
            <p className="text-sm">{i.body}</p>
            {i.guidance && <p className="rounded bg-[var(--surface-2)] p-2 text-xs"><span className="font-medium">If accepted, future drafts get: </span>“{i.guidance}”</p>}
            {"contentItemId" in i.evidence && <Link href={`/w/${workspaceId}/b/${brandId}/content/${String(i.evidence.contentItemId)}`} className="text-xs text-[var(--accent)] hover:underline">Open the post</Link>}
            <details className="text-xs"><summary className="cursor-pointer text-[var(--text-muted)]">Evidence</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-2)] p-2">{JSON.stringify(i.evidence, null, 2)}</pre></details>
            {i.status === "new" && (["recommendation", "voice_refinement", "trend"].includes(i.kind)) && (
              <div className="flex gap-2">
                <Button className="h-8 px-3 text-xs" disabled={!!busy} onClick={() => void accept(i)}>{i.kind === "voice_refinement" && !i.guidance ? "Propose Brand Kit change" : "Accept"}</Button>
                <Button variant="ghost" className="h-8 px-3 text-xs" disabled={!!busy} onClick={() => void act(i.id, async () => { await api(`${base}/insights/${i.id}/dismiss`, { method: "POST" }); return "Dismissed; it won't be raised again."; })}>Dismiss</Button>
              </div>
            )}
            {i.status === "accepted" && i.guidance && <Button variant="ghost" className="h-8 self-start px-3 text-xs" disabled={!!busy} onClick={() => void act(i.id, async () => { await api(`${base}/insights/${i.id}/dismiss`, { method: "POST" }); return "No longer used in generation."; })}>Stop using</Button>}
          </Card>
        ))}
      </div>

      {L && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="flex flex-col gap-2 p-4">
            <h2 className="font-semibold">Feedback collected <span className="text-xs font-normal text-[var(--text-muted)]">(last {L.periodDays} days)</span></h2>
            <ul className="grid grid-cols-2 gap-1 text-sm">{Object.entries(L.signals).map(([k, n]) => <li key={k} className="flex justify-between gap-2"><span className="text-[var(--text-muted)]">{SIGNAL[k] ?? k}</span><span className="tabular-nums">{n}</span></li>)}</ul>
            {Object.keys(L.editClasses).length > 0 && <p className="text-xs text-[var(--text-muted)]">Most common edits: {Object.entries(L.editClasses).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} (${n})`).join(", ")}</p>}
          </Card>
          <Card className="flex flex-col gap-2 p-4">
            <h2 className="font-semibold">Learnings in use</h2>
            {L.learningsInUse.length === 0 ? <p className="text-sm text-[var(--text-muted)]">None yet. Accepted recommendations with guidance appear here and are added to new drafts.</p> :
              <ul className="list-disc pl-5 text-sm">{L.learningsInUse.map((x) => <li key={x.id}>{x.guidance}</li>)}</ul>}
          </Card>
          <Card className="flex flex-col gap-2 p-4 lg:col-span-2">
            <h2 className="font-semibold">AI drafts by prompt and model</h2>
            {L.quality.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No AI-generated drafts in this period.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="text-left text-xs text-[var(--text-muted)]"><th className="py-1">Prompt</th><th className="py-1">Model</th><th className="py-1 text-right">Drafts</th><th className="py-1 text-right">Approved as written</th><th className="py-1 text-right">Edited</th><th className="py-1 text-right">Regenerations / draft</th><th className="py-1 text-right">Engagement vs channel</th></tr></thead>
                  <tbody>{L.quality.map((q) => (
                    <tr key={`${q.template}${q.model}`} className="border-t border-[var(--border)]">
                      <td className="py-1.5">{q.template}</td><td className="py-1.5 text-xs">{q.model}</td><td className="py-1.5 text-right tabular-nums">{q.items}</td>
                      <td className="py-1.5 text-right tabular-nums">{q.firstPassApprovalRate == null ? "—" : `${pctFmt(q.firstPassApprovalRate)} of ${q.reviewed}`}</td>
                      <td className="py-1.5 text-right tabular-nums">{pctFmt(q.editRate)}</td><td className="py-1.5 text-right tabular-nums">{q.avgRegenerations.toFixed(1)}</td>
                      <td className="py-1.5 text-right tabular-nums">{q.avgEngagementScore == null ? "—" : `${q.avgEngagementScore >= 0 ? "+" : ""}${Math.round(q.avgEngagementScore * 100)}% (${q.published})`}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-[var(--text-muted)]">The same scores are attached to each generation in Langfuse (when configured) to compare prompt and model versions.</p>
          </Card>
        </div>
      )}
    </div>
  );
}
