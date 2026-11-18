"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import { supabase } from "./supabase";

export type MediaAsset = {
  id: string; brand_id: string | null; collection_id: string | null; kind: string; status: string; mime_type: string | null; bytes: number | null;
  width: number | null; height: number | null; duration_ms: number | null; title: string | null; alt_text: string | null; tags: string[]; source: string;
  metadata: { hasAudio?: boolean; poster_path?: string } | null; created_at: string;
};
export type Collection = { id: string; name: string; parent_id: string | null; brand_id: string | null };

// Signed URLs live 5 minutes; cache for 4.
const cache = new Map<string, { url: string; at: number }>();
export async function signedUrl(workspaceId: string, assetId: string, poster = false): Promise<string> {
  const key = `${assetId}:${poster ? "p" : "f"}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 240_000) return hit.url;
  const r = await api<{ url: string }>(`/workspaces/${workspaceId}/media/${assetId}/url${poster ? "?poster=1" : ""}`);
  cache.set(key, { url: r.url, at: Date.now() });
  return r.url;
}

export function useSignedUrl(workspaceId: string, assetId: string | null | undefined, opts: { poster?: boolean; enabled?: boolean } = {}) {
  const [url, setUrl] = useState<string>();
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    setUrl(undefined);
    if (!assetId || !enabled) return;
    let live = true;
    signedUrl(workspaceId, assetId, opts.poster).then((u) => live && setUrl(u)).catch(() => undefined);
    return () => { live = false; };
  }, [workspaceId, assetId, opts.poster, enabled]);
  return url;
}

/** Swap the file behind an asset (same kind); references to the asset keep working. */
export async function replaceFile(workspaceId: string, assetId: string, file: File) {
  const t = await api<{ path: string; token: string }>(`/workspaces/${workspaceId}/media/${assetId}/replace`, {
    method: "POST", body: JSON.stringify({ filename: file.name, mimeType: file.type || "application/octet-stream", bytes: file.size }),
  });
  const up = await supabase().storage.from("media").uploadToSignedUrl(t.path, t.token, file, { contentType: file.type || undefined });
  if (up.error) throw new Error(`Upload failed: ${up.error.message}`);
  return api<MediaAsset>(`/workspaces/${workspaceId}/media/${assetId}/replace/finalize`, { method: "POST", body: JSON.stringify({ path: t.path }) });
}

export const formatDuration = (ms: number | null | undefined) => {
  if (ms == null) return "";
  const s = Math.round(ms / 100) / 10;
  return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : `${s.toFixed(1)}s`;
};
