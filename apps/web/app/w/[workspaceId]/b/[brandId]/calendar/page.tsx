"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { CalendarEntry } from "@arcatic/core";
import { Button, Card, cn } from "@arcatic/ui";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";

const STATE_STYLE: Record<string, string> = {
  idea: "border-dashed border-[var(--border)] text-[var(--text-muted)]",
  planned: "border-dashed border-[var(--border)] text-[var(--text-muted)]",
  draft: "border-[var(--border)] bg-[var(--surface-2)]",
  in_review: "border-sky-500/40 bg-sky-500/10",
  changes_requested: "border-amber-500/50 bg-amber-500/10",
  approved: "border-emerald-500/40 bg-emerald-500/10",
  scheduled: "border-indigo-500/50 bg-indigo-500/15",
  publishing: "border-indigo-500/50 bg-indigo-500/25",
  published: "border-emerald-600/60 bg-emerald-600/20",
  failed: "border-red-500/60 bg-red-500/15",
  missed: "border-red-500/60 bg-red-500/10",
  cancelled: "border-[var(--border)] line-through text-[var(--text-muted)]",
};
const LABEL: Record<string, string> = {
  idea: "Idea", planned: "Planned", draft: "Draft", in_review: "In review", changes_requested: "Changes requested", approved: "Approved, not scheduled",
  scheduled: "Scheduled", publishing: "Publishing", published: "Published", failed: "Failed", missed: "Missed", cancelled: "Cancelled",
};
const DAY = 86_400_000;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function CalendarPage() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [channel, setChannel] = useState("");
  const [show, setShow] = useState({ plans: true, content: true, posts: true });
  const gridStart = useMemo(() => { const d = new Date(month); d.setDate(1 - ((d.getDay() + 6) % 7)); return d; }, [month]);   // Monday
  const gridEnd = new Date(gridStart.getTime() + 42 * DAY);
  const { data, error, loading } = useApi<{ entries: CalendarEntry[]; unscheduled: CalendarEntry[] }>(
    `/workspaces/${workspaceId}/brands/${brandId}/calendar?from=${encodeURIComponent(gridStart.toISOString())}&to=${encodeURIComponent(gridEnd.toISOString())}`);

  const visible = (e: CalendarEntry) => (!channel || e.channel === channel) && ((e.kind === "topic" && show.plans) || (e.kind === "content" && show.content) || (e.kind === "post" && show.posts));
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of data?.entries ?? []) if (visible(e)) { const k = ymd(new Date(e.date)); byDay.set(k, [...(byDay.get(k) ?? []), e]); }
  const channels = [...new Set((data?.entries ?? []).map((e) => e.channel).filter(Boolean))] as string[];
  const counts = (data?.entries ?? []).reduce<Record<string, number>>((m, e) => ((m[e.state] = (m[e.state] ?? 0) + 1), m), {});
  const href = (e: CalendarEntry) => (e.contentItemId ? `/w/${workspaceId}/b/${brandId}/content/${e.contentItemId}` : e.campaignId ? `/w/${workspaceId}/b/${brandId}/campaigns/${e.campaignId}` : "#");
  const today = ymd(new Date());

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Calendar</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" className="h-8 px-2" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">←</Button>
        <h2 className="min-w-40 text-center font-semibold">{month.toLocaleString(undefined, { month: "long", year: "numeric" })}</h2>
        <Button variant="secondary" className="h-8 px-2" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">→</Button>
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</Button>
        <select className="ml-auto h-8 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
          <option value="">All channels</option>{channels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {(["plans", "content", "posts"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} /> {k === "plans" ? "Plans" : k === "content" ? "Drafts & reviews" : "Posts"}</label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {Object.entries(counts).map(([s, n]) => <span key={s} className={cn("rounded border px-2 py-0.5", STATE_STYLE[s])}>{LABEL[s] ?? s}: {n}</span>)}
      </div>
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      <div className="grid gap-4 xl:grid-cols-[1fr_260px]">
        <div className="overflow-x-auto">
          <div className="grid min-w-[720px] grid-cols-7 gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)]">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--text-muted)]">{d}</div>)}
            {Array.from({ length: 42 }, (_, i) => new Date(gridStart.getTime() + i * DAY)).map((d) => {
              const k = ymd(d);
              const items = byDay.get(k) ?? [];
              return (
                <div key={k} className={cn("min-h-28 bg-[var(--surface)] p-1", d.getMonth() !== month.getMonth() && "opacity-50")}>
                  <div className={cn("mb-1 text-right text-xs", k === today ? "font-bold text-[var(--accent)]" : "text-[var(--text-muted)]")}>{d.getDate()}</div>
                  <div className="flex flex-col gap-1">
                    {items.slice(0, 5).map((e) => (
                      <Link key={e.key} href={href(e)} title={`${LABEL[e.state] ?? e.state}${e.accountName ? ` · ${e.accountName}` : ""}${e.error ? ` · ${e.error}` : ""}`}
                        className={cn("block truncate rounded border px-1 py-0.5 text-[11px] leading-tight hover:opacity-80", STATE_STYLE[e.state])}>
                        {e.kind === "post" && <span className="tabular-nums">{new Date(e.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} </span>}
                        {e.channel ? <span className="font-medium">{e.channel} · </span> : null}{e.title}
                        {e.metrics?.impressions ? <span className="text-[var(--text-muted)]"> · {e.metrics.impressions.toLocaleString()} views</span> : null}
                      </Link>
                    ))}
                    {items.length > 5 && <span className="text-[11px] text-[var(--text-muted)]">+{items.length - 5} more</span>}
                  </div>
                </div>
              );
            })}
          </div>
          {loading && <p className="mt-2 text-xs text-[var(--text-muted)]">Loading…</p>}
        </div>
        <Card className="flex flex-col gap-2 p-4">
          <h3 className="font-semibold">Not scheduled yet</h3>
          {(data?.unscheduled ?? []).filter(visible).length === 0 ? <p className="text-sm text-[var(--text-muted)]">Nothing waiting.</p> : (
            <ul className="flex flex-col gap-1">
              {(data?.unscheduled ?? []).filter(visible).slice(0, 40).map((e) => (
                <li key={e.key}><Link href={href(e)} className={cn("block truncate rounded border px-2 py-1 text-xs", STATE_STYLE[e.state])}>{LABEL[e.state]} · {e.title}</Link></li>
              ))}
            </ul>
          )}
          <p className="text-xs text-[var(--text-muted)]">Performance figures appear on published posts once analytics are collected (Phase 8).</p>
        </Card>
      </div>
    </div>
  );
}
