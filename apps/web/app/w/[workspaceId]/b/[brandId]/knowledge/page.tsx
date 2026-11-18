"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Input, cn } from "@arcatic/ui";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { AddSource } from "@/components/knowledge/AddSource";
import { KnowledgeSearch } from "@/components/knowledge/Search";
import { SourceDetail } from "@/components/knowledge/SourceDetail";
import { SourceList, TYPE_LABEL, type SourceRow } from "@/components/knowledge/SourceList";

export default function KnowledgePage() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"library" | "search">("library");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string>();
  const params = new URLSearchParams({ limit: "100", ...(type && { type }), ...(q && { q }) });
  const list = useApi<{ data: SourceRow[] }>(`${base}/sources?${params}`);
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const canEdit = ["owner", "admin", "editor", "contributor"].includes(ws.data?.role ?? "");
  const brand = useApi<{ name: string }>(`${base}`);

  // live status: Realtime on sources (RLS-filtered), with a slow poll as a fallback
  const reload = list.reload;
  useEffect(() => {
    const ch = supabase().channel(`sources:${brandId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sources", filter: `brand_id=eq.${brandId}` }, () => void reload())
      .subscribe();
    const busy = list.data?.data.some((s) => s.status === "processing" || s.status === "pending");
    const t = busy ? setInterval(() => void reload(), 6000) : undefined;
    return () => {
      if (t) clearInterval(t);
      void supabase().removeChannel(ch);
    };
  }, [brandId, reload, list.data]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">{brand.data?.name ?? "Brand"}</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {(["library", "search"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn("rounded-md px-3 py-1.5 text-sm capitalize", view === v ? "bg-[var(--surface-2)] font-medium" : "text-[var(--text-muted)]")}>{v}</button>
          ))}
        </div>
        {canEdit && <Button onClick={() => setAdding((a) => !a)}>{adding ? "Close" : "Add knowledge"}</Button>}
      </div>

      {adding && <AddSource workspaceId={workspaceId} brandId={brandId} onAdded={() => void list.reload()} />}

      {view === "search" ? <KnowledgeSearch base={base} /> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,420px)]">
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Input placeholder="Filter by title" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter by title" />
              <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
                <option value="">All types</option>
                {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {list.error && <p className="text-sm text-[var(--danger)]">{list.error}</p>}
            {list.data && <SourceList rows={list.data.data} onOpen={setOpen} selected={open} />}
          </div>
          {open && <div className="lg:sticky lg:top-4 lg:self-start"><SourceDetail key={open} base={base} sourceId={open} canEdit={canEdit} onChanged={() => void list.reload()} onClose={() => setOpen(undefined)} /></div>}
        </div>
      )}
    </div>
  );
}
