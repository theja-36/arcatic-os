"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { addDays, mondayOf } from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";

type Topic = { id: string; title: string; channel: string | null; content_type: string; planned_for: string; status: string; campaign_id: string; campaign: { name: string } | null };
type PlanView = { topics: Topic[]; weeks: Array<{ weekStart: string; theme: string; focus: string }>; moments: Array<{ name: string; date: string; kind: string }>; strategy: { id: string; title: string } | null };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const chip = (s: string) => (s === "done" ? "border-[var(--success)]" : s === "approved" ? "border-[var(--accent)]" : s === "failed" || s === "blocked" ? "border-[var(--danger)]" : s === "in_production" ? "border-[var(--warning)]" : "border-[var(--border)] border-dashed");

export default function Planner() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const [start, setStart] = useState(mondayOf(new Date().toISOString().slice(0, 10)));
  const end = addDays(start, 27);
  const { data } = useApi<PlanView>(`${base}/plan?from=${start}&to=${end}`);
  const [evName, setEvName] = useState("");
  const [evDate, setEvDate] = useState("");
  const [msg, setMsg] = useState("");
  const weeks = useMemo(() => [0, 1, 2, 3].map((i) => addDays(start, i * 7)), [start]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Planner</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => setStart(addDays(start, -28))} aria-label="Previous 4 weeks">←</Button>
        <span className="text-sm font-medium">{start} – {end}</span>
        <Button variant="ghost" onClick={() => setStart(addDays(start, 28))} aria-label="Next 4 weeks">→</Button>
        <Button variant="ghost" onClick={() => setStart(mondayOf(new Date().toISOString().slice(0, 10)))}>Today</Button>
        {data?.strategy && <span className="text-sm text-[var(--text-muted)]">Strategy: {data.strategy.title}</span>}
      </div>
      {weeks.map((w) => {
        const theme = data?.weeks.find((x) => x.weekStart === w);
        return (
          <section key={w} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-2"><h2 className="text-sm font-semibold">Week of {w}</h2>{theme?.theme && <span className="text-sm text-[var(--text-muted)]">{theme.theme}</span>}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
              {DAYS.map((d, i) => {
                const date = addDays(w, i);
                const items = data?.topics.filter((t) => t.planned_for === date) ?? [];
                const moments = data?.moments.filter((m) => m.date === date) ?? [];
                return (
                  <Card key={date} className="min-h-28 p-2">
                    <p className="mb-1 text-xs text-[var(--text-muted)]">{d} {date.slice(8)}</p>
                    {moments.map((m) => <p key={m.name} className="mb-1 text-xs font-medium text-[var(--accent)]">★ {m.name}</p>)}
                    <div className="flex flex-col gap-1">
                      {items.map((t) => (
                        <Link key={t.id} href={`/w/${workspaceId}/b/${brandId}/campaigns/${t.campaign_id}`} className={cn("rounded border px-1.5 py-1 text-xs hover:bg-[var(--surface-2)]", chip(t.status))} title={`${t.campaign?.name ?? ""} · ${t.status}`}>
                          <span className="font-medium">{t.channel}</span> {t.title}
                        </Link>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}
      <Card className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Your important dates</h2>
        <p className="text-xs text-[var(--text-muted)]">Fixed national days are built in. Add festivals for the year (Ugadi, Diwali, Bathukamma…), store anniversaries and launches so strategies plan around them.</p>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); api(`/workspaces/${workspaceId}/seasonal-events`, { method: "POST", body: JSON.stringify({ name: evName, onDate: evDate }) }).then(() => { setEvName(""); setEvDate(""); setMsg("Added."); }).catch((x: Error) => setMsg(x.message)); }}>
          <Input required placeholder="Name" value={evName} onChange={(e) => setEvName(e.target.value)} aria-label="Event name" className="max-w-xs" />
          <Input required type="date" value={evDate} onChange={(e) => setEvDate(e.target.value)} aria-label="Event date" className="max-w-[12rem]" />
          <Button type="submit" variant="secondary">Add date</Button>
        </form>
        {msg && <p className="text-xs">{msg}</p>}
        <div className="flex flex-wrap gap-2">{data?.moments.map((m) => <Badge key={m.name + m.date}>{m.date.slice(5)} {m.name}</Badge>)}</div>
      </Card>
    </div>
  );
}
