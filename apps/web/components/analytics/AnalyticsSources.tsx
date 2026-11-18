"use client";
import { useState } from "react";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

type Conn = { id: string; brand_id: string | null; provider: string; display_name: string | null; status: string; last_synced_at: string | null; last_error: string | null };
const NAME: Record<string, string> = { matomo: "Matomo (website)", google_ads: "Google Ads", meta_ads: "Meta ads" };
const sel = "h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2";

export function AnalyticsSources({ workspaceId, brands, manage }: { workspaceId: string; brands: Array<{ id: string; name: string }>; manage: boolean }) {
  const base = `/workspaces/${workspaceId}/analytics`;
  const conns = useApi<{ data: Conn[]; adsSyncAvailable: boolean }>(`${base}/connections`);
  const runs = useApi<{ data: Array<{ source: string; status: string; rows_written: number; error: string | null; started_at: string }> }>(`${base}/sync-runs`);
  const [tab, setTab] = useState<"matomo" | "google" | "meta">("matomo");
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(undefined);
    try { await fn(); setMsg({ text: ok }); setF({}); await Promise.all([conns.reload(), runs.reload()]); }
    catch (e) { setMsg({ err: true, text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  const brandSelect = <select className={sel} value={f.brandId ?? ""} onChange={set("brandId")} aria-label="Brand"><option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>;
  const live = (conns.data?.data ?? []).filter((c) => c.status !== "disconnected");

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Analytics sources</h2>
        <Button variant="secondary" className="h-8 px-3 text-xs" disabled={busy} onClick={() => void run(() => api(`${base}/sync`, { method: "POST" }), "Sync started; figures update in a few minutes.")}>Sync now</Button>
      </div>
      <p className="text-sm text-[var(--text-muted)]">Social post figures come from the publishing service automatically, and email figures from Mautic. Add your website and ad accounts here. Figures sync every 2 hours and insights are recalculated nightly; credentials are stored encrypted.</p>
      {live.length > 0 && (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {live.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate">{NAME[c.provider]} · {c.display_name}</span>
              <span className="text-xs text-[var(--text-muted)]">{brands.find((b) => b.id === c.brand_id)?.name ?? "All brands"}</span>
              <Badge tone={c.last_error ? "danger" : c.status === "active" ? "success" : "neutral"}>{c.last_error ? "error" : c.last_synced_at ? `synced ${new Date(c.last_synced_at).toLocaleDateString()}` : "not synced yet"}</Badge>
              {manage && <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => { if (confirm("Remove this source? Figures already collected are kept.")) void run(() => api(`${base}/connections/${c.id}`, { method: "DELETE" }), "Removed."); }}>Remove</Button>}
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <>
          <div className="flex overflow-hidden rounded-[var(--radius)] border border-[var(--border)] self-start" role="group" aria-label="Add source">
            {([["matomo", "Matomo"], ["google", "Google Ads"], ["meta", "Meta ads"]] as const).map(([k, l]) => <button key={k} onClick={() => { setTab(k); setF({}); }} aria-pressed={tab === k} className={cn("px-3 py-1.5 text-sm", tab === k ? "bg-[var(--surface-2)] font-medium" : "text-[var(--text-muted)]")}>{l}</button>)}
          </div>
          {tab === "matomo" && (
            <form className="grid gap-2 text-sm sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => api(`${base}/connections/matomo`, { method: "PUT", body: JSON.stringify({ baseUrl: f.baseUrl, siteId: f.siteId, token: f.token, brandId: f.brandId || null }) }), "Matomo connected."); }}>
              <Input type="url" required placeholder="https://stats.example.com" value={f.baseUrl ?? ""} onChange={set("baseUrl")} aria-label="Matomo URL" />
              <Input required inputMode="numeric" placeholder="Site ID (e.g. 1)" value={f.siteId ?? ""} onChange={set("siteId")} aria-label="Site ID" />
              <Input type="password" required placeholder="Auth token (Personal → Security)" value={f.token ?? ""} onChange={set("token")} aria-label="Matomo token" />
              {brandSelect}
              <p className="text-xs text-[var(--text-muted)] sm:col-span-2">Links in published posts carry utm_campaign tags, so visits and goals are matched to campaigns. A view-only token is enough.</p>
              <div><Button type="submit" disabled={busy}>Connect Matomo</Button></div>
            </form>
          )}
          {tab === "google" && (
            <form className="grid gap-2 text-sm sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => api(`${base}/connections/google-ads`, { method: "PUT", body: JSON.stringify({ customerId: f.customerId, loginCustomerId: f.loginCustomerId || null, refreshToken: f.refreshToken, brandId: f.brandId || null }) }), "Google Ads connected."); }}>
              <Input required placeholder="Customer ID 123-456-7890" value={f.customerId ?? ""} onChange={set("customerId")} aria-label="Customer ID" />
              <Input placeholder="Manager (login) customer ID, if any" value={f.loginCustomerId ?? ""} onChange={set("loginCustomerId")} aria-label="Login customer ID" />
              <Input type="password" required placeholder="OAuth refresh token (read access)" value={f.refreshToken ?? ""} onChange={set("refreshToken")} aria-label="Refresh token" />
              {brandSelect}
              {!conns.data?.adsSyncAvailable && <p className="text-xs text-[var(--warning)] sm:col-span-2">The ads sync service isn&apos;t running on this installation, so these details can&apos;t be checked yet and nothing will sync until it is.</p>}
              <div><Button type="submit" disabled={busy}>Connect Google Ads</Button></div>
            </form>
          )}
          {tab === "meta" && (
            <form className="grid gap-2 text-sm sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => api(`${base}/connections/meta-ads`, { method: "PUT", body: JSON.stringify({ adAccountId: f.adAccountId, accessToken: f.accessToken, brandId: f.brandId || null }) }), "Meta ad account connected."); }}>
              <Input required placeholder="Ad account ID (act_…)" value={f.adAccountId ?? ""} onChange={set("adAccountId")} aria-label="Ad account ID" />
              <Input type="password" required placeholder="System-user access token (ads_read)" value={f.accessToken ?? ""} onChange={set("accessToken")} aria-label="Access token" />
              {brandSelect}
              {!conns.data?.adsSyncAvailable && <p className="text-xs text-[var(--warning)] sm:col-span-2">The ads sync service isn&apos;t running on this installation, so these details can&apos;t be checked yet and nothing will sync until it is.</p>}
              <div><Button type="submit" disabled={busy}>Connect Meta</Button></div>
            </form>
          )}
        </>
      )}
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
      {runs.data && runs.data.data.length > 0 && (
        <details className="text-xs"><summary className="cursor-pointer text-[var(--text-muted)]">Recent syncs</summary>
          <ul className="mt-1 flex flex-col gap-0.5">{runs.data.data.slice(0, 15).map((r, i) => <li key={i} className={r.status === "failed" ? "text-[var(--danger)]" : ""}>{new Date(r.started_at).toLocaleString()} · {r.source} · {r.status}{r.status === "succeeded" ? ` (${r.rows_written} rows)` : ""}{r.error ? ` · ${r.error}` : ""}</li>)}</ul>
        </details>
      )}
    </Card>
  );
}
