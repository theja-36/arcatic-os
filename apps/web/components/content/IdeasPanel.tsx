"use client";
import { useState } from "react";
import type { ContentDoc } from "@arcatic/core";
import { Badge, Button, Card, cn } from "@arcatic/ui";
import { api } from "@/lib/api";

type Idea = { title: string; angle: string; format: string; channel: string; why: string };
const FORMAT: Record<string, string> = { social_post: "Post", carousel: "Carousel", short_video: "Short video", blog: "Blog", email: "Email", x_thread: "X thread", newsletter: "Newsletter", case_study: "Case study" };

/** Pick ideas from a brainstorm list and start a draft for each. */
export function IdeasPanel({ workspaceId, brandId, contentId, doc }: { workspaceId: string; brandId: string; contentId: string; doc: ContentDoc }) {
  const ideas = doc.blocks.filter((b) => b.kind === "list_item" && b.meta && "idea" in b.meta).map((b) => ({ index: Number(b.meta!.index), idea: b.meta!.idea as Idea, text: b.text }));
  const [sel, setSel] = useState<number[]>([]);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  if (!ideas.length) return null;
  async function draft() {
    setBusy(true); setMsg(undefined);
    try {
      const r = await api<{ data: Array<{ index: number; error?: { message: string } }> }>(`/workspaces/${workspaceId}/brands/${brandId}/content/${contentId}/ideas/drafts`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ indexes: sel }) });
      const failed = r.data.filter((x) => x.error);
      setMsg(failed.length ? { err: true, text: `${r.data.length - failed.length} draft(s) started; ${failed.length} couldn't start: ${failed[0]!.error!.message}` } : { text: `${r.data.length} draft(s) are being written; they'll appear under Content.` });
      setSel([]);
    } catch (e) { setMsg({ err: true, text: (e as Error).message }); } finally { setBusy(false); }
  }
  return (
    <Card className="flex flex-col gap-2">
      <h3 className="font-semibold">Turn ideas into drafts</h3>
      <ul className="flex flex-col gap-1">
        {ideas.map((x) => (
          <li key={x.index}>
            <label className={cn("flex items-start gap-2 rounded p-1 text-sm", sel.includes(x.index) && "bg-[var(--surface-2)]")}>
              <input type="checkbox" className="mt-1" checked={sel.includes(x.index)} disabled={!sel.includes(x.index) && sel.length >= 10} onChange={(e) => setSel(e.target.checked ? [...sel, x.index] : sel.filter((i) => i !== x.index))} />
              <span className="flex-1"><span className="font-medium">{x.idea.title}</span> <span className="text-[var(--text-muted)]">— {x.idea.why}</span></span>
              <Badge>{FORMAT[x.idea.format] ?? x.idea.format}</Badge><Badge>{x.idea.channel}</Badge>
            </label>
          </li>
        ))}
      </ul>
      <div><Button className="h-8 px-3 text-xs" disabled={busy || !sel.length} onClick={() => void draft()}>Write {sel.length || ""} draft{sel.length === 1 ? "" : "s"}</Button></div>
      <p className="text-xs text-[var(--text-muted)]">Each draft costs the same as creating it directly (up to 10 at a time).</p>
      {msg && <p className={cn("text-xs", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")}>{msg.text}</p>}
    </Card>
  );
}
