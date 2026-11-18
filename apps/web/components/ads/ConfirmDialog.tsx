"use client";
import { useState } from "react";
import { Button, Card, Input } from "@arcatic/ui";

/**
 * Typed confirmation for money-moving actions: the person must type `phrase` exactly.
 * The database checks the same phrase again, so this is not only a UI guard.
 */
export function ConfirmDialog({ title, summary, phrase, actionLabel, danger, onConfirm, onClose }: {
  title: string; summary: string; phrase: string | null; actionLabel: string; danger?: boolean;
  onConfirm: (typed: string | undefined) => Promise<void>; onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const ok = !phrase || typed.trim() === phrase;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <Card className="flex w-full max-w-md flex-col gap-3">
        <h2 id="confirm-title" className="font-semibold">{title}</h2>
        <p className="text-sm">{summary}</p>
        {phrase && (
          <label className="flex flex-col gap-1 text-sm">
            <span>Type <code className="rounded bg-[var(--surface-2)] px-1">{phrase}</code> to confirm</span>
            <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation" autoComplete="off" />
          </label>
        )}
        {err && <p className="text-sm text-[var(--danger)]" role="alert">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={!ok || busy} onClick={async () => {
            setBusy(true); setErr(undefined);
            try { await onConfirm(phrase ? typed.trim() : undefined); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>{actionLabel}</Button>
        </div>
      </Card>
    </div>
  );
}
