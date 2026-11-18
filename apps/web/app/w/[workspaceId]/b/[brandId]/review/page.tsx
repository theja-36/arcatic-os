"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge, Card, EmptyState } from "@arcatic/ui";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";

type A = { id: string; created_at: string; due_at: string | null; item: { id: string; title: string | null; type: string; channel: string | null; language: string } | null };

export default function Review() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const { data } = useApi<{ data: A[] }>(`/workspaces/${workspaceId}/brands/${brandId}/approvals?status=pending`);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Review</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      {data?.data.length === 0 && <EmptyState title="Nothing waiting for review" body="Drafts submitted for approval show up here." />}
      <Card className="divide-y divide-[var(--border)] p-0">
        {data?.data.map((a) => a.item && (
          <Link key={a.id} href={`/w/${workspaceId}/b/${brandId}/content/${a.item.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-[var(--surface-2)] sm:flex-row sm:items-center sm:gap-3">
            <span className="min-w-0 flex-1 truncate font-medium">{a.item.title ?? "Untitled"}</span>
            <span className="flex gap-1"><Badge>{a.item.type.replace("_", " ")}</Badge>{a.item.channel && <Badge>{a.item.channel}</Badge>}</span>
            <span className="text-xs text-[var(--text-muted)]">submitted {new Date(a.created_at).toLocaleString()}{a.due_at ? ` · due ${new Date(a.due_at).toLocaleDateString()}` : ""}</span>
          </Link>
        ))}
      </Card>
    </div>
  );
}
