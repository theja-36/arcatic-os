import type { ContentDoc } from "@arcatic/core";

/** Read-only rendering of a delivered document (no editor chrome, no "who wrote it" badges). */
export function DocPreview({ doc }: { doc: ContentDoc }) {
  return (
    <article className="flex flex-col gap-2 rounded border border-[var(--border)] p-3">
      {doc.blocks.map((b) => {
        if (b.kind === "title" || b.kind === "headline") return <h3 key={b.id} className="text-base font-semibold">{b.text}</h3>;
        if (b.kind === "heading" || b.kind === "subhead") return <h4 key={b.id} className="font-semibold">{b.text}</h4>;
        if (b.kind === "list_item") return <p key={b.id} className="pl-4">• {b.text}</p>;
        if (b.kind === "cta") return <p key={b.id} className="font-medium text-[var(--accent)]">{b.text}</p>;
        if (b.kind === "meta_description") return <p key={b.id} className="text-xs text-[var(--text-muted)]">Meta: {b.text}</p>;
        return <p key={b.id} className="whitespace-pre-wrap">{b.text}</p>;
      })}
    </article>
  );
}
