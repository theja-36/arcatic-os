"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { LineChart } from "@/components/analytics/LineChart";

type Plan = { key: string; name: string; monthly_credits: number; price_minor: number | null; currency: string; limits: Record<string, number | boolean>; features?: Record<string, unknown> };
type Billing = {
  subscription: { plan_key: string; status: string; current_period_end: string; cancel_at_period_end: boolean; pending_plan_key: string | null; past_due_since: string | null; cancelled_at: string | null };
  plan: Plan; state: { canSpend: boolean; reason?: string; warning?: string }; usage: Record<string, number>; plans: Plan[];
  packs: Array<{ key: string; name: string; credits: number; price_minor: number; currency: string }>;
  credits: { balance: number; held: number; available: number };
  topups: Array<{ id: string; pack_key: string; credits: number; status: string; created_at: string }>;
  invoices: Array<{ number: string | null; status: string; invoice_type: string | null; amount_minor: number; currency: string; issued_at: string | null; pdf_url: string | null }>;
  billingConfigured: boolean;
};
type Tx = { id: number; delta: number; kind: string; reference: string | null; balance_after: number; created_at: string };
const money = (minor: number | null, cur = "INR") => (minor == null ? "Custom" : new Intl.NumberFormat("en-IN", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(minor / 100));
const LIMIT: Record<string, string> = { max_brands: "Brands", max_seats: "Seats", max_connected_accounts: "Connected accounts" };
const STATUS: Record<string, string> = { trialing: "Trial", incomplete: "Awaiting first payment", active: "Active", past_due: "Payment overdue", cancelled: "Cancelled", paused: "Paused" };
const KIND: Record<string, string> = { grant: "Plan credits", topup: "Credit pack", debit: "Used", refund: "Refund", adjustment: "Adjustment", expiry: "Expired" };

export default function BillingPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/workspaces/${workspaceId}`;
  const b = useApi<Billing>(`${base}/billing`);
  const usage = useApi<{ byDay: Array<{ date: string; used: number }>; byKind: Array<{ kind: string; used: number }> }>(`${base}/billing/usage?days=30`);
  const tx = useApi<{ data: Tx[] }>(`${base}/credits/transactions?limit=50`);
  const me = useApi<{ role: string }>(base);
  const owner = me.data?.role === "owner";
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ err?: boolean; text: string; details?: string[] }>();

  async function run(fn: () => Promise<unknown>, ok: string | ((r: any) => string)) {
    setBusy(true); setMsg(undefined);
    try { const r = await fn(); setMsg({ text: typeof ok === "string" ? ok : ok(r) }); await b.reload(); }
    catch (e) { setMsg({ err: true, text: (e as Error).message, details: e instanceof ApiError && Array.isArray(e.details) ? (e.details as Array<{ message: string }>).map((d) => d.message) : undefined }); }
    finally { setBusy(false); }
  }
  const redirect = (path: string, method = "POST") => run(async () => { const r = await api<{ url: string }>(`${base}${path}`, { method }); window.location.href = r.url; }, "Opening…");

  if (b.error) return <p className="text-sm text-[var(--danger)]">{b.error}</p>;
  const d = b.data;
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10));
  const used = new Map((usage.data?.byDay ?? []).map((x) => [x.date, x.used]));

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold">Billing &amp; credits</h1>
      {d && !d.state.canSpend && <Card className="border-[var(--danger)] p-4 text-sm"><span className="font-medium">Creating is paused.</span> {d.state.reason}</Card>}
      {d?.state.warning && d.state.canSpend && <Card className="border-[var(--warning)] p-4 text-sm">{d.state.warning}</Card>}
      {msg && <div role="status" className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")}>{msg.text}{msg.details && <ul className="list-disc pl-5">{msg.details.map((x) => <li key={x}>{x}</li>)}</ul>}</div>}

      {d && (
        <>
          <section className="grid gap-4 lg:grid-cols-3">
            <Card className="flex flex-col gap-2 lg:col-span-2">
              <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{d.plan.name} plan</h2><Badge tone={d.subscription.status === "active" ? "success" : d.subscription.status === "past_due" || d.subscription.status === "cancelled" ? "danger" : "warning"}>{STATUS[d.subscription.status] ?? d.subscription.status}</Badge></div>
              <p className="text-sm text-[var(--text-muted)]">
                {d.subscription.status === "trialing" ? `Trial ends ${new Date(d.subscription.current_period_end).toDateString()}.` : d.subscription.cancel_at_period_end ? `Ends ${new Date(d.subscription.current_period_end).toDateString()}.` : d.subscription.status === "cancelled" ? `Cancelled ${d.subscription.cancelled_at ? new Date(d.subscription.cancelled_at).toDateString() : ""}.` : `Renews ${new Date(d.subscription.current_period_end).toDateString()} · ${d.plan.monthly_credits.toLocaleString("en-IN")} credits each month.`}
                {d.subscription.pending_plan_key && ` Moves to ${d.plans.find((p) => p.key === d.subscription.pending_plan_key)?.name ?? d.subscription.pending_plan_key} at the end of this period.`}
              </p>
              <ul className="grid gap-1 text-sm sm:grid-cols-3">
                {Object.entries(LIMIT).map(([k, label]) => {
                  const max = d.plan.limits[k] as number | undefined;
                  const n = d.usage[k] ?? 0;
                  return <li key={k} className="flex flex-col"><span className="text-xs text-[var(--text-muted)]">{label}</span><span className={cn("tabular-nums", max !== undefined && n >= max && "text-[var(--warning)]")}>{n} of {max ?? "unlimited"}</span></li>;
                })}
              </ul>
              {owner && d.billingConfigured && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="secondary" className="h-8 px-3 text-xs" disabled={busy} onClick={() => void redirect("/billing/payment-method")}>Payment method</Button>
                  <Button variant="ghost" className="h-8 px-3 text-xs" disabled={busy} onClick={() => void redirect("/billing/portal", "GET")}>Billing portal</Button>
                  {d.subscription.status !== "trialing" && d.subscription.status !== "cancelled" && !d.subscription.cancel_at_period_end && <Button variant="ghost" className="h-8 px-3 text-xs" disabled={busy} onClick={() => { if (confirm("Cancel at the end of this billing period? You keep everything until then; unused credits stay in the wallet.")) void run(() => api(`${base}/billing/cancel`, { method: "POST" }), "Your plan will end at the end of this period."); }}>Cancel plan</Button>}
                  {(d.subscription.cancel_at_period_end || d.subscription.status === "cancelled") && <Button className="h-8 px-3 text-xs" disabled={busy} onClick={() => void run(() => api(`${base}/billing/reactivate`, { method: "POST" }), "Reactivated.")}>Reactivate</Button>}
                </div>
              )}
              {!d.billingConfigured && <p className="text-xs text-[var(--text-muted)]">Paid plans aren&apos;t enabled on this installation yet.</p>}
            </Card>
            <Card className="flex flex-col gap-1">
              <span className="text-sm text-[var(--text-muted)]">Credits available</span>
              <span className="text-3xl font-semibold tabular-nums">{d.credits.available.toLocaleString("en-IN")}</span>
              <span className="text-xs text-[var(--text-muted)]">{d.credits.held ? `${d.credits.held} on hold for running jobs · ` : ""}balance {d.credits.balance.toLocaleString("en-IN")}</span>
              <span className="text-xs text-[var(--text-muted)]">Each job holds its maximum cost and is charged only what it used; failed jobs cost nothing.</span>
            </Card>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">Plans</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {d.plans.filter((p) => p.price_minor).map((p) => {
                const current = p.key === d.plan.key && d.subscription.status !== "trialing" && d.subscription.status !== "cancelled";
                const higher = (p.price_minor ?? 0) > (d.plan.price_minor ?? 0);
                return (
                  <Card key={p.key} className={cn("flex flex-col gap-2 p-4", current && "border-[var(--accent)]")}>
                    <div className="flex items-baseline justify-between"><span className="font-semibold">{p.name}</span><span className="text-sm"><span className="text-lg font-semibold">{money(p.price_minor, p.currency)}</span>/month</span></div>
                    <ul className="text-sm text-[var(--text-muted)]">
                      <li>{p.monthly_credits.toLocaleString("en-IN")} credits a month</li>
                      {Object.entries(LIMIT).map(([k, l]) => <li key={k}>{String(p.limits[k] ?? "Unlimited")} {l.toLowerCase()}</li>)}
                      <li>{p.limits.video ? "Video rendering included" : "No final video rendering"}</li>
                    </ul>
                    {owner && d.billingConfigured && !current && (
                      <Button className="mt-auto h-8 text-xs" variant={higher || d.subscription.status === "trialing" ? "primary" : "secondary"} disabled={busy}
                        onClick={() => void run(() => api<{ kind: string; effective: string }>(`${base}/billing/plan`, { method: "POST", body: JSON.stringify({ planKey: p.key }) }), (r: { kind: string; effective: string }) => r.effective === "now" ? (r.kind === "start" ? `${p.name} started. Credits are added when the first payment goes through.` : `Upgraded to ${p.name}. Lago bills the difference; extra credits arrive when it's paid.`) : `Moving to ${p.name} at the end of this period.`)}>
                        {d.subscription.status === "trialing" || d.subscription.status === "cancelled" ? `Choose ${p.name}` : higher ? `Upgrade to ${p.name}` : `Downgrade to ${p.name}`}
                      </Button>
                    )}
                    {current && <Badge tone="accent">Current plan</Badge>}
                  </Card>
                );
              })}
            </div>
            <p className="text-xs text-[var(--text-muted)]">Upgrades take effect now (Lago charges the prorated difference). Downgrades take effect at the end of the period, once you&apos;re within the smaller plan&apos;s limits. Prices exclude taxes.</p>
          </section>

          {d.packs.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="font-semibold">Credit packs</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                {d.packs.map((p) => (
                  <Card key={p.key} className="flex items-center justify-between gap-2 p-4">
                    <div><p className="font-medium">{p.name}</p><p className="text-sm text-[var(--text-muted)]">{money(p.price_minor, p.currency)} · never expire</p></div>
                    {owner && d.billingConfigured && <Button variant="secondary" className="h-8 px-3 text-xs" disabled={busy || !d.state.canSpend || d.subscription.status === "trialing"}
                      onClick={() => void run(() => api(`${base}/billing/topups`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ packKey: p.key }) }), (r: { note: string }) => r.note)}>Buy</Button>}
                  </Card>
                ))}
              </div>
              {d.topups.length > 0 && <p className="text-xs text-[var(--text-muted)]">Recent: {d.topups.map((t) => `${t.credits} credits (${t.status})`).join(" · ")}</p>}
            </section>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="flex flex-col gap-2 p-4"><h2 className="font-semibold">Credits used per day</h2><LineChart label="Credits" points={days.map((date) => ({ date, value: Math.round((used.get(date) ?? 0) * 10) / 10 }))} /></Card>
            <Card className="flex flex-col gap-2 p-4">
              <h2 className="font-semibold">Where credits went <span className="text-xs font-normal text-[var(--text-muted)]">(30 days)</span></h2>
              <ul className="flex flex-col gap-1 text-sm">{(usage.data?.byKind ?? []).slice(0, 10).map((k) => <li key={k.kind} className="flex justify-between"><span>{k.kind.replace(/[._]/g, " ")}</span><span className="tabular-nums">{Math.round(k.used * 10) / 10}</span></li>)}</ul>
              {!usage.data?.byKind.length && <p className="text-sm text-[var(--text-muted)]">Nothing used yet.</p>}
            </Card>
          </div>

          {d.invoices.length > 0 && (
            <Card className="overflow-x-auto p-0">
              <h2 className="px-4 pt-4 font-semibold">Invoices</h2>
              <table className="w-full text-sm"><tbody className="divide-y divide-[var(--border)]">
                {d.invoices.map((i, n) => <tr key={n}><td className="px-4 py-2">{i.issued_at ? new Date(i.issued_at).toLocaleDateString() : "—"}</td><td className="px-4 py-2">{i.number}</td><td className="px-4 py-2">{i.invoice_type === "subscription" ? "Plan" : "Credit pack"}</td><td className="px-4 py-2 text-right tabular-nums">{money(i.amount_minor, i.currency)}</td><td className="px-4 py-2"><Badge tone={i.status === "paid" ? "success" : i.status === "failed" ? "danger" : "neutral"}>{i.status}</Badge></td><td className="px-4 py-2">{i.pdf_url && <a className="text-[var(--accent)] hover:underline" href={i.pdf_url} target="_blank" rel="noreferrer">PDF</a>}</td></tr>)}
              </tbody></table>
            </Card>
          )}
        </>
      )}

      <Card className="overflow-x-auto p-0">
        <h2 className="px-4 pt-4 font-semibold">Credit history</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--text-muted)]"><tr><th className="px-4 py-2 font-normal">When</th><th className="px-4 py-2 font-normal">Type</th><th className="px-4 py-2 text-right font-normal">Change</th><th className="px-4 py-2 text-right font-normal">Balance</th></tr></thead>
          <tbody className="divide-y divide-[var(--border)]">
            {tx.data?.data.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-2">{new Date(t.created_at).toLocaleString()}</td>
                <td className="px-4 py-2">{KIND[t.kind] ?? t.kind}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${t.delta < 0 ? "" : "text-[var(--success)]"}`}>{t.delta > 0 ? "+" : ""}{t.delta}</td>
                <td className="px-4 py-2 text-right tabular-nums">{t.balance_after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
