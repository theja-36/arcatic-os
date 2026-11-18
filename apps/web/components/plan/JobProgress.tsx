"use client";
import { useEffect, useRef, useState } from "react";
import { Card, ProgressBar } from "@arcatic/ui";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";

type Job = { status: string; progress: number; error: { message: string } | null; events: Array<{ message: string | null }>; output: unknown };

/** Live progress for one background job; calls onDone when it finishes. */
export function JobProgress({ workspaceId, jobId, label, onDone }: { workspaceId: string; jobId: string; label: string; onDone: (job: Job) => void }) {
  const [job, setJob] = useState<Job>();
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let stop = false;
    let finished = false;
    const load = async () => {
      try {
        const j = await api<Job>(`/workspaces/${workspaceId}/jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        if (!finished && ["succeeded", "failed", "cancelled"].includes(j.status)) {
          finished = true;
          done.current(j);
        }
      } catch {
        /* keep last */
      }
    };
    void load();
    const ch = supabase().channel(`job:${jobId}`).on("postgres_changes", { event: "*", schema: "public", table: "generation_jobs", filter: `id=eq.${jobId}` }, () => void load()).subscribe();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
      void supabase().removeChannel(ch);
    };
  }, [workspaceId, jobId]);
  if (!job || job.status === "succeeded") return null;
  const last = [...job.events].reverse().find((e) => e.message)?.message;
  return (
    <Card>
      <div className="mb-2 flex justify-between text-sm"><span className="font-medium">{job.status === "failed" ? `${label} failed` : job.status === "cancelled" ? `${label} cancelled` : `${label}…`}</span><span className="text-[var(--text-muted)]">{job.progress}%</span></div>
      <ProgressBar value={job.progress} />
      <p className="mt-2 text-xs text-[var(--text-muted)]">{job.error?.message ?? last}</p>
      {job.status === "failed" && <p className="mt-1 text-xs">Credits held for this job were released.</p>}
    </Card>
  );
}
