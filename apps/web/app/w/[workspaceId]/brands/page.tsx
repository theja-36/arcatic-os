"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, Input } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

type Brand = { id: string; name: string; website_url: string | null; languages: string[]; status: string; kit_completeness: number; active_kit_version_id: string | null };

export default function Brands() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const { data, reload, error } = useApi<{ data: Brand[] }>(`/workspaces/${workspaceId}/brands`);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [telugu, setTelugu] = useState(false);
  const [msg, setMsg] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    try {
      const created = await api<{ id: string }>(`/workspaces/${workspaceId}/brands`, {
        method: "POST",
        body: JSON.stringify({ name, websiteUrl: url || undefined, languages: telugu ? ["en", "te"] : ["en"] }),
      });
      router.push(`/w/${workspaceId}/b/${created.id}/onboarding`);
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Brands</h1>
        <Button onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Add brand"}</Button>
      </div>
      {open && (
        <Card>
          <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
            <Input required placeholder="Brand name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Brand name" />
            <Input type="url" placeholder="https://website (optional)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Website" />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={telugu} onChange={(e) => setTelugu(e.target.checked)} /> Also create content in Telugu</label>
            <div className="sm:text-right"><Button type="submit">Create</Button></div>
            {msg && <p className="text-sm text-[var(--danger)] sm:col-span-2">{msg}</p>}
          </form>
        </Card>
      )}
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {data?.data.length === 0 && !open && <EmptyState title="No brands yet" body="Create a brand to start building its Brand Kit and knowledge library." />}
      <div className="grid gap-3 sm:grid-cols-2">
        {data?.data.map((b) => (
          <Link key={b.id} href={`/w/${workspaceId}/b/${b.id}/kit`} className="block rounded-[var(--radius)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          <Card className="h-full hover:border-[var(--accent)]">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{b.name}</p>
                <p className="truncate text-sm text-[var(--text-muted)]">{b.website_url ?? "No website yet"}</p>
              </div>
              <Badge tone={b.status === "active" ? "success" : "neutral"}>{b.status}</Badge>
            </div>
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              Languages: {b.languages.join(", ")} · Brand Kit {b.kit_completeness}%{b.active_kit_version_id ? " · approved" : " · not approved yet"}
            </p>
          </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
