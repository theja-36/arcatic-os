"use client";
import Link from "next/link";
import { useState } from "react";
import { Badge, Card, EmptyState, cn } from "@arcatic/ui";
import { useApi } from "@/lib/use-api";
import { STATUS_LABEL } from "@/components/services/format";

type Ops = { totals: Record<string, number>; workload: Array<{ user_id: string; display_name: string; role: string; active_requests: number; overdue: number; utilisation: number; max_active: number }>; requests: Array<{ id: string; title: string; brand_name: string; status: string; sla: string; assignee_name: string | null; due_at: string | null; credits_held: number; hold_expires_at: string | null; holds_lost: number }> };
type Row = { id: string; title: string; status: string; due_at: string | null; brandName: string | null; offering_key: string; revisions_used: number; assignee_id: string | null };

/** Arcatic service team: managers triage and review; specialists work on what's assigned to them. */
export default function Desk() {
  const me = useApi<{ role: "manager" | "specialist"; display_name: string }>("/desk/me");
  const [scope, setScope] = useState<"queue" | "mine" | "open" | "all" | "ops">("mine");
  const effective = me.data?.role === "manager" ? scope : "mine";
  const list = useApi<{ data: Row[] }>(me.data && effective !== "ops" ? `/desk/requests?scope=${effective}` : null);
  const ops = useApi<Ops>(me.data?.role === "manager" && scope === "ops" ? "/desk/ops" : null);
  if (me.error) return <main className="mx-auto max-w-3xl p-6"><EmptyState title="Service desk" body="This area is for Arcatic's service team." /></main>;
  const now = Date.now();
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-8">
      <div className="flex items-center gap-2"><h1 className="text-xl font-semibold">Service desk</h1>{me.data && <Badge>{me.data.display_name} · {me.data.role}</Badge>}</div>
      {me.data?.role === "manager" && (
        <div role="tablist" className="flex gap-3 border-b border-[var(--border)] text-sm">
          {(["queue", "open", "mine", "all", "ops"] as const).map((s) => <button key={s} role="tab" aria-selected={scope === s} className={cn("-mb-px border-b-2 pb-1", scope === s ? "border-[var(--accent)] font-medium" : "border-transparent text-[var(--text-muted)]")} onClick={() => setScope(s)}>{s === "queue" ? "Needs triage / QA" : s === "open" ? "All open" : s === "mine" ? "Mine" : s === "all" ? "Everything" : "Operations"}</button>)}
        </div>
      )}
      {scope === "ops" && ops.data && (
        <div className="flex flex-col gap-4 text-sm">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([["Open", ops.data.totals.open], ["Unassigned", ops.data.totals.unassigned], ["Overdue", ops.data.totals.overdue], ["Due < 24 h", ops.data.totals.dueSoon], ["Awaiting customer", ops.data.totals.awaitingCustomer], ["Credits on hold", ops.data.totals.creditsHeld], ["Holds expiring ≤ 7 d", ops.data.totals.holdsExpiringWithin7Days], ["Holds lost", ops.data.totals.holdsLost]] as const).map(([l, v]) => (
              <Card key={l} className="p-3"><p className="text-xs text-[var(--text-muted)]">{l}</p><p className={cn("text-lg font-semibold", (l === "Overdue" || l === "Holds lost") && Number(v) > 0 && "text-[var(--danger)]")}>{v}</p></Card>
            ))}
          </div>
          <Card className="overflow-x-auto p-3"><h2 className="mb-2 font-semibold">Workload</h2>
            <table className="w-full"><thead><tr className="text-left text-xs text-[var(--text-muted)]"><th>Person</th><th>Role</th><th className="text-right">Active</th><th className="text-right">Overdue</th><th className="text-right">Capacity used</th></tr></thead>
              <tbody>{ops.data.workload.map((w) => <tr key={w.user_id} className="border-t border-[var(--border)]"><td className="py-1">{w.display_name}</td><td>{w.role}</td><td className="text-right tabular-nums">{w.active_requests}/{w.max_active}</td><td className={cn("text-right tabular-nums", w.overdue > 0 && "text-[var(--danger)]")}>{w.overdue}</td><td className="text-right tabular-nums">{w.utilisation}%</td></tr>)}</tbody></table>
          </Card>
          <Card className="overflow-x-auto p-3"><h2 className="mb-2 font-semibold">Open requests · SLA and holds</h2>
            <table className="w-full"><thead><tr className="text-left text-xs text-[var(--text-muted)]"><th>Request</th><th>SLA</th><th>Assignee</th><th>Due</th><th className="pr-3 text-right">Held</th><th className="pl-3">Hold expires</th></tr></thead>
              <tbody>{ops.data.requests.map((r) => <tr key={r.id} className="border-t border-[var(--border)]"><td className="py-1"><Link className="hover:underline" href={`/desk/${r.id}`}>{r.title}</Link> <span className="text-xs text-[var(--text-muted)]">{r.brand_name}</span></td>
                <td><Badge tone={r.sla === "overdue" ? "danger" : r.sla === "due_soon" ? "warning" : "neutral"}>{r.sla.replace(/_/g, " ")}</Badge></td><td>{r.assignee_name ?? "—"}</td><td className="text-xs">{r.due_at ? new Date(r.due_at).toLocaleString() : "—"}</td>
                <td className="pr-3 text-right tabular-nums">{r.credits_held}</td><td className={cn("pl-3 text-xs", r.holds_lost > 0 && "text-[var(--danger)]")}>{r.holds_lost > 0 ? "lost" : r.hold_expires_at ? new Date(r.hold_expires_at).toLocaleDateString() : "—"}</td></tr>)}</tbody></table>
          </Card>
        </div>
      )}
      {scope !== "ops" && list.data?.data.length === 0 && <p className="text-sm text-[var(--text-muted)]">Nothing here.</p>}
      <div className="flex flex-col gap-2">
        {scope !== "ops" && list.data?.data.map((r) => {
          const late = r.due_at && Date.parse(r.due_at) < now && !["delivered", "approved", "cancelled"].includes(r.status);
          return (
            <Link key={r.id} href={`/desk/${r.id}`}>
              <Card className="flex flex-wrap items-center gap-2 p-3 text-sm hover:border-[var(--accent)]">
                <span className="font-medium">{r.title}</span><span className="text-xs text-[var(--text-muted)]">{r.brandName}</span>
                <Badge tone={r.status === "in_review" || r.status === "submitted" ? "warning" : "neutral"}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                {r.revisions_used > 0 && <Badge>revision {r.revisions_used}</Badge>}
                {r.due_at && <span className={cn("ml-auto text-xs", late ? "font-medium text-[var(--danger)]" : "text-[var(--text-muted)]")}>{late ? "overdue · " : "due "}{new Date(r.due_at).toLocaleString()}</span>}
              </Card>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
