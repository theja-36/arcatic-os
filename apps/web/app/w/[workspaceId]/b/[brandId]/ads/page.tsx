"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, Input, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { ConfirmDialog } from "@/components/ads/ConfirmDialog";
import { OBJECTIVES, money, statusTone } from "@/components/ads/format";

type Account = { id: string; provider: "google_ads" | "meta_ads"; account_ref: string; display_name: string | null; brand_id: string | null; policy: { manage_enabled: boolean; max_daily_budget_minor: number; currency: string } | null };
type Campaign = { id: string; name: string; platform: "google" | "meta"; objective: string; status: string; daily_budget_minor: number | null; currency: string; updated_at: string; compliance: { passed: boolean } | null; openRequest: { action: string; status: string } | null };
type Request = { id: string; action: string; summary: string; payload: { confirm?: string }; requested_by: string | null; created_at: string; campaign: { id: string; name: string; platform: string } | Array<{ id: string; name: string; platform: string }> | null };


function Ads() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const router = useRouter();
  const promote = useSearchParams().get("promote");
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const role = ws.data?.role ?? "";
  const canRead = ["owner", "admin", "editor", "reviewer"].includes(role);
  const canManage = ["owner", "admin", "editor"].includes(role);
  const canApprove = ["owner", "admin"].includes(role);
  const list = useApi<{ data: Campaign[] }>(canRead ? `${base}/ads/campaigns` : null);
  const requests = useApi<{ data: Request[] }>(canRead ? `${base}/ads/requests` : null);
  const accounts = useApi<{ data: Account[]; sidecar: boolean }>(canRead ? `/workspaces/${workspaceId}/ads/accounts` : null);
  const usable = (accounts.data?.data ?? []).filter((a) => !a.brand_id || a.brand_id === brandId);
  const [form, setForm] = useState({ connectionId: "", name: "", objective: "", budget: "", landingUrl: "" });
  const [deciding, setDeciding] = useState<{ r: Request; decision: "approved" | "rejected" }>();
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();

  useEffect(() => {
    const ch = supabase().channel(`ads:${brandId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "ad_campaigns", filter: `brand_id=eq.${brandId}` }, () => { void list.reload(); void requests.reload(); })
      .subscribe();
    return () => void supabase().removeChannel(ch);
  }, [brandId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const acct = usable.find((a) => a.id === form.connectionId);
  const platform = acct ? (acct.provider === "google_ads" ? "google" : "meta") : null;

  async function create(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    try {
      const c = await api<{ id: string }>(`${base}/ads/campaigns`, { method: "POST", body: JSON.stringify({
        connectionId: form.connectionId, platform, name: form.name, objective: form.objective || Object.keys(OBJECTIVES[platform!])[0],
        dailyBudgetMinor: form.budget ? Math.round(Number(form.budget) * 100) : null, landingUrl: form.landingUrl || null,
      }) });
      router.push(`/w/${workspaceId}/b/${brandId}/ads/${c.id}`);
    } catch (err) { setMsg({ err: true, text: (err as Error).message }); }
  }
  async function promoteNow() {
    setMsg(undefined);
    try {
      const c = await api<{ id: string }>(`${base}/ads/promote`, { method: "POST", body: JSON.stringify({ contentItemId: promote, connectionId: form.connectionId, dailyBudgetMinor: form.budget ? Math.round(Number(form.budget) * 100) : undefined }) });
      router.push(`/w/${workspaceId}/b/${brandId}/ads/${c.id}`);
    } catch (err) { setMsg({ err: true, text: (err as Error).message }); }
  }
  const camp = (r: Request) => (Array.isArray(r.campaign) ? r.campaign[0] : r.campaign);

  if (ws.data && !canRead) return (
    <div className="flex flex-col gap-5"><h1 className="text-xl font-semibold">Ads</h1><BrandTabs workspaceId={workspaceId} brandId={brandId} /><p className="text-sm text-[var(--text-muted)]">Your role can't see paid campaigns. Ask an owner or admin.</p></div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Ads</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <Card className="border-[var(--warning)] p-4 text-sm">
        <p className="font-medium">Paid campaigns spend real money.</p>
        <p className="text-[var(--text-muted)]">Arcatic creates campaigns <b>paused</b>. Creating, turning on and changing budgets each need an approval from an owner or admin who types a confirmation; editing a campaign cancels earlier approvals. Pausing works any time. Limits per ad account are set in <Link className="text-[var(--accent)] hover:underline" href={`/w/${workspaceId}/settings/ads`}>Settings → Ad accounts</Link>.</p>
      </Card>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      {(requests.data?.data.length ?? 0) > 0 && (
        <Card className="flex flex-col gap-2">
          <h2 className="font-semibold">Waiting for approval</h2>
          {requests.data!.data.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2 text-sm first:border-t-0 first:pt-0">
              <Badge tone="warning">{r.action.replace("_", " ")}</Badge>
              <Link className="font-medium hover:underline" href={`/w/${workspaceId}/b/${brandId}/ads/${camp(r)?.id}`}>{camp(r)?.name}</Link>
              <span className="min-w-0 flex-1 text-[var(--text-muted)]">{r.summary}</span>
              {canApprove && <><Button className="h-8" onClick={() => setDeciding({ r, decision: "approved" })}>Approve…</Button><Button variant="ghost" className="h-8" onClick={() => setDeciding({ r, decision: "rejected" })}>Reject</Button></>}
            </div>
          ))}
          {!canApprove && <p className="text-xs text-[var(--text-muted)]">Owners and admins approve these.</p>}
        </Card>
      )}

      {canManage && (
        <Card className="flex flex-col gap-3">
          <h2 className="font-semibold">{promote ? "Promote a post as an ad" : "New campaign"}</h2>
          {accounts.data && !accounts.data.sidecar && <p className="text-sm text-[var(--warning)]">The ads service isn't deployed, so campaigns can be drafted but not launched.</p>}
          {usable.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Connect a Google Ads or Meta ad account in Analytics → Sources first.</p>
          ) : (
            <form className="flex flex-col gap-2 text-sm" onSubmit={promote ? (e) => { e.preventDefault(); void promoteNow(); } : create}>
              <div className="flex flex-wrap gap-2">
                <select required className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.target.value, objective: "" })} aria-label="Ad account">
                  <option value="">Ad account…</option>
                  {usable.map((a) => <option key={a.id} value={a.id}>{a.provider === "google_ads" ? "Google Ads" : "Meta"} · {a.display_name ?? a.account_ref}{a.policy?.manage_enabled ? "" : " (management off)"}</option>)}
                </select>
                {!promote && platform && (
                  <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} aria-label="Objective">
                    {Object.entries(OBJECTIVES[platform]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                )}
                <label className="flex items-center gap-1">Daily budget ₹<Input className="w-28" type="number" min={1} step="1" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} aria-label="Daily budget" /></label>
              </div>
              {!promote && <div className="flex flex-wrap gap-2">
                <Input className="w-64" required placeholder="Campaign name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Campaign name" />
                <Input className="min-w-0 flex-1" type="url" placeholder="Landing page (https://…)" value={form.landingUrl} onChange={(e) => setForm({ ...form, landingUrl: e.target.value })} aria-label="Landing page" />
              </div>}
              {acct?.policy && <p className="text-xs text-[var(--text-muted)]">This account allows up to {money(acct.policy.max_daily_budget_minor, acct.policy.currency)} per day per campaign.</p>}
              <div><Button type="submit" disabled={!form.connectionId}>{promote ? "Create draft from post" : "Create draft"}</Button></div>
            </form>
          )}
        </Card>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Campaigns</h2>
        {list.data?.data.length === 0 && <EmptyState title="No campaigns yet" body="Draft one above, or promote a top post from Analytics." />}
        {list.data?.data.map((c) => (
          <Link key={c.id} href={`/w/${workspaceId}/b/${brandId}/ads/${c.id}`} className="block">
            <Card className="flex flex-wrap items-center gap-2 p-3 text-sm hover:border-[var(--accent)]">
              <span className="font-medium">{c.name}</span>
              <Badge>{c.platform === "google" ? "Google" : "Meta"}</Badge>
              <Badge tone={statusTone(c.status)}>{c.status}</Badge>
              {c.compliance && !c.compliance.passed && c.status === "draft" && <Badge tone="danger">needs fixes</Badge>}
              {c.openRequest && <Badge tone="warning">{c.openRequest.action.replace("_", " ")} {c.openRequest.status}</Badge>}
              <span className="ml-auto tabular-nums text-[var(--text-muted)]">{money(c.daily_budget_minor, c.currency)}/day</span>
            </Card>
          </Link>
        ))}
      </section>

      {deciding && (
        <ConfirmDialog
          title={deciding.decision === "approved" ? `Approve: ${deciding.r.action.replace("_", " ")}` : "Reject request"}
          summary={deciding.r.summary}
          phrase={deciding.decision === "approved" ? deciding.r.payload.confirm ?? null : null}
          actionLabel={deciding.decision === "approved" ? "Approve" : "Reject"}
          danger={deciding.decision === "approved"}
          onClose={() => setDeciding(undefined)}
          onConfirm={async (typed) => {
            await api(`${base}/ads/requests/${deciding.r.id}/decide`, { method: "POST", body: JSON.stringify({ decision: deciding.decision, confirmation: typed }) });
            setMsg({ text: deciding.decision === "approved" ? "Approved. Running it now — the campaign updates in a moment." : "Rejected." });
            void requests.reload(); void list.reload();
          }}
        />
      )}
    </div>
  );
}

export default function AdsPage() {
  return <Suspense><Ads /></Suspense>;
}
