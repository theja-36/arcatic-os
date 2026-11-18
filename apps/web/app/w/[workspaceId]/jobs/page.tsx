"use client";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { Badge, Button, Card, ProgressBar, jobTone } from "@arcatic/ui";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";

type Job = { id: string; kind: string; status: string; progress: number; created_at: string; error: { message: string } | null; actual_credits: number | null };

export default function Jobs() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { data, reload } = useApi<{ data: Job[] }>(`/workspaces/${workspaceId}/jobs?limit=50`);

  // Live updates: RLS limits Realtime rows to jobs this user may read.
  useEffect(() => {
    const ch = supabase()
      .channel(`jobs:${workspaceId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "generation_jobs", filter: `workspace_id=eq.${workspaceId}` }, () => void reload())
      .subscribe();
    return () => {
      void supabase().removeChannel(ch);
    };
  }, [workspaceId, reload]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Activity</h1>
      <Card className="divide-y divide-[var(--border)] p-0">
        {data?.data.map((j) => (
          <div key={j.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{j.kind}</p>
              <p className="text-xs text-[var(--text-muted)]">
                {new Date(j.created_at).toLocaleString()}
                {j.actual_credits != null && ` · ${j.actual_credits} credits`}
                {j.error && ` · ${j.error.message}`}
              </p>
            </div>
            <div className="w-full sm:w-40"><ProgressBar value={j.progress} /></div>
            <Badge tone={jobTone(j.status)}>{j.status}</Badge>
            {(j.status === "queued" || j.status === "running") && (
              <Button variant="ghost" onClick={() => api(`/workspaces/${workspaceId}/jobs/${j.id}/cancel`, { method: "POST" }).then(reload)}>Cancel</Button>
            )}
          </div>
        ))}
        {data?.data.length === 0 && <p className="px-4 py-3 text-sm text-[var(--text-muted)]">Nothing has run yet.</p>}
      </Card>
    </div>
  );
}
