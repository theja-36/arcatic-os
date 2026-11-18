"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { ContentDoc } from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { Thread, Timeline, type Message } from "@/components/services/Thread";
import { fileSize, stageTone } from "@/components/services/format";
import { DocPreview } from "@/components/services/DocPreview";

type Detail = {
  id: string; title: string; status: string; stage: string; intake: Record<string, string>; credits: number | null; due_at: string | null; revisions_included: number; revisions_used: number;
  assigned: boolean; result_content_item_id: string | null; result_asset_ids: string[]; rating: number | null; nextRevisionCredits: number | null;
  offering: { name: string; credits: number; intake_fields: Array<{ key: string; label: string }> } | null;
  messages: Message[]; events: Array<{ id: number; kind: string; to_status: string | null; note: string | null; actor_kind: string; created_at: string }>;
  deliverables: Array<{ id: string; round: number; doc: ContentDoc | null; files: Array<{ name: string; mime: string; size: number; url: string | null }>; note: string | null; status: string }>;
};

export default function ServiceRequestPage() {
  const { workspaceId, brandId, requestId } = useParams<{ workspaceId: string; brandId: string; requestId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const canDecide = ["owner", "admin", "editor", "reviewer"].includes(ws.data?.role ?? "");
  const canRequest = ["owner", "admin", "editor", "contributor"].includes(ws.data?.role ?? "");
  const { data: d, reload } = useApi<Detail>(`${base}/services/${requestId}`);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [rating, setRating] = useState(5);
  const [feedback, setFeedback] = useState("");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"approve" | "revise" | null>(null);
  useEffect(() => {
    const ch = supabase().channel(`svc:${requestId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "service_requests", filter: `id=eq.${requestId}` }, () => void reload())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "service_messages", filter: `request_id=eq.${requestId}` }, () => void reload())
      .subscribe();
    return () => void supabase().removeChannel(ch);
  }, [requestId]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(undefined);
    try { await fn(); setMsg({ text: ok }); setMode(null); await reload(); } catch (e) { setMsg({ err: true, text: e instanceof ApiError && e.code === "insufficient_credits" ? "Not enough credits." : (e as Error).message }); }
  };
  const latest = d.deliverables[0];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href={`/w/${workspaceId}/b/${brandId}/services`} className="text-sm text-[var(--text-muted)] hover:underline">← Services</Link>
        <div className="mt-1 flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{d.title}</h1><Badge tone={stageTone(d.status)}>{d.stage}</Badge>{d.offering && <Badge>{d.offering.name}</Badge>}</div>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          {d.status === "draft" && canRequest && (
            <Card className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex-1">This is a draft. Submitting holds {d.offering?.credits ?? "…"} credits; you're charged only when you approve the delivery.</span>
              <Button onClick={() => void run(() => api(`${base}/services/${d.id}/submit`, { method: "POST", body: "{}" }), "Submitted. The team will pick it up shortly.")}>Submit</Button>
            </Card>
          )}

          {latest && (
            <Card className="flex flex-col gap-3 text-sm">
              <div className="flex items-center gap-2"><h2 className="font-semibold">Delivery {latest.round > 1 ? `(round ${latest.round})` : ""}</h2>{latest.status === "accepted" && <Badge tone="success">accepted</Badge>}</div>
              {latest.note && <p className="rounded bg-[var(--surface-2)] p-2 whitespace-pre-wrap">{latest.note}</p>}
              {latest.doc && <DocPreview doc={latest.doc} />}
              {latest.files.length > 0 && <ul className="flex flex-col gap-1">{latest.files.map((f) => <li key={f.name}>{f.url ? <a className="text-[var(--accent)] hover:underline" href={f.url} target="_blank" rel="noreferrer">{f.name}</a> : f.name} <span className="text-xs text-[var(--text-muted)]">{fileSize(f.size)}</span></li>)}</ul>}
              {d.status === "delivered" && canDecide && !mode && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setMode("approve")}>Approve</Button>
                  <Button variant="secondary" onClick={() => setMode("revise")}>Ask for a revision</Button>
                </div>
              )}
              {mode === "approve" && (
                <div className="flex flex-col gap-2 rounded border border-[var(--border)] p-3">
                  <p>Approving charges {d.credits ?? d.offering?.credits} credits{d.revisions_used > d.revisions_included ? " plus the paid revisions" : ""} and adds the work to {latest.doc ? "Content" : "your media library"}.</p>
                  <label className="flex items-center gap-2">Rating<select className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-2" value={rating} onChange={(e) => setRating(Number(e.target.value))}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)}</option>)}</select></label>
                  <Input placeholder="Feedback for the team (optional)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
                  <div className="flex gap-2"><Button onClick={() => void run(() => api(`${base}/services/${d.id}/approve`, { method: "POST", body: JSON.stringify({ rating, feedback: feedback || undefined }) }), "Approved — it's in your library now.")}>Approve & charge</Button><Button variant="ghost" onClick={() => setMode(null)}>Back</Button></div>
                </div>
              )}
              {mode === "revise" && (
                <div className="flex flex-col gap-2 rounded border border-[var(--border)] p-3">
                  <p>{d.nextRevisionCredits ? `This revision costs ${d.nextRevisionCredits} credits (held now, charged on approval).` : `Included (${d.revisions_included - d.revisions_used} of ${d.revisions_included} left).`}</p>
                  <textarea className="min-h-20 rounded border border-[var(--border)] bg-[var(--surface)] p-2" placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} />
                  <div className="flex gap-2"><Button disabled={note.trim().length < 5} onClick={() => void run(() => api(`${base}/services/${d.id}/revise`, { method: "POST", body: JSON.stringify({ note }) }), "Sent back for a revision.")}>Request revision</Button><Button variant="ghost" onClick={() => setMode(null)}>Back</Button></div>
                </div>
              )}
              {d.status === "approved" && (
                <p className="text-[var(--success)]">
                  {d.result_content_item_id && <Link className="hover:underline" href={`/w/${workspaceId}/b/${brandId}/content/${d.result_content_item_id}`}>Open it in Content →</Link>}
                  {d.result_asset_ids.length > 0 && <> <Link className="hover:underline" href={`/w/${workspaceId}/media`}>{d.result_asset_ids.length} file(s) in Media →</Link></>}
                </p>
              )}
            </Card>
          )}

          <Card className="flex flex-col gap-2">
            <h2 className="font-semibold">Messages</h2>
            <Thread messages={d.messages} me="customer" disabled={d.status === "draft" || d.status === "cancelled" || d.status === "approved"}
              onSend={async (body) => { await api(`${base}/services/${d.id}/messages`, { method: "POST", body: JSON.stringify({ body }) }); await reload(); }} />
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-2 text-sm">
            <h2 className="font-semibold">Request</h2>
            {d.offering?.intake_fields.filter((f) => d.intake[f.key]).map((f) => <div key={f.key}><p className="text-xs text-[var(--text-muted)]">{f.label}</p><p className="whitespace-pre-wrap">{d.intake[f.key]}</p></div>)}
            <p className="text-xs text-[var(--text-muted)]">{d.credits != null ? `${d.credits} credits held` : `${d.offering?.credits ?? "…"} credits on submit`} · revisions {d.revisions_used}/{d.revisions_included} included{d.due_at && !["approved", "cancelled", "draft"].includes(d.status) ? ` · due ${new Date(d.due_at).toLocaleString()}` : ""}</p>
            {["draft", "submitted", "assigned"].includes(d.status) && canRequest && <Button variant="ghost" className="self-start" onClick={() => void run(() => api(`${base}/services/${d.id}/cancel`, { method: "POST", body: "{}" }), "Cancelled; the credits were released.")}>Cancel request</Button>}
          </Card>
          <Card className="flex flex-col gap-2"><h2 className="font-semibold">Progress</h2><Timeline events={d.events} /></Card>
        </div>
      </div>
    </div>
  );
}
