"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { LineChart } from "@/components/analytics/LineChart";
import { Stat, money, pctFmt } from "@/components/analytics/Stat";

type Social = { posts: number; seen: number; interactions: number; clicks: number; engagementRate: number | null };
type Email = { emails: number; sends: number; delivered: number; opens: number; clicks: number; openRate: number | null; clickRate: number | null };
type Ad = { spendMinor: number; impressions: number; clicks: number; conversions: number; conversionValueMinor: number; currency: string | null };
type Post = { scheduleId: string; contentItemId: string; title: string | null; channel: string; engagementRate: number; seen: number; vsChannel: number | null; url: string | null };
type Trend = { metric: string; current: number; previous: number; change: number | null; direction: string; significant: boolean };
type Overview = {
  social: { current: Social; previous: Social; byChannel: Array<{ channel: string; current: Social; previous: Social }> };
  email: { current: Email; previous: Email };
  website: { current: { visits: number; visitors: number; conversions: number; bounceRate: number | null }; previous: { visits: number; conversions: number } } | null;
  ads: Array<{ source: string; current: Ad; previous: Ad }>;
  followers: Array<{ accountId: string; start: number | null; end: number | null; change: number | null }>;
  series: Array<{ date: string; posts: number; seen: number; interactions: number; visits: number; adSpendMinor: number }>;
  trends: Trend[]; top: Post[]; bottom: Post[]; ranked: number; notes: string[];
};
type Row = { key: string; label: string; posts: number; seen: number; interactions: number; clicks: number; engagementRate: number | null; website?: { visits: number; conversions: number } };
const BY = [["channel", "Channel"], ["campaign", "Campaign"], ["topic", "Topic"], ["content", "Content item"], ["content_type", "Content type"], ["date", "Publish date"]] as const;

export default function AnalyticsPage() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const [period, setPeriod] = useState<"7d" | "30d" | "365d">("30d");
  const [by, setBy] = useState<(typeof BY)[number][0]>("channel");
  const o = useApi<Overview>(`${base}/analytics/overview?period=${period}`);
  const b = useApi<{ data: Row[] }>(`${base}/analytics/breakdown?period=${period}&by=${by}`);
  const runs = useApi<{ data: Array<{ source: string; status: string; rows_written: number; error: string | null; started_at: string }> }>(`/workspaces/${workspaceId}/analytics/sync-runs`);
  const [msg, setMsg] = useState("");
  const d = o.data;
  const lastRun = runs.data?.data[0];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Analytics</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-[var(--radius)] border border-[var(--border)]" role="group" aria-label="Period">
          {(["7d", "30d", "365d"] as const).map((p) => (
            <button key={p} onClick={() => setPeriod(p)} aria-pressed={period === p} className={cn("px-3 py-1.5 text-sm", period === p ? "bg-[var(--surface-2)] font-medium" : "text-[var(--text-muted)]")}>{p === "365d" ? "Year" : p === "7d" ? "7 days" : "30 days"}</button>
          ))}
        </div>
        <span className="ml-auto text-xs text-[var(--text-muted)]">{lastRun ? `Last sync ${new Date(lastRun.started_at).toLocaleString()}` : "Not synced yet"}</span>
        <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => api(`/workspaces/${workspaceId}/analytics/sync`, { method: "POST" }).then(() => setMsg("Syncing in the background; refresh in a minute.")).catch((e) => setMsg((e as Error).message))}>Sync now</Button>
      </div>
      {msg && <p className="text-sm" role="status">{msg}</p>}
      {o.error && <p className="text-sm text-[var(--danger)]">{o.error}</p>}

      {d && (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Posts published" value={d.social.current.posts} previous={d.social.previous.posts} />
            <Stat label="Seen (impressions / views)" value={d.social.current.seen} previous={d.social.previous.seen} />
            <Stat label="Interactions" value={d.social.current.interactions} previous={d.social.previous.interactions} />
            <Stat label="Engagement rate" value={d.social.current.engagementRate} previous={d.social.previous.engagementRate} format={pctFmt} />
            {d.website && <>
              <Stat label="Website visits" value={d.website.current.visits} previous={d.website.previous.visits} />
              <Stat label="Website conversions" value={d.website.current.conversions} previous={d.website.previous.conversions} />
            </>}
            {d.email.current.emails > 0 && <>
              <Stat label="Email open rate" value={d.email.current.openRate} previous={d.email.previous.openRate} format={pctFmt} hint={`${d.email.current.delivered.toLocaleString("en-IN")} delivered`} />
              <Stat label="Email click rate" value={d.email.current.clickRate} previous={d.email.previous.clickRate} format={pctFmt} />
            </>}
            {d.ads.map((a) => <Stat key={a.source} label={`${a.source === "google_ads" ? "Google Ads" : "Meta ads"} spend`} value={a.current.spendMinor} previous={a.previous.spendMinor} format={(n) => money(n, a.current.currency)} hint={`${a.current.conversions} conversions`} invert />)}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="flex flex-col gap-2 p-4"><h2 className="font-semibold">Seen per day <span className="text-xs font-normal text-[var(--text-muted)]">(by publish date)</span></h2><LineChart label="Seen" points={d.series.map((s) => ({ date: s.date, value: s.seen }))} /></Card>
            {d.website ? <Card className="flex flex-col gap-2 p-4"><h2 className="font-semibold">Website visits per day</h2><LineChart label="Visits" points={d.series.map((s) => ({ date: s.date, value: s.visits }))} /></Card>
              : <Card className="flex flex-col gap-2 p-4"><h2 className="font-semibold">Interactions per day</h2><LineChart label="Interactions" points={d.series.map((s) => ({ date: s.date, value: s.interactions }))} /></Card>}
          </div>

          {d.trends.some((t) => t.significant) && (
            <Card className="flex flex-col gap-1 p-4">
              <h2 className="font-semibold">Trends</h2>
              {d.trends.filter((t) => t.significant).map((t) => <p key={t.metric} className="text-sm">{t.direction === "up" ? "▲" : "▼"} {t.metric === "seen" ? "Reach of posts" : "Website visits"} {t.direction} {Math.abs(Math.round((t.change ?? 0) * 100))}% vs the previous period ({t.current.toLocaleString("en-IN")} vs {t.previous.toLocaleString("en-IN")}).</p>)}
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {[["Top posts", d.top], ["Underperformers", d.bottom]].map(([title, list]) => (
              <Card key={title as string} className="flex flex-col gap-2 p-4">
                <h2 className="font-semibold">{title as string}</h2>
                {(list as Post[]).length === 0 ? <p className="text-sm text-[var(--text-muted)]">{d.ranked < 3 ? "Needs at least 3 posts per channel that are 2+ days old with audience figures." : "Nothing stands out from the channel's typical post."}</p> : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {(list as Post[]).map((p) => (
                      <li key={p.scheduleId} className="flex items-center gap-2">
                        <Link href={`/w/${workspaceId}/b/${brandId}/content/${p.contentItemId}`} className="min-w-0 flex-1 truncate hover:underline">{p.title ?? "Untitled"}</Link>
                        <Badge>{p.channel}</Badge>
                        <span className="tabular-nums text-xs">{pctFmt(p.engagementRate)}</span>
                        {p.vsChannel != null && <span className="text-xs text-[var(--text-muted)]">{p.vsChannel.toFixed(1)}× typical</span>}
                        {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent)]">View</a>}
                        {title === "Top posts" && <Link href={`/w/${workspaceId}/b/${brandId}/ads?promote=${p.contentItemId}`} className="text-xs text-[var(--accent)]" title="Turn this post into a paid ad (draft; nothing spends without approval)">Promote</Link>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}
          </div>

          <Card className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">Breakdown</h2>
              <select className="ml-auto h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={by} onChange={(e) => setBy(e.target.value as typeof by)} aria-label="Break down by">
                {BY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {b.data?.data.length === 0 ? <EmptyState title="No published posts in this period" body="Publish from a content item; figures arrive with the next sync." /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead><tr className="text-left text-xs text-[var(--text-muted)]"><th className="py-1">{BY.find((x) => x[0] === by)![1]}</th><th className="py-1 text-right">Posts</th><th className="py-1 text-right">Seen</th><th className="py-1 text-right">Interactions</th><th className="py-1 text-right">Engagement</th><th className="py-1 text-right">Clicks</th>{by === "campaign" && <th className="py-1 text-right">Site visits / conv.</th>}</tr></thead>
                  <tbody>{b.data?.data.map((r) => (
                    <tr key={r.key} className="border-t border-[var(--border)]">
                      <td className="max-w-64 truncate py-1.5">{by === "content" && r.key !== "none" ? <Link className="hover:underline" href={`/w/${workspaceId}/b/${brandId}/content/${r.key}`}>{r.label}</Link> : r.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.posts}</td><td className="py-1.5 text-right tabular-nums">{r.seen.toLocaleString("en-IN")}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.interactions.toLocaleString("en-IN")}</td><td className="py-1.5 text-right tabular-nums">{r.engagementRate == null ? "—" : pctFmt(r.engagementRate)}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.clicks.toLocaleString("en-IN")}</td>
                      {by === "campaign" && <td className="py-1.5 text-right tabular-nums">{r.website ? `${r.website.visits} / ${r.website.conversions}` : "—"}</td>}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            {d.notes.map((n) => <p key={n}>{n}</p>)}
            {runs.data?.data.filter((r) => r.status === "failed").slice(0, 3).map((r, i) => <p key={i} className="text-[var(--danger)]">Last {r.source} sync failed: {r.error}</p>)}
            <p>Sources are set up in Settings → Channels (social, email, Matomo, Google Ads, Meta). <Link className="text-[var(--accent)] hover:underline" href={`/w/${workspaceId}/b/${brandId}/insights`}>See insights and learning →</Link></p>
          </div>
        </>
      )}
    </div>
  );
}
