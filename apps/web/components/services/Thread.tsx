"use client";
import { useState } from "react";
import { Badge, Button, cn } from "@arcatic/ui";
import { when } from "./format";

export type Message = { id: string; author_kind: "customer" | "staff" | "system"; visibility?: "all" | "internal"; body: string; created_at: string };

/** Conversation between the customer and the service team. Staff can add internal notes. */
export function Thread({ messages, me, onSend, allowInternal, disabled }: { messages: Message[]; me: "customer" | "staff"; onSend: (body: string, internal: boolean) => Promise<void>; allowInternal?: boolean; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <ul className="flex max-h-96 flex-col gap-2 overflow-auto">
        {messages.length === 0 && <li className="text-[var(--text-muted)]">No messages yet.</li>}
        {messages.map((m) => (
          <li key={m.id} className={cn("max-w-[85%] rounded-lg px-3 py-2", m.author_kind === me ? "self-end bg-[var(--surface-2)]" : "self-start border border-[var(--border)]", m.visibility === "internal" && "border-dashed border-[var(--warning)]")}>
            <div className="mb-0.5 flex items-center gap-1 text-xs text-[var(--text-muted)]">{m.author_kind === "customer" ? "Customer" : m.author_kind === "staff" ? "Service team" : "Arcatic"} · {when(m.created_at)}{m.visibility === "internal" && <Badge tone="warning">internal</Badge>}</div>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ul>
      {!disabled && (
        <form className="flex flex-col gap-2" onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; setBusy(true); try { await onSend(text.trim(), internal); setText(""); } finally { setBusy(false); } }}>
          <textarea className="min-h-16 rounded border border-[var(--border)] bg-[var(--surface)] p-2" value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} aria-label="Message" placeholder="Write a message…" />
          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" disabled={busy || !text.trim()}>Send</Button>
            {allowInternal && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />Internal note (customer won't see it)</label>}
          </div>
        </form>
      )}
    </div>
  );
}

export function Timeline({ events }: { events: Array<{ id: number; kind: string; to_status: string | null; note: string | null; actor_kind: string; created_at: string }> }) {
  return (
    <ol className="flex flex-col gap-1 border-l border-[var(--border)] pl-3 text-xs text-[var(--text-muted)]">
      {events.map((e) => <li key={e.id}><span className="text-[var(--text)]">{e.kind === "status" ? (e.to_status ?? "").replace(/_/g, " ") : e.kind}</span>{e.note ? ` — ${e.note}` : ""} · {when(e.created_at)}</li>)}
    </ol>
  );
}
