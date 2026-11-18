"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge, Button, Card, EmptyState, jobTone } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useState } from "react";

type Credits = { balance: number; held: number; available: number };
type Job = { id: string; kind: string; status: string; progress: number; created_at: string };

export default function Home() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const credits = useApi<Credits>(`/workspaces/${workspaceId}/credits`);
  const brands = useApi<{ data: Array<{ id: string; name: string }> }>(`/workspaces/${workspaceId}/brands`);
  const jobs = useApi<{ data: Job[] }>(`/workspaces/${workspaceId}/jobs?limit=5`);
  const [testing, setTesting] = useState(false);

  async function selfTest() {
    setTesting(true);
    try {
      await api(`/workspaces/${workspaceId}/jobs/self-test`, { method: "POST", body: JSON.stringify({ steps: 3 }), idempotencyKey: crypto.randomUUID() });
      await jobs.reload();
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Today</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-[var(--text-muted)]">Credits available</p>
          <p className="mt-1 text-2xl font-semibold">{credits.data ? credits.data.available.toLocaleString() : "—"}</p>
          {credits.data && credits.data.held > 0 && <p className="text-xs text-[var(--text-muted)]">{credits.data.held} on hold for running jobs</p>}
        </Card>
        <Card>
          <p className="text-sm text-[var(--text-muted)]">Brands</p>
          <p className="mt-1 text-2xl font-semibold">{brands.data?.data.length ?? "—"}</p>
        </Card>
        <Card>
          <p className="text-sm text-[var(--text-muted)]">Background jobs</p>
          <Button variant="secondary" className="mt-2" onClick={selfTest} disabled={testing}>{testing ? "Starting…" : "Run system check"}</Button>
        </Card>
      </div>

      {brands.data && brands.data.data.length === 0 && (
        <EmptyState
          title="Add your first brand"
          body="A brand holds its voice, visuals, knowledge and campaigns. Next you'll analyse its website to draft a Brand Kit."
          action={<Link href={`/w/${workspaceId}/brands`}><Button>Add brand</Button></Link>}
        />
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Recent activity</h2>
          <Link className="text-sm text-[var(--accent)]" href={`/w/${workspaceId}/jobs`}>View all</Link>
        </div>
        <Card className="divide-y divide-[var(--border)] p-0">
          {jobs.data?.data.length ? jobs.data.data.map((j) => (
            <div key={j.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <span>{j.kind}</span>
              <Badge tone={jobTone(j.status)}>{j.status}</Badge>
            </div>
          )) : <p className="px-4 py-3 text-sm text-[var(--text-muted)]">No jobs yet.</p>}
        </Card>
      </section>
    </div>
  );
}
