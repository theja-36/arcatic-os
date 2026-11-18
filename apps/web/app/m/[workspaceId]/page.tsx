"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import type { MediaAsset } from "@/lib/media";
import { ConfirmDialog } from "@/components/ads/ConfirmDialog";
import { MediaThumb } from "@/components/media/MediaThumb";
import { NotificationsBell } from "@/components/mobile/Notifications";
import { InstallButton } from "@/components/mobile/RegisterSW";

type Tab = "inbox" | "create" | "calendar" | "media" | "status";
type InboxItem = { kind: "content_approval" | "service_delivery" | "ad_request"; id: string; brandId: string | null; brandName: string | null; title: string; subtitle: string; at: string; dueAt: string | null; canDecide: boolean; ref: { contentItemId?: string | null; campaignId?: string | null; confirm?: string | null } };
type Sched = { id: string; brand_id: string; content_item_id: string; publish_at: string; published_at?: string | null; status: string; external_url: string | null; last_error: { message?: string } | null; item: { title: string | null; type: string } | Array<{ title: string | null; type: string }> | null; account: { display_name: string | null; channel: string } | Array<{ display_name: string | null; channel: string }> | null };
const one = <T,>(x: T | T[] | null) => (Array.isArray(x) ? x[0] ?? null : x);
const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "inbox", label: "Inbox", icon: "M4 13h4l2 3h4l2-3h4M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" },
  { id: "create", label: "Create", icon: "M12 5v14M5 12h14" },
  { id: "calendar", label: "Calendar", icon: "M7 3v4M17 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" },
  { id: "media", label: "Media", icon: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5" },
  { id: "status", label: "Status", icon: "M5 12l4 4L19 6" },
];
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const statusTone = (s: string) => (s === "published" ? "success" : s === "failed" || s === "missed" ? "danger" : s === "publishing" ? "warning" : "neutral");

function Inbox({ ws }: { ws: string }) {
  const { data, reload } = useApi<{ data: InboxItem[]; counts: Record<string, number> }>(`/workspaces/${ws}/inbox`);
  const [comment, setComment] = useState<Record<string, string>>({});
  const [ad, setAd] = useState<InboxItem>();
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const decide = async (it: InboxItem, decision: "approved" | "changes_requested") => {
    setMsg(undefined);
    try {
      await api(`/workspaces/${ws}/brands/${it.brandId}/approvals/${it.id}/decide`, { method: "POST", body: JSON.stringify({ decision, comment: comment[it.id] || undefined }) });
      setMsg({ text: decision === "approved" ? "Approved." : "Changes requested." }); void reload();
    } catch (e) { setMsg({ err: true, text: (e as Error).message }); }
  };
  if (!data) return <p className="p-4 text-sm text-[var(--text-muted)]">Loading…</p>;
  return (
    <div className="flex flex-col gap-3 p-4">
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
      {data.data.length === 0 && <Card className="p-6 text-center text-sm text-[var(--text-muted)]">You're all caught up.</Card>}
      {data.data.map((it) => (
        <Card key={`${it.kind}:${it.id}`} className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><Badge>{it.kind === "content_approval" ? "Approval" : it.kind === "service_delivery" ? "Service delivery" : "Ad request"}</Badge>{it.brandName}</div>
          <p className="font-medium">{it.title}</p>
          <p className="text-sm text-[var(--text-muted)]">{it.subtitle}</p>
          {it.kind === "content_approval" && (
            <>
              <Link className="text-sm text-[var(--accent)]" href={`/w/${ws}/b/${it.brandId}/content/${it.ref.contentItemId}`}>Open the draft</Link>
              {it.canDecide && <>
                <Input placeholder="Comment (needed to request changes)" value={comment[it.id] ?? ""} onChange={(e) => setComment({ ...comment, [it.id]: e.target.value })} />
                <div className="grid grid-cols-2 gap-2"><Button className="h-11" onClick={() => void decide(it, "approved")}>Approve</Button><Button className="h-11" variant="secondary" disabled={!comment[it.id]?.trim()} onClick={() => void decide(it, "changes_requested")}>Request changes</Button></div>
              </>}
            </>
          )}
          {it.kind === "service_delivery" && <Link href={`/w/${ws}/b/${it.brandId}/services/${it.id}`}><Button className="h-11 w-full">Review delivery</Button></Link>}
          {it.kind === "ad_request" && it.canDecide && <div className="grid grid-cols-2 gap-2"><Button className="h-11" onClick={() => setAd(it)}>Approve…</Button><Link href={`/w/${ws}/b/${it.brandId}/ads/${it.ref.campaignId}`}><Button className="h-11 w-full" variant="secondary">Details</Button></Link></div>}
        </Card>
      ))}
      {ad && <ConfirmDialog title="Approve ad request" summary={ad.subtitle} phrase={ad.ref.confirm ?? null} actionLabel="Approve" danger onClose={() => setAd(undefined)}
        onConfirm={async (t) => { await api(`/workspaces/${ws}/brands/${ad.brandId}/ads/requests/${ad.id}/decide`, { method: "POST", body: JSON.stringify({ decision: "approved", confirmation: t }) }); setMsg({ text: "Approved." }); void reload(); }} />}
    </div>
  );
}

function QuickCreate({ ws }: { ws: string }) {
  const router = useRouter();
  const { data } = useApi<{ canCreate: boolean; brands: Array<{ id: string; name: string; ready: boolean; languages: string[] }>; types: Array<{ type: string; label: string; channels: string[]; defaultChannel: string | null; cost: { estimate: number } }> }>(`/workspaces/${ws}/quick-create/options`);
  const [brand, setBrand] = useState("");
  const [type, setType] = useState("social_post");
  const [channel, setChannel] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const t = data?.types.find((x) => x.type === type);
  useEffect(() => { if (!brand && data?.brands.find((b) => b.ready)) setBrand(data.brands.find((b) => b.ready)!.id); }, [data, brand]);
  useEffect(() => { setChannel(t?.defaultChannel ?? ""); }, [type]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <p className="p-4 text-sm text-[var(--text-muted)]">Loading…</p>;
  if (!data.canCreate) return <p className="p-4 text-sm text-[var(--text-muted)]">Your role can't create content.</p>;
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(undefined);
    try {
      const b = data!.brands.find((x) => x.id === brand)!;
      const r = await api<{ job: { id: string }; contentItemId?: string }>(`/workspaces/${ws}/brands/${brand}/content`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ type, input: { topic, ...(channel && { channel }), language: b.languages[0] ?? "en" } }) });
      setTopic("");
      setMsg({ text: "Writing it now — you'll find it in Content in a minute." });
      if (r.contentItemId) router.push(`/w/${ws}/b/${brand}/content/${r.contentItemId}`);
    } catch (err) { setMsg({ err: true, text: err instanceof ApiError && err.code === "insufficient_credits" ? "Not enough credits." : (err as Error).message }); } finally { setBusy(false); }
  }
  const sel = "h-11 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-base";
  return (
    <form className="flex flex-col gap-3 p-4" onSubmit={go}>
      <label className="flex flex-col gap-1 text-sm">Brand<select className={sel} value={brand} onChange={(e) => setBrand(e.target.value)}>{data.brands.map((b) => <option key={b.id} value={b.id} disabled={!b.ready}>{b.name}{b.ready ? "" : " (approve its Brand Kit first)"}</option>)}</select></label>
      <label className="flex flex-col gap-1 text-sm">What<select className={sel} value={type} onChange={(e) => setType(e.target.value)}>{data.types.map((x) => <option key={x.type} value={x.type}>{x.label} · {x.cost.estimate} credit{x.cost.estimate === 1 ? "" : "s"}</option>)}</select></label>
      {t && t.channels.length > 1 && <label className="flex flex-col gap-1 text-sm">Channel<select className={sel} value={channel} onChange={(e) => setChannel(e.target.value)}>{t.channels.map((c) => <option key={c}>{c}</option>)}</select></label>}
      <label className="flex flex-col gap-1 text-sm">About<textarea className="min-h-28 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-base" required minLength={3} maxLength={2000} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Our new weekend thali, available from Saturday" /></label>
      <Button type="submit" className="h-12 text-base" disabled={busy || !brand || topic.trim().length < 3}>Generate</Button>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
    </form>
  );
}

function Agenda({ ws }: { ws: string }) {
  const [rows, setRows] = useState<Sched[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const load = async (c?: string | null) => {
    const r = await api<{ data: Sched[]; next_cursor: string | null }>(`/workspaces/${ws}/agenda?limit=40${c ? `&cursor=${encodeURIComponent(c)}` : ""}`);
    setRows((x) => (c ? [...x, ...r.data] : r.data)); setCursor(r.next_cursor);
  };
  useEffect(() => { void load().catch(() => undefined); }, [ws]);  // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => {
    const m = new Map<string, Sched[]>();
    for (const r of rows) { const k = r.publish_at.slice(0, 10); m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m.entries()];
  }, [rows]);
  return (
    <div className="flex flex-col gap-4 p-4">
      {cursor === undefined && <p className="text-sm text-[var(--text-muted)]">Loading…</p>}
      {cursor !== undefined && rows.length === 0 && <Card className="p-6 text-center text-sm text-[var(--text-muted)]">Nothing scheduled in the next two weeks.</Card>}
      {days.map(([d, list]) => (
        <section key={d}>
          <h2 className="mb-2 text-sm font-semibold">{dayLabel(list[0]!.publish_at)}</h2>
          <div className="flex flex-col gap-2">
            {list.map((s) => { const it = one(s.item); const acc = one(s.account); return (
              <Link key={s.id} href={`/w/${ws}/b/${s.brand_id}/content/${s.content_item_id}`}>
                <Card className="flex items-center gap-3 p-3 text-sm"><span className="w-12 tabular-nums text-[var(--text-muted)]">{time(s.publish_at)}</span><span className="min-w-0 flex-1"><span className="block truncate font-medium">{it?.title ?? "Untitled"}</span><span className="text-xs text-[var(--text-muted)]">{acc?.channel} · {acc?.display_name}</span></span><Badge tone={statusTone(s.status)}>{s.status}</Badge></Card>
              </Link>
            ); })}
          </div>
        </section>
      ))}
      {cursor && <Button variant="secondary" onClick={() => void load(cursor)}>Load more</Button>}
    </div>
  );
}

function Media({ ws }: { ws: string }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [rows, setRows] = useState<MediaAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const load = async (c?: string | null) => {
    const p = new URLSearchParams({ limit: "30", ...(q && { q }), ...(kind && { kind }), ...(c && { cursor: c }) });
    const r = await api<{ data: MediaAsset[]; next_cursor: string | null }>(`/workspaces/${ws}/media?${p}`);
    setRows((x) => (c ? [...x, ...r.data] : r.data)); setCursor(r.next_cursor);
  };
  useEffect(() => { const t = setTimeout(() => void load().catch(() => undefined), 250); return () => clearTimeout(t); }, [ws, q, kind]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex gap-2"><Input className="h-11 flex-1 text-base" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search media" />
        <select className="h-11 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind"><option value="">All</option><option value="image">Images</option><option value="video">Videos</option><option value="audio">Audio</option></select></div>
      <div className="grid grid-cols-3 gap-1">{rows.map((a) => <Link key={a.id} href={`/w/${ws}/media`} aria-label={a.title ?? a.kind}><MediaThumb workspaceId={ws} asset={a} className="aspect-square w-full" /></Link>)}</div>
      {cursor && <Button variant="secondary" onClick={() => void load(cursor)}>Load more</Button>}
    </div>
  );
}

function Status({ ws }: { ws: string }) {
  const [filter, setFilter] = useState<"" | "failed" | "active" | "published">("");
  const [rows, setRows] = useState<Sched[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const load = async (c?: string | null) => {
    const p = new URLSearchParams({ limit: "30", ...(filter && { status: filter }), ...(c && { cursor: c }) });
    const r = await api<{ data: Sched[]; next_cursor: string | null }>(`/workspaces/${ws}/publishing/status?${p}`);
    setRows((x) => (c ? [...x, ...r.data] : r.data)); setCursor(r.next_cursor);
  };
  useEffect(() => { void load().catch(() => undefined); }, [ws, filter]);  // eslint-disable-line react-hooks/exhaustive-deps
  const retry = async (s: Sched) => {
    setMsg(undefined);
    try { await api(`/workspaces/${ws}/brands/${s.brand_id}/schedules/${s.id}/retry`, { method: "POST", body: "{}" }); setMsg({ text: "Retrying." }); void load(); } catch (e) { setMsg({ err: true, text: (e as Error).message }); }
  };
  return (
    <div className="flex flex-col gap-3 p-4">
      <div role="tablist" className="flex gap-2 overflow-x-auto text-sm">
        {([["", "All"], ["failed", "Failed"], ["active", "Upcoming"], ["published", "Published"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={filter === k} className={cn("rounded-full border px-3 py-1", filter === k ? "border-[var(--accent)] bg-[var(--surface-2)]" : "border-[var(--border)]")} onClick={() => setFilter(k)}>{l}</button>)}
      </div>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
      {rows.map((s) => { const it = one(s.item); const acc = one(s.account); return (
        <Card key={s.id} className="flex flex-col gap-1 p-3 text-sm">
          <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{it?.title ?? "Untitled"}</span><Badge tone={statusTone(s.status)}>{s.status}</Badge></div>
          <p className="text-xs text-[var(--text-muted)]">{acc?.channel} · {acc?.display_name} · {new Date(s.published_at ?? s.publish_at).toLocaleString()}</p>
          {s.last_error?.message && s.status === "failed" && <p className="text-xs text-[var(--danger)]">{s.last_error.message}</p>}
          <div className="flex gap-3 text-sm">
            {s.external_url && <a className="text-[var(--accent)]" href={s.external_url} target="_blank" rel="noreferrer">View post</a>}
            {(s.status === "failed" || s.status === "missed") && <button className="text-[var(--accent)]" onClick={() => void retry(s)}>Retry</button>}
          </div>
        </Card>
      ); })}
      {cursor && <Button variant="secondary" onClick={() => void load(cursor)}>Load more</Button>}
    </div>
  );
}

function Hub() {
  const { workspaceId: ws } = useParams<{ workspaceId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get("tab") as Tab) || "inbox";
  const w = useApi<{ name: string }>(`/workspaces/${ws}`);
  const inbox = useApi<{ counts: Record<string, number> }>(`/workspaces/${ws}/inbox`);
  const pending = inbox.data ? Object.values(inbox.data.counts).reduce((a, b) => a + b, 0) : 0;
  useEffect(() => { try { localStorage.setItem("arcatic:lastWorkspace", ws); } catch { /* private mode */ } }, [ws]);
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)]">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <Link href="/m" className="min-w-0 flex-1"><p className="truncate font-semibold">{w.data?.name ?? "…"}</p><p className="text-xs text-[var(--text-muted)]">{TABS.find((t) => t.id === tab)?.label}</p></Link>
        <InstallButton className="rounded-full border border-[var(--accent)] px-3 py-1 text-xs text-[var(--accent)]" />
        <NotificationsBell />
        <Link href={`/w/${ws}`} className="text-xs text-[var(--accent)]">Full app</Link>
      </header>
      <main className="flex-1 pb-24">
        {tab === "inbox" && <Inbox ws={ws} />}
        {tab === "create" && <QuickCreate ws={ws} />}
        {tab === "calendar" && <Agenda ws={ws} />}
        {tab === "media" && <Media ws={ws} />}
        {tab === "status" && <Status ws={ws} />}
      </main>
      <nav aria-label="Sections" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)]">
        {TABS.map((t) => (
          <button key={t.id} aria-current={tab === t.id ? "page" : undefined} onClick={() => router.replace(`/m/${ws}?tab=${t.id}`)} className={cn("relative flex h-16 flex-col items-center justify-center gap-0.5 text-[11px]", tab === t.id ? "text-[var(--accent)]" : "text-[var(--text-muted)]")}>
            <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
            {t.label}
            {t.id === "inbox" && pending > 0 && <span className="absolute right-[calc(50%-1.25rem)] top-2 min-w-4 rounded-full bg-[var(--danger)] px-1 text-[10px] leading-4 text-white">{pending}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function MobileHub() {
  return <Suspense><Hub /></Suspense>;
}
