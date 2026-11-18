"use client";
import { useState } from "react";
import { Badge, Button, Card } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

type V = { id: string; version: number; status: string; origin: string; note: string | null; completeness: number; changed_fact_ids: string[]; created_at: string; approved_at: string | null };

export function History({ base, onChanged }: { base: string; onChanged: () => void }) {
  const versions = useApi<{ data: V[]; activeVersionId: string | null }>(`${base}/kit/versions`);
  const context = useApi<{ hash: string; tokenEstimate: number; version: number; data: unknown }>(`${base}/context`);
  const [msg, setMsg] = useState("");
  const restore = async (v: number) => {
    try {
      await api(`${base}/kit/versions/${v}/restore`, { method: "POST" });
      setMsg(`Restored version ${v} as a new draft.`);
      onChanged();
      await versions.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {msg && <p className="text-sm">{msg}</p>}
      <Card className="divide-y divide-[var(--border)] p-0">
        {versions.data?.data.map((v) => (
          <div key={v.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium">Version {v.version} <span className="font-normal text-[var(--text-muted)]">· {v.origin.replace("_", " ")} · {new Date(v.created_at).toLocaleString()}</span></p>
              <p className="text-xs text-[var(--text-muted)]">{v.note ?? `${v.changed_fact_ids.length} change(s)`} · {v.completeness}% complete</p>
            </div>
            {v.status === "approved" && <Badge tone="success">active</Badge>}
            {v.status === "superseded" && <Badge>previously approved</Badge>}
            {v.status === "draft" && <Badge tone="neutral">draft</Badge>}
            <Button variant="ghost" onClick={() => restore(v.version)}>Restore</Button>
          </div>
        ))}
      </Card>
      <Card>
        <h3 className="mb-1 font-medium">Brand Context sent to the AI</h3>
        {context.data ? (
          <>
            <p className="mb-2 text-xs text-[var(--text-muted)]">From approved version {context.data.version} · ~{context.data.tokenEstimate} tokens · {context.data.hash.slice(0, 12)}</p>
            <pre className="max-h-96 overflow-auto rounded-md bg-[var(--surface-2)] p-3 text-xs">{JSON.stringify(context.data.data, null, 2)}</pre>
          </>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">Approve a version to create the Brand Context that content generation uses.</p>
        )}
      </Card>
    </div>
  );
}
