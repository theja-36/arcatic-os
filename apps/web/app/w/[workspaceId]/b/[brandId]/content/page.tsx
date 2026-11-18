"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { CONTENT_TYPE_DEFS } from "@arcatic/core";
import { Badge, Button, Card, EmptyState, Input } from "@arcatic/ui";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";

type Row = { id: string; title: string | null; type: string; channel: string | null; language: string; status: string; updated_at: string; current: { version: number; validation_report: { passed: boolean } | null } | null };
const tone = (s: string) => (s === "approved" ? "success" : s === "in_review" ? "accent" : s === "changes_requested" || s === "failed" ? "danger" : s === "generating" ? "warning" : "neutral");

export default function ContentList() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const params = new URLSearchParams({ limit: "100", ...(type && { type }), ...(status && { status }), ...(q && { q }) });
  const { data } = useApi<{ data: Row[] }>(`/workspaces/${workspaceId}/brands/${brandId}/content?${params}`);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Content</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Search titles" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" aria-label="Search" />
        <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>{Object.entries(CONTENT_TYPE_DEFS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Active</option>{["draft", "in_review", "changes_requested", "approved", "archived"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
        <Link href={`/w/${workspaceId}/b/${brandId}/create`} className="ml-auto"><Button>Create</Button></Link>
      </div>
      {data?.data.length === 0 && <EmptyState title="Nothing here yet" body="Create a post, email, blog, visual or image, or generate drafts from a campaign." />}
      <Card className="divide-y divide-[var(--border)] p-0">
        {data?.data.map((c) => (
          <Link key={c.id} href={`/w/${workspaceId}/b/${brandId}/content/${c.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-[var(--surface-2)] sm:flex-row sm:items-center sm:gap-3">
            <span className="min-w-0 flex-1 truncate font-medium">{c.title ?? "Untitled"}</span>
            <span className="flex flex-wrap gap-1">
              <Badge>{CONTENT_TYPE_DEFS[c.type as keyof typeof CONTENT_TYPE_DEFS]?.label ?? c.type}</Badge>
              {c.channel && <Badge>{c.channel}</Badge>}
              {c.language !== "en" && <Badge>{c.language}</Badge>}
              <Badge tone={tone(c.status)}>{c.status.replace("_", " ")}</Badge>
              {c.current?.validation_report && !c.current.validation_report.passed && <Badge tone="danger">needs fixes</Badge>}
            </span>
            <span className="text-xs text-[var(--text-muted)]">{new Date(c.updated_at).toLocaleDateString()}</span>
          </Link>
        ))}
      </Card>
    </div>
  );
}
