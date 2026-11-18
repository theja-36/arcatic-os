"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, Input } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";

type Campaign = { id: string; name: string; status: string; starts_on: string | null; ends_on: string | null; goal: string | null; channels: string[]; topicCounts: Record<string, number>; plan_key: string | null };
const statusTone = (s: string) => (s === "active" ? "success" : s === "paused" ? "warning" : s === "cancelled" ? "danger" : s === "completed" ? "neutral" : "accent");

export default function Campaigns() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const router = useRouter();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const list = useApi<{ data: Campaign[] }>(`${base}/campaigns`);
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const canEdit = ["owner", "admin", "editor"].includes(ws.data?.role ?? "");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [err, setErr] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const c = await api<{ id: string }>(`${base}/campaigns`, { method: "POST", body: JSON.stringify({ name, startsOn: startsOn || undefined, endsOn: endsOn || undefined }) });
      router.push(`/w/${workspaceId}/b/${brandId}/campaigns/${c.id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Campaigns</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      {canEdit && <div><Button variant="secondary" onClick={() => setOpen((x) => !x)}>{open ? "Close" : "New campaign"}</Button></div>}
      {open && (
        <Card>
          <form onSubmit={create} className="grid gap-3 sm:grid-cols-3">
            <Input required placeholder="Campaign name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" className="sm:col-span-3" />
            <label className="flex flex-col gap-1 text-sm">Starts<Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm">Ends<Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label>
            <div className="flex items-end"><Button type="submit">Create</Button></div>
            {err && <p className="text-sm text-[var(--danger)] sm:col-span-3">{err}</p>}
          </form>
        </Card>
      )}
      {list.data?.data.length === 0 && !open && <EmptyState title="No campaigns yet" body="Activate a strategy to create campaigns from its plan, or start one by hand." />}
      <div className="grid gap-3 sm:grid-cols-2">
        {list.data?.data.map((c) => {
          const total = Object.values(c.topicCounts).reduce((a, b) => a + b, 0);
          return (
            <Link key={c.id} href={`/w/${workspaceId}/b/${brandId}/campaigns/${c.id}`}>
              <Card className="h-full hover:border-[var(--accent)]">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{c.name}</p>
                  <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                </div>
                <p className="mt-1 text-sm text-[var(--text-muted)]">{c.starts_on ?? "no start"} → {c.ends_on ?? "open-ended"}{c.goal ? ` · ${c.goal}` : ""}</p>
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  {total} topic(s){c.topicCounts.approved ? ` · ${c.topicCounts.approved} approved` : ""}{c.topicCounts.done ? ` · ${c.topicCounts.done} drafted` : ""}{c.topicCounts.blocked ? ` · ${c.topicCounts.blocked} blocked` : ""}{c.plan_key === "__always_on" ? " · always-on" : ""}
                </p>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
