"use client";
import { useState } from "react";
import { Badge, Button, Card, Input } from "@arcatic/ui";
import { api } from "@/lib/api";

type Hit = { chunk_id: string; source_title: string; source_type: string; content: string; page_url: string | null; source_url: string | null; heading_path: string[] | null; start_ms: number | null; score: number };
const ts = (ms: number) => new Date(ms).toISOString().slice(11, 19);

export function KnowledgeSearch({ base }: { base: string }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ mode: string; data: Hit[] }>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      setRes(await api(`${base}/knowledge/search`, { method: "POST", body: JSON.stringify({ query: q, limit: 8 }) }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={search} className="flex gap-2">
        <Input placeholder="Ask your knowledge: “what are our delivery areas?”" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search knowledge" minLength={2} required />
        <Button type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</Button>
      </form>
      {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
      {res && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-[var(--text-muted)]">{res.mode === "hybrid" ? "Meaning + keyword match" : "Keyword match only (embedding service not available)"} · {res.data.length} result(s)</p>
          {res.data.map((h) => {
            const link = h.page_url ?? h.source_url;
            return (
              <Card key={h.chunk_id} className="p-4">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{h.source_title}</span>
                  {h.heading_path?.length ? <span className="text-[var(--text-muted)]">› {h.heading_path.join(" › ")}</span> : null}
                  {h.start_ms != null && <Badge>{ts(h.start_ms)}</Badge>}
                  {link && <a className="text-[var(--accent)]" href={link} target="_blank" rel="noreferrer noopener">open</a>}
                </div>
                <p className="line-clamp-4 whitespace-pre-wrap text-sm">{h.content}</p>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
