"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { CONTENT_TYPE_DEFS } from "@arcatic/core";
import { Badge, Button, Card, EmptyState, Input } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";

type Item = { id: string; type: string; channel: string | null; title: string | null; status: string; source_ref: { title: string } | null; updated_at: string };
type Project = { id: string; name: string; description: string | null; status: string; items: Item[]; runs: Array<{ id: string; status: string; source_ref: { title: string }; created_at: string }> };

export default function ProjectPage() {
  const { workspaceId, brandId, projectId } = useParams<{ workspaceId: string; brandId: string; projectId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const b = `/w/${workspaceId}/b/${brandId}`;
  const p = useApi<Project>(`${base}/projects/${projectId}`);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [err, setErr] = useState("");
  const save = (patch: Record<string, unknown>) => api(`${base}/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(patch) }).then(() => { setEditing(false); return p.reload(); }).catch((e) => setErr((e as Error).message));
  if (p.error) return <p className="text-sm text-[var(--danger)]">{p.error}</p>;
  if (!p.data) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  const d = p.data;
  const byType = d.items.reduce<Record<string, Item[]>>((m, i) => ((m[i.type] ??= []).push(i), m), {});
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold"><Link className="text-[var(--text-muted)] hover:underline" href={`${b}/projects`}>Projects</Link> / {d.name} {d.status === "archived" && <Badge>archived</Badge>}</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <Card className="flex flex-col gap-2">
        {editing ? (
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void save({ name: form.name, description: form.description || null }); }}>
            <Input required maxLength={160} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Name" />
            <textarea className="min-h-16 rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} aria-label="Description" />
            <div className="flex gap-2"><Button type="submit">Save</Button><Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
          </form>
        ) : (
          <>
            <p className="text-sm">{d.description ?? <span className="text-[var(--text-muted)]">No description.</span>}</p>
            <div className="flex flex-wrap gap-2">
              {d.status === "active" && <Link href={`${b}/create?project=${d.id}`}><Button className="h-8 px-3 text-xs">Create in this project</Button></Link>}
              {d.status === "active" && <Link href={`${b}/repurpose?project=${d.id}`}><Button variant="secondary" className="h-8 px-3 text-xs">Repurpose into this project</Button></Link>}
              <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => { setForm({ name: d.name, description: d.description ?? "" }); setEditing(true); }}>Edit</Button>
              <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => void save({ status: d.status === "active" ? "archived" : "active" })}>{d.status === "active" ? "Archive" : "Restore"}</Button>
            </div>
          </>
        )}
        {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
      </Card>
      {d.items.length === 0 && <EmptyState title="Nothing in this project yet" body="Create drafts or repurpose a source into it; you can also move existing content here from its page." />}
      {Object.entries(byType).map(([t, items]) => (
        <Card key={t} className="flex flex-col gap-1 p-4">
          <h2 className="font-semibold">{CONTENT_TYPE_DEFS[t as keyof typeof CONTENT_TYPE_DEFS]?.label ?? t} <span className="text-sm font-normal text-[var(--text-muted)]">({items.length})</span></h2>
          <ul className="divide-y divide-[var(--border)] text-sm">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <Link href={`${b}/content/${i.id}`} className="min-w-0 flex-1 truncate hover:underline">{i.title ?? "Untitled"}</Link>
                {i.channel && <Badge>{i.channel}</Badge>}
                {i.source_ref && <span className="text-xs text-[var(--text-muted)]">from “{i.source_ref.title}”</span>}
                <Badge tone={i.status === "approved" || i.status === "published" ? "success" : i.status === "in_review" ? "accent" : "neutral"}>{i.status.replace("_", " ")}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {d.runs.length > 0 && (
        <Card className="flex flex-col gap-1 p-4">
          <h2 className="font-semibold">Repurpose runs</h2>
          <ul className="text-sm">{d.runs.map((r) => <li key={r.id}>{new Date(r.created_at).toLocaleDateString()} · “{r.source_ref.title}” · {r.status}</li>)}</ul>
        </Card>
      )}
    </div>
  );
}
