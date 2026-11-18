"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, EmptyState, Input, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { AnalyticsSources } from "@/components/analytics/AnalyticsSources";

type AccountType = { identifier: string; label: string; note?: string };
type Conn = { provider: string; base_url: string; username: string | null; status: string; last_checked_at: string | null; last_error: string | null };
type Account = {
  id: string; brand_id: string | null; provider: string; display_name: string | null; avatar_url: string | null; status: string; channel: string; transport: string;
  enabled: boolean; min_role: string; settings: { identifier?: string; siteUrl?: string }; last_synced_at: string | null; last_error: string | null;
};
type Overview = { data: Conn[]; postizConfigured: boolean; channels: Array<{ key: string; label: string; transport: string; accountTypes: AccountType[] }> };
const statusTone = (s: string) => (s === "active" ? "success" : s === "refresh_needed" ? "warning" : s === "disconnected" ? "neutral" : "danger");

function Channels() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const base = `/workspaces/${workspaceId}`;
  const overview = useApi<Overview>(`${base}/publishing/connections`);
  const accounts = useApi<{ data: Account[] }>(`${base}/connected-accounts`);
  const brands = useApi<{ data: Array<{ id: string; name: string }> }>(`${base}/brands`);
  const me = useApi<{ role: string }>(base);
  const manage = ["owner", "admin"].includes(me.data?.role ?? "");
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const [postizKey, setPostizKey] = useState("");
  const [wp, setWp] = useState({ siteUrl: "", username: "", appPassword: "", brandId: "" });
  const [mautic, setMautic] = useState({ baseUrl: "", username: "", password: "" });
  const synced = useRef(false);

  const postiz = overview.data?.data.find((c) => c.provider === "postiz" && c.status === "active");
  const mauticConn = overview.data?.data.find((c) => c.provider === "mautic" && c.status === "active");

  async function run(fn: () => Promise<unknown>, ok: string | ((r: any) => string)) {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await fn();
      setMsg({ text: typeof ok === "string" ? ok : ok(r) });
      await Promise.all([overview.reload(), accounts.reload()]);
    } catch (e) {
      setMsg({ err: true, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const syncText = (r: { postiz?: { added: number; disconnected: number; unsupported: string[]; overLimit: number } }) =>
    r.postiz ? `Synced: ${r.postiz.added} new, ${r.postiz.disconnected} disconnected${r.postiz.overLimit ? `, ${r.postiz.overLimit} added switched off (plan limit)` : ""}${r.postiz.unsupported.length ? `; not supported here: ${r.postiz.unsupported.join(", ")}` : ""}.` : "Synced.";

  // back from a Postiz connect page → pull the new account in
  useEffect(() => {
    if (!search.get("connected") || synced.current || !manage) return;
    synced.current = true;
    void run(() => api(`${base}/connected-accounts/sync`, { method: "POST" }), syncText).then(() => router.replace(`/w/${workspaceId}/settings/channels`));
  }, [search, manage]);  // eslint-disable-line react-hooks/exhaustive-deps

  const connect = (identifier: string) => run(async () => {
    const r = await api<{ url: string }>(`${base}/connected-accounts/connect`, { method: "POST", body: JSON.stringify({ identifier }) });
    window.location.href = r.url;
  }, "Opening the connection page…");
  const patch = (id: string, body: Record<string, unknown>) => run(() => api(`${base}/connected-accounts/${id}`, { method: "PATCH", body: JSON.stringify(body) }), "Saved.");

  const social = overview.data?.channels.filter((c) => c.transport === "postiz") ?? [];
  const list = accounts.data?.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Channels</h1>
        <p className="text-sm text-[var(--text-muted)]">Connect the accounts Arcatic publishes to. Nothing is posted without an approved version.</p>
      </div>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Social accounts</h2>
          {postiz ? <Badge tone="success">publishing service connected</Badge> : <Badge>not set up</Badge>}
        </div>
        {!overview.data?.postizConfigured ? (
          <p className="text-sm text-[var(--text-muted)]">Social publishing isn&apos;t available on this installation yet (the Postiz service URL isn&apos;t configured).</p>
        ) : !postiz ? (
          manage ? (
            <form className="flex flex-col gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); void run(() => api(`${base}/publishing/connections/postiz`, { method: "PUT", body: JSON.stringify({ apiKey: postizKey }) }).then((r) => { setPostizKey(""); return r; }), (r: { sync: { added: number } }) => `Connected; ${r.sync.added} account(s) found.`); }}>
              <p className="text-[var(--text-muted)]">Each workspace has its own organisation in the publishing service (Postiz). Paste that organisation&apos;s public API key (Postiz → Settings → Public API). It&apos;s stored encrypted.</p>
              <div className="flex gap-2"><Input type="password" required minLength={10} value={postizKey} onChange={(e) => setPostizKey(e.target.value)} placeholder="Postiz API key" aria-label="Postiz API key" /><Button type="submit" disabled={busy}>Connect</Button></div>
            </form>
          ) : <p className="text-sm text-[var(--text-muted)]">An owner or admin needs to set up social publishing.</p>
        ) : (
          <>
            {manage && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-[var(--text-muted)]">Add an account (you&apos;ll sign in to the platform, then come back here):</p>
                <div className="flex flex-wrap gap-2">
                  {social.flatMap((c) => c.accountTypes.map((t) => (
                    <Button key={t.identifier} variant="secondary" className="h-8 px-3 text-xs" disabled={busy} title={t.note} onClick={() => void connect(t.identifier)}>+ {t.label}</Button>
                  )))}
                </div>
                <div><Button variant="ghost" className="h-8 px-2 text-xs" disabled={busy} onClick={() => void run(() => api(`${base}/connected-accounts/sync`, { method: "POST" }), syncText)}>Sync accounts</Button></div>
              </div>
            )}
          </>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-0">
        <h2 className="px-5 pt-5 font-semibold">Connected accounts</h2>
        {list.length === 0 && <div className="px-5 pb-5"><EmptyState title="No accounts yet" body="Connect social accounts, a WordPress site or a Mautic instance above." /></div>}
        <div className="divide-y divide-[var(--border)]">
          {list.map((a) => (
            <div key={a.id} className="flex flex-col gap-2 px-5 py-3 lg:flex-row lg:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {a.avatar_url ? <img src={a.avatar_url} alt="" className="h-8 w-8 rounded-full" /> : <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-2)] text-xs uppercase">{a.channel.slice(0, 2)}</div>}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.display_name ?? a.provider}</p>
                  <p className="text-xs text-[var(--text-muted)]">{overview.data?.channels.find((c) => c.key === a.channel)?.label ?? a.channel}{a.last_error ? ` · ${a.last_error}` : ""}</p>
                </div>
                <Badge tone={statusTone(a.status)}>{a.status.replace("_", " ")}</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1"><input type="checkbox" checked={a.enabled} disabled={!manage || busy} onChange={(e) => void patch(a.id, { enabled: e.target.checked })} /> On</label>
                <select className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-1" value={a.brand_id ?? ""} disabled={!manage || busy} aria-label="Brand" onChange={(e) => void patch(a.id, { brandId: e.target.value || null })}>
                  <option value="">All brands</option>{brands.data?.data.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <select className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-1" value={a.min_role} disabled={!manage || busy} aria-label="Who can publish" onChange={(e) => void patch(a.id, { minRole: e.target.value })}>
                  <option value="editor">Editors+ can publish</option><option value="admin">Admins+ can publish</option><option value="owner">Owners only</option>
                </select>
                {manage && a.transport === "postiz" && a.settings.identifier && a.status !== "active" && <Button variant="secondary" className="h-8 px-2 text-xs" onClick={() => void connect(a.settings.identifier!)}>Reconnect</Button>}
                {manage && a.status !== "disconnected" && (
                  <Button variant="ghost" className="h-8 px-2 text-xs" disabled={busy} onClick={() => {
                    if (!confirm(`Disconnect ${a.display_name}? Posts scheduled to it are cancelled.`)) return;
                    const also = a.transport === "postiz" && confirm("Also remove it from the publishing service?");
                    void run(() => api(`${base}/connected-accounts/${a.id}${also ? "?removeFromPostiz=1" : ""}`, { method: "DELETE" }), "Disconnected.");
                  }}>Disconnect</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <AnalyticsSources workspaceId={workspaceId} brands={brands.data?.data ?? []} manage={manage} />

      {manage && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <form className="flex flex-col gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); void run(() => api(`${base}/connected-accounts/wordpress`, { method: "POST", body: JSON.stringify({ ...wp, brandId: wp.brandId || null }) }).then(() => setWp({ siteUrl: "", username: "", appPassword: "", brandId: "" })), "WordPress site connected."); }}>
              <h2 className="font-semibold">WordPress site</h2>
              <p className="text-[var(--text-muted)]">Use an Application Password (WordPress → Users → Profile → Application Passwords), not your login password. HTTPS only.</p>
              <Input type="url" required placeholder="https://blog.example.com" value={wp.siteUrl} onChange={(e) => setWp({ ...wp, siteUrl: e.target.value })} aria-label="Site URL" />
              <Input required placeholder="WordPress username" value={wp.username} onChange={(e) => setWp({ ...wp, username: e.target.value })} aria-label="Username" />
              <Input type="password" required placeholder="Application password" value={wp.appPassword} onChange={(e) => setWp({ ...wp, appPassword: e.target.value })} aria-label="Application password" />
              <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={wp.brandId} onChange={(e) => setWp({ ...wp, brandId: e.target.value })} aria-label="Brand">
                <option value="">All brands</option>{brands.data?.data.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <div><Button type="submit" disabled={busy}>Connect site</Button></div>
            </form>
          </Card>
          <Card>
            <form className="flex flex-col gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); void run(() => api<{ segments: number }>(`${base}/publishing/connections/mautic`, { method: "PUT", body: JSON.stringify(mautic) }).then((r) => { setMautic({ baseUrl: "", username: "", password: "" }); return r; }), (r: { segments: number }) => `Mautic connected; ${r.segments} segment(s) found. Switch on the ones you'll send to.`); }}>
              <div className="flex items-center justify-between"><h2 className="font-semibold">Email (Mautic)</h2>{mauticConn && <Badge tone="success">connected</Badge>}</div>
              <p className="text-[var(--text-muted)]">Each segment becomes an email target. Mautic needs its API and HTTP basic auth enabled (Configuration → API Settings).</p>
              <Input type="url" required placeholder="https://mautic.example.com" value={mautic.baseUrl} onChange={(e) => setMautic({ ...mautic, baseUrl: e.target.value })} aria-label="Mautic URL" />
              <Input required placeholder="API user" value={mautic.username} onChange={(e) => setMautic({ ...mautic, username: e.target.value })} aria-label="Mautic user" />
              <Input type="password" required placeholder="Password" value={mautic.password} onChange={(e) => setMautic({ ...mautic, password: e.target.value })} aria-label="Mautic password" />
              <div className="flex gap-2"><Button type="submit" disabled={busy}>{mauticConn ? "Update" : "Connect Mautic"}</Button>
                {mauticConn && <Button type="button" variant="ghost" disabled={busy} onClick={() => { if (confirm("Disconnect Mautic? Scheduled emails will fail.")) void run(() => api(`${base}/publishing/connections/mautic`, { method: "DELETE" }), "Mautic disconnected."); }}>Disconnect</Button>}
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function ChannelsPage() {
  return <Suspense><Channels /></Suspense>;
}
