"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { money } from "@/components/ads/format";

type Policy = { manage_enabled: boolean; max_daily_budget_minor: number; monthly_spend_cap_minor: number | null; auto_pause_on_cap: boolean; require_separate_approver: boolean; page_id: string | null; instagram_user_id: string | null; currency: string };
type Account = { id: string; provider: "google_ads" | "meta_ads"; account_ref: string; display_name: string | null; status: string; policy: Policy | null };

function AccountCard({ workspaceId, a, canEdit, onSaved }: { workspaceId: string; a: Account; canEdit: boolean; onSaved: () => void }) {
  const p = a.policy;
  const [f, setF] = useState({
    manageEnabled: p?.manage_enabled ?? false, maxDaily: String((p?.max_daily_budget_minor ?? 100_000) / 100), monthlyCap: p?.monthly_spend_cap_minor != null ? String(p.monthly_spend_cap_minor / 100) : "",
    autoPause: p?.auto_pause_on_cap ?? true, separate: p?.require_separate_approver ?? true, pageId: p?.page_id ?? "", igId: p?.instagram_user_id ?? "", confirm: "",
  });
  const [needConfirm, setNeedConfirm] = useState(false);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  async function save() {
    setMsg(undefined);
    try {
      await api(`/workspaces/${workspaceId}/ads/accounts/${a.id}/policy`, { method: "PUT", body: JSON.stringify({
        manageEnabled: f.manageEnabled, maxDailyBudgetMinor: Math.round(Number(f.maxDaily) * 100), monthlySpendCapMinor: f.monthlyCap ? Math.round(Number(f.monthlyCap) * 100) : null,
        autoPauseOnCap: f.autoPause, requireSeparateApprover: f.separate, pageId: f.pageId || null, instagramUserId: f.igId || null, confirm: f.confirm || undefined,
      }) });
      setMsg({ text: "Saved." }); setNeedConfirm(false); setF({ ...f, confirm: "" }); onSaved();
    } catch (e) {
      if (e instanceof ApiError && /Type the ad account id/.test(e.message)) setNeedConfirm(true);
      setMsg({ err: true, text: (e as Error).message });
    }
  }
  return (
    <Card className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{a.provider === "google_ads" ? "Google Ads" : "Meta"} · {a.display_name ?? a.account_ref}</span>
        <span className="text-xs text-[var(--text-muted)]">{a.account_ref}</span>
        <Badge tone={p?.manage_enabled ? "warning" : "neutral"}>{p?.manage_enabled ? "management on" : "read-only (reporting)"}</Badge>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={f.manageEnabled} onChange={(e) => setF({ ...f, manageEnabled: e.target.checked })} />Let Arcatic create and change campaigns in this account (each launch, activation and budget change still needs an approval)</label>
      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-1">Max daily budget per campaign ₹<Input className="w-28" type="number" min={1} disabled={!canEdit} value={f.maxDaily} onChange={(e) => setF({ ...f, maxDaily: e.target.value })} /></label>
        <label className="flex items-center gap-1">Monthly spend cap ₹<Input className="w-32" type="number" min={1} disabled={!canEdit} value={f.monthlyCap} onChange={(e) => setF({ ...f, monthlyCap: e.target.value })} placeholder="none" /></label>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={f.autoPause} onChange={(e) => setF({ ...f, autoPause: e.target.checked })} />Pause this account's Arcatic campaigns automatically when the month's spend reaches the cap</label>
      <label className="flex items-center gap-2"><input type="checkbox" disabled={!canEdit} checked={f.separate} onChange={(e) => setF({ ...f, separate: e.target.checked })} />Require a second person to approve (the requester can't approve their own launch or budget change)</label>
      {a.provider === "meta_ads" && (
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1">Facebook Page id<Input className="w-40" disabled={!canEdit} value={f.pageId} onChange={(e) => setF({ ...f, pageId: e.target.value.replace(/\D/g, "") })} /></label>
          <label className="flex items-center gap-1">Instagram account id (optional)<Input className="w-40" disabled={!canEdit} value={f.igId} onChange={(e) => setF({ ...f, igId: e.target.value.replace(/\D/g, "") })} /></label>
        </div>
      )}
      {needConfirm && <label className="flex flex-col gap-1">Type the ad account id <code>{a.account_ref}</code> to confirm<Input value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="off" /></label>}
      {p && <p className="text-xs text-[var(--text-muted)]">Now: up to {money(p.max_daily_budget_minor, p.currency)}/day per campaign{p.monthly_spend_cap_minor ? `, ${money(p.monthly_spend_cap_minor, p.currency)} per month` : ", no monthly cap"}.</p>}
      {canEdit && <div><Button onClick={() => void save()}>Save</Button></div>}
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
    </Card>
  );
}

export default function AdAccountsSettings() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const canRead = ["owner", "admin", "editor", "reviewer"].includes(ws.data?.role ?? "");
  const canEdit = ["owner", "admin"].includes(ws.data?.role ?? "");
  const accounts = useApi<{ data: Account[]; sidecar: boolean }>(canRead ? `/workspaces/${workspaceId}/ads/accounts` : null);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Ad accounts</h1>
      <p className="text-sm text-[var(--text-muted)]">Connected Google Ads and Meta ad accounts report results to Analytics. Campaign management is off until an owner or admin switches it on here; switching it on or raising a limit asks you to type the account id. Every change is recorded in the audit log.</p>
      {ws.data && !canRead && <p className="text-sm text-[var(--text-muted)]">Your role can't see ad accounts.</p>}
      {accounts.data && !accounts.data.sidecar && <p className="text-sm text-[var(--warning)]">The ads service (ADS_SYNC_URL) isn't configured: reporting and campaign management are unavailable.</p>}
      {accounts.data?.data.length === 0 && <p className="text-sm text-[var(--text-muted)]">No ad accounts yet. Connect one under a brand's Analytics → Sources.</p>}
      {accounts.data?.data.map((a) => <AccountCard key={a.id} workspaceId={workspaceId} a={a} canEdit={canEdit} onSaved={() => void accounts.reload()} />)}
    </div>
  );
}
