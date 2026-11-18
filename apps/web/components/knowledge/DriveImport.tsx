"use client";
import { useState } from "react";
import { Button } from "@arcatic/ui";
import { api } from "@/lib/api";
import { driveConfigured, pickDriveFiles } from "@/lib/google-drive";

export function DriveImport({ workspaceId, brandId, onDone }: { workspaceId: string; brandId: string; onDone: () => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (!driveConfigured) {
    return <p className="text-sm text-[var(--text-muted)]">Google Drive import isn't configured for this installation (needs a Google Cloud OAuth client and Picker API key).</p>;
  }

  async function pick() {
    setBusy(true);
    setMsg("");
    try {
      const { token, files } = await pickDriveFiles();
      if (!files.length) return;
      const r = await api<{ data: Array<{ error?: { message: string } }> }>(`/workspaces/${workspaceId}/brands/${brandId}/sources/drive`, {
        method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ accessToken: token, files }),
      });
      const failed = r.data.filter((x) => x.error);
      setMsg(failed.length ? `${files.length - failed.length} file(s) importing; ${failed.length} couldn't start: ${failed[0]!.error!.message}` : `${files.length} file(s) importing.`);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-[var(--text-muted)]">Pick Docs, Sheets, Slides, PDFs or Office files. Arcatic only gets access to the files you pick.</p>
      <div><Button onClick={pick} disabled={busy}>{busy ? "Working…" : "Choose from Google Drive"}</Button></div>
      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
