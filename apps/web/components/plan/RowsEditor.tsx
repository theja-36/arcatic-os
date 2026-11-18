"use client";
import { Button, Input } from "@arcatic/ui";

export type Column<T> = {
  key: keyof T & string;
  label: string;
  type?: "text" | "textarea" | "number" | "date" | "list" | "select" | "multiselect";
  options?: readonly string[];
  width?: string;
};

/** Generic editor for arrays of objects: every field of every row is editable. */
export function RowsEditor<T extends Record<string, unknown>>({ rows, columns, onChange, newRow, readOnly, addLabel = "Add" }: {
  rows: T[]; columns: Column<T>[]; onChange: (rows: T[]) => void; newRow?: () => T; readOnly?: boolean; addLabel?: string;
}) {
  const set = (i: number, key: string, value: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, i) => (
        <div key={i} className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-2">
          {columns.map((col) => {
            const v = row[col.key];
            const id = `${col.key}-${i}`;
            return (
              <label key={col.key} htmlFor={id} className={col.type === "textarea" || col.type === "list" ? "flex flex-col gap-1 text-xs sm:col-span-2" : "flex flex-col gap-1 text-xs"}>
                <span className="font-medium text-[var(--text-muted)]">{col.label}</span>
                {col.type === "textarea" ? (
                  <textarea id={id} disabled={readOnly} className="min-h-16 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={String(v ?? "")} onChange={(e) => set(i, col.key, e.target.value)} />
                ) : col.type === "list" ? (
                  <textarea id={id} disabled={readOnly} placeholder="One per line" className="min-h-16 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm"
                    value={((v as string[]) ?? []).join("\n")} onChange={(e) => set(i, col.key, e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} />
                ) : col.type === "select" ? (
                  <select id={id} disabled={readOnly} className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={String(v ?? "")} onChange={(e) => set(i, col.key, e.target.value)}>
                    {col.options?.map((o) => <option key={o}>{o}</option>)}
                  </select>
                ) : col.type === "multiselect" ? (
                  <div className="flex flex-wrap gap-2 text-sm">
                    {col.options?.map((o) => (
                      <label key={o} className="flex items-center gap-1">
                        <input type="checkbox" disabled={readOnly} checked={((v as string[]) ?? []).includes(o)}
                          onChange={(e) => set(i, col.key, e.target.checked ? [...((v as string[]) ?? []), o] : ((v as string[]) ?? []).filter((x) => x !== o))} />{o}
                      </label>
                    ))}
                  </div>
                ) : (
                  <Input id={id} disabled={readOnly} type={col.type === "number" ? "number" : col.type === "date" ? "date" : "text"} value={String(v ?? "")}
                    onChange={(e) => set(i, col.key, col.type === "number" ? Number(e.target.value) : e.target.value)} />
                )}
              </label>
            );
          })}
          {!readOnly && <div className="sm:col-span-2"><Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button></div>}
        </div>
      ))}
      {!readOnly && newRow && <div><Button variant="secondary" onClick={() => onChange([...rows, newRow()])}>{addLabel}</Button></div>}
    </div>
  );
}
