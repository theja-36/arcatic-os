"use client";
import { useState } from "react";
import { Badge, Button, cn } from "@arcatic/ui";
import type { AnyFact, KitOp } from "@arcatic/core";
import type { FieldDef } from "./fields";

type Color = { hex: string; role: string };
type Font = { family: string; role: string };

export function renderValue(kind: FieldDef["kind"], v: unknown) {
  if (v === undefined || v === null) return <span className="text-[var(--text-muted)]">Not set</span>;
  if (kind === "colors") {
    return (
      <div className="flex flex-wrap gap-2">
        {(v as Color[]).map((c) => (
          <span key={c.hex + c.role} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1 text-xs">
            <span className="h-4 w-4 rounded" style={{ background: c.hex }} aria-hidden /> {c.hex} · {c.role}
          </span>
        ))}
      </div>
    );
  }
  if (kind === "fonts") return <span>{(v as Font[]).map((f) => `${f.family} (${f.role})`).join(", ")}</span>;
  if (kind === "contact") return <span>{Object.entries(v as Record<string, string>).map(([k, x]) => `${k}: ${x}`).join(" · ")}</span>;
  if (Array.isArray(v)) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {(v as string[]).map((x) => <span key={x} className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-sm">{x}</span>)}
      </div>
    );
  }
  return <span className="whitespace-pre-wrap">{String(v)}</span>;
}

function toDraft(kind: FieldDef["kind"], v: unknown): string {
  if (v === undefined) return "";
  if (kind === "list") return (v as string[]).join("\n");
  if (kind === "colors") return (v as Color[]).map((c) => `${c.hex} ${c.role}`).join("\n");
  if (kind === "fonts") return (v as Font[]).map((f) => `${f.family} | ${f.role}`).join("\n");
  if (kind === "contact") return Object.entries(v as Record<string, string>).map(([k, x]) => `${k}: ${x}`).join("\n");
  return String(v);
}

function fromDraft(kind: FieldDef["kind"], s: string): unknown {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  if (kind === "list") return lines;
  if (kind === "colors") return lines.map((l) => { const [hex, role = "other"] = l.split(/\s+/); return { hex: (hex ?? "").toLowerCase(), role }; });
  if (kind === "fonts") return lines.map((l) => { const [family, role = "other"] = l.split("|").map((x) => x.trim()); return { family, role }; });
  if (kind === "contact") return Object.fromEntries(lines.map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }).filter(([k, x]) => k && x));
  return s.trim();
}

const placeholders: Partial<Record<FieldDef["kind"], string>> = {
  list: "One item per line",
  colors: "#e85d04 primary\n#2a9d8f secondary",
  fonts: "Poppins | heading\nNoto Sans Telugu | body",
  contact: "email: hello@example.in\nphone: +91 …\naddress: …",
};

export function Sources({ fact }: { fact: Pick<AnyFact, "sources" | "unverified"> }) {
  if (!fact.sources.length) return fact.unverified ? <p className="text-xs text-[var(--warning)]">No verified source — check before approving.</p> : null;
  return (
    <ul className="mt-2 space-y-1">
      {fact.sources.slice(0, 3).map((s, i) => (
        <li key={i} className="text-xs text-[var(--text-muted)]">
          {s.quote && <span className="italic">“{s.quote}” </span>}
          {s.url && <a className="text-[var(--accent)] underline-offset-2 hover:underline" href={s.url} target="_blank" rel="noreferrer noopener">{s.kind === "page" ? new URL(s.url).pathname || "/" : s.kind}</a>}
          {!s.url && <span>{s.kind}</span>}
        </li>
      ))}
    </ul>
  );
}

export function FactCard({ def, fact, canEdit, onOps }: { def: FieldDef; fact?: AnyFact; canEdit: boolean; onOps: (ops: KitOp[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const status = fact?.status;

  return (
    <div className={cn("rounded-[var(--radius)] border bg-[var(--surface)] p-4", status === "suggested" ? "border-[var(--accent)] border-dashed" : "border-[var(--border)]")}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{def.label}</h3>
        {status === "approved" && <Badge tone="success">approved</Badge>}
        {status === "suggested" && <Badge tone="accent">AI suggestion</Badge>}
        {status === "rejected" && <Badge tone="danger">rejected</Badge>}
        {fact?.confidence !== undefined && fact.origin === "ai" && <Badge>{Math.round(fact.confidence * 100)}% confident</Badge>}
        {fact?.origin === "onboarding" && <Badge>from onboarding</Badge>}
      </div>
      {def.help && !editing && !fact && <p className="mb-2 text-xs text-[var(--text-muted)]">{def.help}</p>}

      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            className="min-h-24 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm"
            value={draft}
            placeholder={placeholders[def.kind]}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={def.label}
          />
          <div className="flex gap-2">
            <Button onClick={() => { onOps([{ op: "set", path: def.path, value: fromDraft(def.kind, draft) }]); setEditing(false); }}>Done</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className={cn("text-sm", status === "rejected" && "line-through opacity-60")}>{renderValue(def.kind, fact?.value)}</div>
      )}
      {fact && !editing && <Sources fact={fact} />}

      {fact?.suggestion && (
        <div className="mt-3 rounded-md bg-[var(--surface-2)] p-3">
          <p className="mb-1 text-xs font-medium text-[var(--accent)]">Website analysis suggests ({Math.round(fact.suggestion.confidence * 100)}%):</p>
          <div className="text-sm">{renderValue(def.kind, fact.suggestion.value)}</div>
          <Sources fact={{ sources: fact.suggestion.sources }} />
          {canEdit && (
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" onClick={() => onOps([{ op: "accept_suggestion", id: fact.id }])}>Use this</Button>
              <Button variant="ghost" onClick={() => onOps([{ op: "dismiss_suggestion", id: fact.id }])}>Keep mine</Button>
            </div>
          )}
        </div>
      )}

      {canEdit && !editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {status === "suggested" && <Button variant="secondary" onClick={() => onOps([{ op: "approve", id: fact!.id }])}>Approve</Button>}
          {status === "suggested" && <Button variant="ghost" onClick={() => onOps([{ op: "reject", id: fact!.id }])}>Reject</Button>}
          <Button variant="ghost" onClick={() => { setDraft(toDraft(def.kind, fact?.value)); setEditing(true); }}>{fact ? "Edit" : "Add"}</Button>
          {fact && <Button variant="ghost" onClick={() => onOps([{ op: "clear", path: def.path }])}>Clear</Button>}
        </div>
      )}
    </div>
  );
}
