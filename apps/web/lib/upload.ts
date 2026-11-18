"use client";
import { api } from "./api";
import { supabase } from "./supabase";

export type Asset = { id: string; kind: string; status: string; title: string | null; mime_type: string | null; bytes: number | null; width: number | null; height: number | null; tags: string[]; created_at: string; source: string };

/** Signed upload straight to Storage, then server-side verification of the real file type. */
export async function uploadFile(workspaceId: string, file: File, brandId?: string, collectionId?: string): Promise<Asset> {
  const target = await api<{ assetId: string; path: string; token: string }>(`/workspaces/${workspaceId}/media/upload-url`, {
    method: "POST",
    body: JSON.stringify({ filename: file.name, mimeType: file.type || "application/octet-stream", bytes: file.size, brandId, collectionId }),
  });
  const up = await supabase().storage.from("media").uploadToSignedUrl(target.path, target.token, file, { contentType: file.type || undefined });
  if (up.error) throw new Error(`Upload failed: ${up.error.message}`);
  return api<Asset>(`/workspaces/${workspaceId}/media/finalize`, { method: "POST", body: JSON.stringify({ assetId: target.assetId }) });
}

export const formatBytes = (n: number | null) => (n == null ? "" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
