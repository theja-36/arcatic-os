"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { ContentDoc } from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { BlockEditor } from "@/components/content/BlockEditor";
import { Thread, Timeline, type Message } from "@/components/services/Thread";
import { STATUS_LABEL, fileSize } from "@/components/services/format";

type Brief = {
  offering: { name: string; deliverable: string }; requirements: Array<{ label: string; value: string }>; acceptanceCriteria: string[]; dueAt: string;
  brand: { name: string; oneLiner?: string; positioning?: string; audiences: string[]; offers: string[]; voice: { tone: string[]; do: string[]; dont: string[] }; bannedWords: string[]; language: string; colors: string[]; fonts: string[]; disclaimers: string[] };
  source?: { title: string | null; type: string; text: string };
};
type File = { path: string; name: string; mime: string; size: number; url: string | null };
type Detail = {
  id: string; title: string; status: string; brandName: string; due_at: string | null; revisions_used: number; assignee_id: string | null; brief: Brief | null; role: "manager" | "specialist"; mine: boolean;
  offering: { name: string; deliverable_kind: string; deliverable_type: string | null; qa_required: boolean; category: string };
  messages: Message[]; events: Array<{ id: number; kind: string; to_status: string | null; note: string | null; actor_kind: string; created_at: string }>;
  references: Array<{ id: string; title: string | null; kind: string; url: string | null }>; sourceDoc: ContentDoc | null;
  deliverables: Array<{ id: string; round: number; doc: ContentDoc | null; files: File[]; note: string | null; status: string; qa_note: string | null }>;
};
const EMPTY: ContentDoc = { format: 1, blocks: [{ id: "b1", kind: "title", text: "", origin: "human" }, { id: "b2", kind: "paragraph", text: "", origin: "human" }] };

export default function DeskRequest() {
  const { requestId } = useParams<{ requestId: string }>();
  const { data: d, reload, error } = useApi<Detail>(`/desk/requests/${requestId}`);
  const staff = useApi<{ data: Array<{ user_id: string; display_name: string; role: string; load: number; max_active: number; skills: string[] }>; suggested: string[] }>(d?.role === "manager" ? `/desk/staff?requestId=${requestId}` : null);
  const [doc, setDoc] = useState<ContentDoc>();
  const [note, setNote] = useState("");
  const [qaNote, setQaNote] = useState("");
  const [assignee, setAssignee] = useState("");
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [uploading, setUploading] = useState(false);
  const current = d?.deliverables.find((x) => x.round === (d.revisions_used ?? 0) + 1);
  useEffect(() => { setDoc(current?.doc ?? undefined); setNote(current?.note ?? ""); }, [current?.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ch = supabase().channel(`desk:${requestId}`).on("postgres_changes", { event: "*", schema: "public", table: "service_messages", filter: `request_id=eq.${requestId}` }, () => void reload()).subscribe();
    return () => void supabase().removeChannel(ch);
  }, [requestId]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <main className="p-6 text-sm text-[var(--danger)]">{error}</main>;
  if (!d) return <main className="p-6 text-sm text-[var(--text-muted)]">Loading…</main>;
  const run = async (fn: () => Promise<unknown>, ok: string) => { setMsg(undefined); try { await fn(); setMsg({ text: ok }); await reload(); } catch (e) { setMsg({ err: true, text: (e as Error).message }); } };
  const working = d.mine && d.status === "in_progress";
  const needsText = d.offering.deliverable_kind !== "files";
  const needsFiles = d.offering.deliverable_kind !== "content";
  const save = () => api(`/desk/requests/${d.id}/deliverable`, { method: "PUT", body: JSON.stringify({ ...(needsText && { doc: doc ?? null }), note: note || null }) });

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setMsg(undefined);
    try {
      for (const f of Array.from(files)) {
        const t = await api<{ path: string; token: string }>(`/desk/requests/${d!.id}/files`, { method: "POST", body: JSON.stringify({ name: f.name, mime: f.type || "application/octet-stream", size: f.size }) });
        const up = await supabase().storage.from("service-files").uploadToSignedUrl(t.path, t.token, f, { contentType: f.type });
        if (up.error) throw new Error(up.error.message);
        await api(`/desk/requests/${d!.id}/files/confirm`, { method: "POST", body: JSON.stringify({ path: t.path, name: f.name, mime: f.type, size: f.size }) });
      }
      await reload();
    } catch (e) { setMsg({ err: true, text: (e as Error).message }); } finally { setUploading(false); }
  }

  const b = d.brief;
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-8">
      <div>
        <Link href="/desk" className="text-sm text-[var(--text-muted)] hover:underline">← Service desk</Link>
        <div className="mt-1 flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{d.title}</h1><Badge>{d.offering.name}</Badge><Badge tone="warning">{STATUS_LABEL[d.status] ?? d.status}</Badge><span className="text-sm text-[var(--text-muted)]">{d.brandName}</span>
          {d.due_at && <span className="text-sm text-[var(--text-muted)]">· due {new Date(d.due_at).toLocaleString()}</span>}</div>
      </div>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
          {d.role === "manager" && ["submitted", "assigned", "in_progress", "revision_requested"].includes(d.status) && (
            <Card className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Assign</span>
              <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Specialist">
                <option value="">Choose…</option>
                {staff.data?.data.filter((s) => s.role === "specialist").map((s) => <option key={s.user_id} value={s.user_id}>{staff.data!.suggested.includes(s.user_id) ? "★ " : ""}{s.display_name} ({s.load}/{s.max_active})</option>)}
              </select>
              <Button disabled={!assignee} onClick={() => void run(() => api(`/desk/requests/${d.id}/assign`, { method: "POST", body: JSON.stringify({ userId: assignee }) }), "Assigned.")}>Assign</Button>
              {d.status === "assigned" && <Button variant="ghost" onClick={() => void run(() => api(`/desk/requests/${d.id}/unassign`, { method: "POST", body: "{}" }), "Unassigned.")}>Unassign</Button>}
              <span className="text-xs text-[var(--text-muted)]">★ = right skill with spare capacity</span>
            </Card>
          )}

          {d.mine && (d.status === "assigned" || d.status === "revision_requested") && (
            <Card className="flex items-center gap-2 text-sm"><span className="flex-1">{d.status === "revision_requested" ? "The customer asked for a revision — see the messages." : "Ready when you are."}</span><Button onClick={() => void run(() => api(`/desk/requests/${d.id}/start`, { method: "POST", body: "{}" }), "Started.")}>Start work</Button></Card>
          )}

          {current && (
            <Card className="flex flex-col gap-3 text-sm">
              <div className="flex items-center gap-2"><h2 className="font-semibold">Deliverable · round {current.round}</h2><Badge>{current.status}</Badge></div>
              {current.qa_note && <p className="rounded border border-[var(--warning)] p-2">QA: {current.qa_note}</p>}
              {needsText && (doc || working) && <BlockEditor doc={doc ?? EMPTY} onChange={setDoc} issues={[]} selected={new Set()} onSelect={() => undefined} readOnly={!working} />}
              {needsFiles && (
                <div className="flex flex-col gap-1">
                  <ul className="flex flex-col gap-1">{current.files.map((f) => <li key={f.path} className="flex items-center gap-2">{f.url ? <a className="text-[var(--accent)] hover:underline" href={f.url} target="_blank" rel="noreferrer">{f.name}</a> : f.name}<span className="text-xs text-[var(--text-muted)]">{fileSize(f.size)}</span>{working && <button className="text-xs text-[var(--danger)]" onClick={() => void run(() => api(`/desk/requests/${d.id}/files?path=${encodeURIComponent(f.path)}`, { method: "DELETE" }), "Removed.")}>remove</button>}</li>)}</ul>
                  {working && <label className="text-xs">Upload files <input type="file" multiple disabled={uploading} onChange={(e) => void upload(e.target.files)} /></label>}
                </div>
              )}
              <label className="flex flex-col gap-1">Note to the customer<textarea className="min-h-16 rounded border border-[var(--border)] bg-[var(--surface)] p-2" value={note} disabled={!working} onChange={(e) => setNote(e.target.value)} maxLength={5000} /></label>
              {working && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void run(save, "Saved.")}>Save</Button>
                  <Button onClick={() => void run(async () => { await save(); await api(`/desk/requests/${d.id}/submit`, { method: "POST", body: "{}" }); }, d.offering.qa_required ? "Sent to QA." : "Delivered to the customer.")}>{d.offering.qa_required ? "Hand in for QA" : "Deliver"}</Button>
                </div>
              )}
              {d.role === "manager" && d.status === "in_review" && (
                <div className="flex flex-col gap-2 rounded border border-[var(--border)] p-3">
                  <Input placeholder="What needs fixing (required to return)" value={qaNote} onChange={(e) => setQaNote(e.target.value)} />
                  <div className="flex gap-2">
                    <Button onClick={() => void run(() => api(`/desk/requests/${d.id}/qa`, { method: "POST", body: JSON.stringify({ decision: "approve" }) }), "Delivered to the customer.")}>Approve & deliver</Button>
                    <Button variant="secondary" disabled={!qaNote.trim()} onClick={() => void run(() => api(`/desk/requests/${d.id}/qa`, { method: "POST", body: JSON.stringify({ decision: "return", note: qaNote }) }), "Returned to the specialist.")}>Return</Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          <Card className="flex flex-col gap-2">
            <h2 className="font-semibold">Messages</h2>
            <Thread messages={d.messages} me="staff" allowInternal disabled={["approved", "cancelled"].includes(d.status)}
              onSend={async (body, internal) => { await api(`/desk/requests/${d.id}/messages`, { method: "POST", body: JSON.stringify({ body, internal }) }); await reload(); }} />
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          {b && (
            <Card className="flex flex-col gap-2 text-sm">
              <h2 className="font-semibold">Brief</h2>
              <p className="text-xs text-[var(--text-muted)]">Deliver: {b.offering.deliverable}</p>
              {b.requirements.map((r) => <div key={r.label}><p className="text-xs text-[var(--text-muted)]">{r.label}</p><p className="whitespace-pre-wrap">{r.value}</p></div>)}
              <h3 className="mt-2 text-xs font-medium uppercase text-[var(--text-muted)]">Acceptance criteria</h3>
              <ul className="list-disc pl-5">{b.acceptanceCriteria.map((x) => <li key={x}>{x}</li>)}</ul>
              <h3 className="mt-2 text-xs font-medium uppercase text-[var(--text-muted)]">Brand: {b.brand.name}</h3>
              {b.brand.oneLiner && <p>{b.brand.oneLiner}</p>}
              {b.brand.positioning && <p className="text-[var(--text-muted)]">{b.brand.positioning}</p>}
              {b.brand.voice.tone.length > 0 && <p>Tone: {b.brand.voice.tone.join(", ")}</p>}
              {b.brand.voice.do.length > 0 && <p>Do: {b.brand.voice.do.join("; ")}</p>}
              {b.brand.voice.dont.length > 0 && <p>Don't: {b.brand.voice.dont.join("; ")}</p>}
              {b.brand.audiences.length > 0 && <p>Audiences: {b.brand.audiences.join(" · ")}</p>}
              {b.brand.offers.length > 0 && <p>Offers: {b.brand.offers.join(" · ")}</p>}
              {b.brand.colors.length > 0 && <p>Colours: {b.brand.colors.join(", ")}</p>}
              {b.brand.fonts.length > 0 && <p>Fonts: {b.brand.fonts.join(", ")}</p>}
              <p className="text-xs text-[var(--text-muted)]">Language: {b.brand.language}</p>
            </Card>
          )}
          {d.references.length > 0 && <Card className="flex flex-col gap-1 text-sm"><h2 className="font-semibold">Customer files</h2>{d.references.map((r) => <a key={r.id} className="text-[var(--accent)] hover:underline" href={r.url ?? "#"} target="_blank" rel="noreferrer">{r.title ?? r.kind}</a>)}<p className="text-xs text-[var(--text-muted)]">Links expire after an hour; reload for fresh ones.</p></Card>}
          {b?.source && <Card className="flex flex-col gap-1 text-sm"><h2 className="font-semibold">Customer's draft</h2><p className="max-h-64 overflow-auto whitespace-pre-wrap text-[var(--text-muted)]">{b.source.text}</p></Card>}
          <Card className="flex flex-col gap-2"><h2 className="font-semibold">Timeline</h2><Timeline events={d.events} /></Card>
        </div>
      </div>
    </main>
  );
}
