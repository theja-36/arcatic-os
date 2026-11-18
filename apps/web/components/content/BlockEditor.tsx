"use client";
import { nextBlockId, type Block, type ContentDoc, type DocIssue } from "@arcatic/core";
import { Badge, Button, cn } from "@arcatic/ui";
import { KIND_LABEL } from "./types";

/**
 * Block editor: each block is edited in place; locking a block protects it from regeneration.
 * Blocks you change become "yours" when saved.
 */
export function BlockEditor({ doc, onChange, issues, selected, onSelect, readOnly }: {
  doc: ContentDoc; onChange: (d: ContentDoc) => void; issues: DocIssue[]; selected: Set<string>; onSelect: (s: Set<string>) => void; readOnly: boolean;
}) {
  const set = (id: string, patch: Partial<Block>) => onChange({ ...doc, blocks: doc.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  const canAddParagraph = doc.blocks.some((b) => b.kind === "paragraph" || b.kind === "body" || b.kind === "tweet");
  const addKind = doc.blocks.find((b) => b.kind === "tweet") ? "tweet" : doc.blocks.find((b) => b.kind === "paragraph") ? "paragraph" : "body";
  return (
    <div className="flex flex-col gap-3">
      {doc.blocks.map((b) => {
        const blockIssues = issues.filter((i) => i.blockId === b.id);
        const options = (b.meta?.options as string[] | undefined)?.filter((o) => o !== b.text);
        return (
          <div key={b.id} className={cn("rounded-[var(--radius)] border bg-[var(--surface)] p-3", blockIssues.some((i) => i.severity === "error") ? "border-[var(--danger)]" : "border-[var(--border)]")}>
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              {!readOnly && <input type="checkbox" aria-label={`Select ${KIND_LABEL[b.kind] ?? b.kind}`} checked={selected.has(b.id)} onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(b.id); else n.delete(b.id); onSelect(n); }} />}
              <span className="font-medium">{KIND_LABEL[b.kind] ?? b.kind}{b.meta?.slide ? ` ${b.meta.slide}` : b.meta?.index ? ` ${b.meta.index}` : b.meta?.scene ? ` ${b.meta.scene}` : ""}</span>
              <Badge tone={b.origin === "human" ? "accent" : "neutral"}>{b.origin === "human" ? "yours" : "AI"}</Badge>
              {b.locked && <Badge tone="warning">locked</Badge>}
              <span className="ml-auto text-[var(--text-muted)]">{[...new Intl.Segmenter().segment(b.text)].length} chars</span>
            </div>
            <textarea
              disabled={readOnly}
              className="min-h-12 w-full resize-y rounded-md border border-transparent bg-transparent p-1 text-sm focus:border-[var(--border)]"
              rows={Math.min(12, Math.max(1, Math.ceil(b.text.length / 80)))}
              value={b.text}
              onChange={(e) => set(b.id, { text: e.target.value })}
              aria-label={KIND_LABEL[b.kind] ?? b.kind}
            />
            {options?.length ? (
              <div className="mt-1 flex flex-wrap gap-1 text-xs">
                <span className="text-[var(--text-muted)]">Alternatives:</span>
                {options.map((o) => <button key={o} disabled={readOnly} className="rounded bg-[var(--surface-2)] px-2 py-0.5" onClick={() => set(b.id, { text: o })}>{o}</button>)}
              </div>
            ) : null}
            {blockIssues.map((i) => <p key={i.message} className={cn("mt-1 text-xs", i.severity === "error" ? "text-[var(--danger)]" : "text-[var(--warning)]")}>{i.message}</p>)}
            {!readOnly && (
              <div className="mt-1 flex gap-2 text-xs">
                <button className="text-[var(--text-muted)] hover:underline" onClick={() => set(b.id, { locked: !b.locked })}>{b.locked ? "Unlock" : "Lock (keep when regenerating)"}</button>
                <button className="text-[var(--text-muted)] hover:underline" onClick={() => onChange({ ...doc, blocks: doc.blocks.filter((x) => x.id !== b.id) })}>Remove</button>
              </div>
            )}
          </div>
        );
      })}
      {!readOnly && canAddParagraph && (
        <div><Button variant="ghost" onClick={() => onChange({ ...doc, blocks: [...doc.blocks, { id: nextBlockId(doc), kind: addKind, text: "", origin: "human" }] })}>Add {KIND_LABEL[addKind]?.toLowerCase()}</Button></div>
      )}
    </div>
  );
}
