"use client";
import { cn } from "@arcatic/ui";
import { formatDuration, useSignedUrl, type MediaAsset } from "@/lib/media";

/** Image → the image; video → its poster frame; audio/other → a labelled tile. */
export function MediaThumb({ workspaceId, asset, className }: { workspaceId: string; asset: MediaAsset; className?: string }) {
  const ready = asset.status === "ready";
  const isImage = asset.kind === "image";
  const hasPoster = asset.kind === "video" && !!asset.metadata?.poster_path;
  const src = useSignedUrl(workspaceId, asset.id, { poster: hasPoster, enabled: ready && (isImage || hasPoster) });
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-[var(--surface-2)]", className ?? "h-36 w-full")}>
      {src ? <img src={src} alt={asset.alt_text ?? asset.title ?? ""} className="h-full w-full object-cover" loading="lazy" />
        : <div className="flex h-full w-full items-center justify-center text-sm capitalize text-[var(--text-muted)]">{ready ? asset.kind : asset.status}</div>}
      {asset.duration_ms ? <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[11px] text-white">{formatDuration(asset.duration_ms)}</span> : null}
    </div>
  );
}
