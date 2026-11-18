"use client";
import { useState } from "react";
import { Badge, Button, Card } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { TYPE_LABEL } from "./SourceList";

type Detail = {
  id: string; type: string; title: string; url: string | null; status: string; summary: string | null; tags: string[]; visibility: string; owner_id: string | null;
  chunk_count: number; embedded_count: number; embedding_model: string | null; parser: string | null; language: string | null; last_ingested_at: string | null;
  preview: string | null; previewTruncated: boolean; stale: boolean; metadata: { embedding_error?: string | null; truncated_at_minutes?: number | null; partial?: boolean };
  children: { data: Array<{ id: string; title: string; url: string; status: string; chunk_count: number }>; total: number };
};

export function SourceDetail({ base, sourceId, canEdit, onChanged, onClose }: { base: string; sourceId: string; canEdit: boolean; onChanged: () => void; onClose: () => void }) {
  const { data, reload } = useApi<Detail>(`${base}/sources/${sourceId}`);
  const [msg, setMsg] = useState("");
  if (!data) return <Card><p className="text-sm text-[var(--text-muted)]">Loading…</p></Card>;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setMsg(done);
      await reload();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">{data.title}</h2>
          <p className="text-xs text-[var(--text-muted)]">{TYPE_LABEL[data.type]}{data.parser ? ` · read with ${data.parser}` : ""}{data.language ? ` · ${data.language}` : ""}{data.last_ingested_at ? ` · updated ${new Date(data.last_ingested_at).toLocaleDateString()}` : ""}</p>
          {data.url && <a className="break-all text-sm text-[var(--accent)]" href={data.url} target="_blank" rel="noreferrer noopener">{data.url}</a>}
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close">✕</Button>
      </div>
      {data.summary && <p className="text-sm">{data.summary}</p>}
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge>{data.chunk_count} passages</Badge>
        <Badge tone={data.embedded_count === data.chunk_count && data.chunk_count > 0 ? "success" : "warning"}>{data.embedded_count === data.chunk_count && data.chunk_count > 0 ? `semantic search (${data.embedding_model})` : "keyword search only"}</Badge>
        {data.metadata.truncated_at_minutes && <Badge tone="warning">transcribed first {data.metadata.truncated_at_minutes} min</Badge>}
        {data.metadata.partial && <Badge tone="warning">partly readable</Badge>}
      </div>
      {data.metadata.embedding_error && <p className="text-xs text-[var(--warning)]">Embedding service unavailable when indexed; refresh later for semantic search.</p>}

      {data.children.total > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-medium">{data.children.total} pages</h3>
          <ul className="max-h-48 space-y-1 overflow-auto text-sm">
            {data.children.data.map((ch) => (
              <li key={ch.id} className="flex items-center justify-between gap-2">
                <span className="truncate" title={ch.url}>{ch.title}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">{ch.status === "ready" ? `${ch.chunk_count} passages` : ch.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.preview && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Extracted text</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--surface-2)] p-3 text-xs">{data.preview}{data.previewTruncated ? "\n…" : ""}</pre>
        </details>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {data.type !== "drive" && data.status !== "processing" && (
            <Button variant="secondary" onClick={() => act(() => api(`${base}/sources/${sourceId}/refresh`, { method: "POST", idempotencyKey: crypto.randomUUID() }), "Refreshing…")}>
              {data.stale ? "Refresh now" : "Re-index"}
            </Button>
          )}
          <Button variant="ghost" onClick={() => act(() => api(`${base}/sources/${sourceId}`, { method: "PATCH", body: JSON.stringify({ visibility: data.visibility === "private" ? "brand" : "private" }) }), "Saved.")}>
            {data.visibility === "private" ? "Share with team" : "Make private"}
          </Button>
          <Button variant="ghost" onClick={() => { if (confirm("Delete this source and everything indexed from it?")) void act(() => api(`${base}/sources/${sourceId}`, { method: "DELETE" }).then(onClose), "Deleted."); }}>Delete</Button>
        </div>
      )}
      {msg && <p className="text-sm">{msg}</p>}
    </Card>
  );
}
