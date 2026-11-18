"use client";
import { Badge, Card, EmptyState, cn } from "@arcatic/ui";
import { formatBytes } from "@/lib/upload";

export type SourceRow = {
  id: string; type: string; title: string; url: string | null; status: string; error: string | null; summary: string | null; tags: string[];
  visibility: string; chunk_count: number; embedded_count: number; byte_size: number | null; duration_ms: number | null; stale: boolean;
  last_ingested_at: string | null; created_at: string; parser: string | null;
};

export const TYPE_LABEL: Record<string, string> = { url: "Web page", crawl: "Website", file: "Document", drive: "Google Drive", media: "Video/audio", text: "Note", social_reference: "Social post" };
const statusTone = (s: string) => (s === "ready" ? "success" : s === "failed" ? "danger" : s === "stale" ? "warning" : "accent");

export function SourceList({ rows, onOpen, selected }: { rows: SourceRow[]; onOpen: (id: string) => void; selected?: string }) {
  if (!rows.length) return <EmptyState title="No knowledge yet" body="Add your website, documents, videos or notes. Arcatic uses them to write accurate, on-brand content and shows where each fact came from." />;
  return (
    <Card className="divide-y divide-[var(--border)] p-0">
      {rows.map((s) => (
        <button key={s.id} onClick={() => onOpen(s.id)} className={cn("flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-[var(--surface-2)]", selected === s.id && "bg-[var(--surface-2)]")}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{s.title}</span>
            <Badge>{TYPE_LABEL[s.type] ?? s.type}</Badge>
            <Badge tone={statusTone(s.status)}>{s.status === "processing" || s.status === "pending" ? "processing…" : s.status}</Badge>
            {s.stale && <Badge tone="warning">needs refresh</Badge>}
            {s.visibility === "private" && <Badge>private</Badge>}
          </div>
          {s.summary && <p className="line-clamp-2 text-sm text-[var(--text-muted)]">{s.summary}</p>}
          {s.status === "failed" && s.error && <p className="text-sm text-[var(--danger)]">{s.error}</p>}
          <p className="text-xs text-[var(--text-muted)]">
            {s.chunk_count > 0 ? `${s.chunk_count} passages` : ""}
            {s.chunk_count > 0 && s.embedded_count < s.chunk_count ? " · keyword search only" : ""}
            {s.duration_ms ? ` · ${Math.round(s.duration_ms / 60000)} min` : ""}
            {s.byte_size ? ` · ${formatBytes(s.byte_size)}` : ""}
            {s.tags.length ? ` · ${s.tags.join(", ")}` : ""}
          </p>
        </button>
      ))}
    </Card>
  );
}
