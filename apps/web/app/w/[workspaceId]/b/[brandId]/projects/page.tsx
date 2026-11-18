"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Button, Card, EmptyState, Input, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";

type Project = { id: string; name: string; description: string | null; status: string; items: number; updated_at: string };

export default function Projects() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const [archived, setArchived] = useState(false);
  const list = useApi<{ data: Project[] }>(`${base}/projects${archived ? "?status=archived" : ""}`);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState("");
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try { await api(`${base}/projects`, { method: "POST", body: JSON.stringify({ name, description: description || undefined }) }); setName(""); setDescription(""); await list.reload(); }
    catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Projects</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <Card>
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={create}>
          <Input required maxLength={160} placeholder="New project, e.g. Diwali launch 2026" value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" />
          <Input maxLength={2000} placeholder="What it's for (optional)" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
          <Button type="submit">Create</Button>
        </form>
        {err && <p className="mt-2 text-sm text-[var(--danger)]">{err}</p>}
      </Card>
      <div className="flex gap-2 text-sm">
        {[false, true].map((a) => <button key={String(a)} onClick={() => setArchived(a)} aria-pressed={archived === a} className={cn("rounded-md px-3 py-1", archived === a ? "bg-[var(--surface-2)] font-medium" : "text-[var(--text-muted)]")}>{a ? "Archived" : "Active"}</button>)}
      </div>
      {list.data?.data.length === 0 && <EmptyState title={archived ? "No archived projects" : "No projects yet"} body="Group the documents, posts and repurposed pieces for one launch, client or campaign." />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.data?.data.map((p) => (
          <Link key={p.id} href={`/w/${workspaceId}/b/${brandId}/projects/${p.id}`} className="group">
            <Card className="flex h-full flex-col gap-1 p-4 group-hover:border-[var(--accent)]">
              <span className="font-medium">{p.name}</span>
              {p.description && <span className="line-clamp-2 text-sm text-[var(--text-muted)]">{p.description}</span>}
              <span className="mt-auto text-xs text-[var(--text-muted)]">{p.items} item{p.items === 1 ? "" : "s"} · updated {new Date(p.updated_at).toLocaleDateString()}</span>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
