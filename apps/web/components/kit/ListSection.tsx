"use client";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, Input } from "@arcatic/ui";
import type { AnyFact, KitOp } from "@arcatic/core";
import { Sources } from "./FactCard";

type Audience = { name: string; description?: string; pains: string[]; desires: string[]; objections: string[] };
type Offer = { name: string; kind: string; description?: string; price?: string; benefit?: string };
const OFFER_KINDS = ["product", "service", "bundle", "subscription", "event", "other"];
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function Editor({ list, initial, onSave, onCancel }: { list: "audiences" | "offers"; initial?: Record<string, unknown>; onSave: (v: unknown) => void; onCancel: () => void }) {
  const [v, setV] = useState<Record<string, string>>(() => {
    if (!initial) return {};
    return Object.fromEntries(Object.entries(initial).map(([k, x]) => [k, Array.isArray(x) ? x.join("\n") : String(x ?? "")]));
  });
  const field = (k: string, label: string, multi = false) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {multi ? (
        <textarea className="min-h-16 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2" value={v[k] ?? ""} placeholder="One per line" onChange={(e) => setV({ ...v, [k]: e.target.value })} />
      ) : (
        <Input value={v[k] ?? ""} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
      )}
    </label>
  );
  const save = () => {
    if (!v.name?.trim()) return;
    if (list === "audiences") onSave({ name: v.name.trim(), description: v.description?.trim() || undefined, pains: lines(v.pains ?? ""), desires: lines(v.desires ?? ""), objections: lines(v.objections ?? "") });
    else onSave({ name: v.name.trim(), kind: v.kind || "service", description: v.description?.trim() || undefined, price: v.price?.trim() || undefined, benefit: v.benefit?.trim() || undefined });
  };
  return (
    <Card className="grid gap-3 sm:grid-cols-2">
      {field("name", "Name")}
      {list === "offers" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Type</span>
          <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={v.kind ?? "service"} onChange={(e) => setV({ ...v, kind: e.target.value })}>
            {OFFER_KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
        </label>
      ) : <div />}
      <div className="sm:col-span-2">{field("description", "Description", true)}</div>
      {list === "audiences" ? (<>{field("pains", "Pains", true)}{field("desires", "Desires", true)}<div className="sm:col-span-2">{field("objections", "Objections", true)}</div></>)
        : (<>{field("price", "Price (as you'd write it)")}{field("benefit", "Main benefit")}</>)}
      <div className="flex gap-2 sm:col-span-2"><Button onClick={save}>Done</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </Card>
  );
}

export function ListSection({ list, facts, canEdit, onOps }: { list: "audiences" | "offers"; facts: AnyFact[]; canEdit: boolean; onOps: (ops: KitOp[]) => void }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const noun = list === "audiences" ? "audience" : "offer";
  return (
    <div className="flex flex-col gap-3">
      {facts.length === 0 && editing !== "new" && <EmptyState title={`No ${list} yet`} body={list === "audiences" ? "Describe who you sell to: their problems, what they want, and what stops them buying." : "List what you sell, with prices exactly as customers see them."} />}
      {facts.map((f) =>
        editing === f.id ? (
          <Editor key={f.id} list={list} initial={f.value as Record<string, unknown>} onCancel={() => setEditing(null)} onSave={(value) => { onOps([{ op: "update", id: f.id, value }]); setEditing(null); }} />
        ) : (
          <Card key={f.id} className={f.status === "suggested" ? "border-dashed border-[var(--accent)]" : undefined}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{(f.value as Audience | Offer).name}</p>
              {list === "offers" && <Badge>{(f.value as Offer).kind}</Badge>}
              {(f.value as Offer).price && <Badge tone="accent">{(f.value as Offer).price}</Badge>}
              {f.status === "suggested" && <Badge tone="accent">AI suggestion</Badge>}
              {f.status === "rejected" && <Badge tone="danger">rejected</Badge>}
            </div>
            {(f.value as Audience).description && <p className="mt-1 text-sm text-[var(--text-muted)]">{(f.value as Audience).description}</p>}
            {list === "audiences" && (["pains", "desires", "objections"] as const).map((k) =>
              (f.value as Audience)[k]?.length ? <p key={k} className="mt-1 text-sm"><span className="font-medium capitalize">{k}:</span> {(f.value as Audience)[k].join("; ")}</p> : null)}
            {list === "offers" && (f.value as Offer).benefit && <p className="mt-1 text-sm">{(f.value as Offer).benefit}</p>}
            <Sources fact={f} />
            {f.suggestion && <p className="mt-2 text-xs text-[var(--accent)]">The website shows different details — <button className="underline" onClick={() => onOps([{ op: "accept_suggestion", id: f.id }])}>use them</button> or <button className="underline" onClick={() => onOps([{ op: "dismiss_suggestion", id: f.id }])}>keep yours</button>.</p>}
            {canEdit && (
              <div className="mt-3 flex flex-wrap gap-2">
                {f.status === "suggested" && <><Button variant="secondary" onClick={() => onOps([{ op: "approve", id: f.id }])}>Approve</Button><Button variant="ghost" onClick={() => onOps([{ op: "reject", id: f.id }])}>Reject</Button></>}
                <Button variant="ghost" onClick={() => setEditing(f.id)}>Edit</Button>
                <Button variant="ghost" onClick={() => onOps([{ op: "remove", id: f.id }])}>Remove</Button>
              </div>
            )}
          </Card>
        ),
      )}
      {editing === "new" && <Editor list={list} onCancel={() => setEditing(null)} onSave={(value) => { onOps([{ op: "add", list, value }]); setEditing(null); }} />}
      {canEdit && editing !== "new" && <div><Button variant="secondary" onClick={() => setEditing("new")}>Add {noun}</Button></div>}
    </div>
  );
}
