"use client";
import { useState } from "react";
import { Button, Card, cn } from "@arcatic/ui";
import { api } from "@/lib/api";

/** Quick rating / note on a draft; stored as a learning signal against its prompt and model. */
export function Feedback({ workspaceId, brandId, contentId }: { workspaceId: string; brandId: string; contentId: string }) {
  const [rating, setRating] = useState<number>();
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  async function send() {
    try {
      await api(`/workspaces/${workspaceId}/brands/${brandId}/content/${contentId}/feedback`, { method: "POST", body: JSON.stringify({ rating, note: note.trim() || undefined }) });
      setMsg({ text: "Thanks, noted." }); setRating(undefined); setNote("");
    } catch (e) { setMsg({ err: true, text: (e as Error).message }); }
  }
  return (
    <Card className="flex flex-col gap-2">
      <h3 className="font-semibold">How good was this draft?</h3>
      <div className="flex gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={rating === n} onClick={() => setRating(n)} className={cn("h-8 w-8 rounded border text-sm", rating === n ? "border-[var(--accent)] bg-[var(--surface-2)] font-medium" : "border-[var(--border)]")}>{n}</button>)}
      </div>
      <textarea className="min-h-14 rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" placeholder="What would make it better? (optional)" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      <div><Button variant="secondary" className="h-8 px-3 text-xs" disabled={!rating && !note.trim()} onClick={() => void send()}>Send feedback</Button></div>
      {msg && <p className={cn("text-xs", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")}>{msg.text}</p>}
    </Card>
  );
}
