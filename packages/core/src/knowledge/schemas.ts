import { z } from "zod";

const tags = z.array(z.string().trim().min(1).max(40)).max(12).default([]);
const visibility = z.enum(["brand", "private"]).default("brand");
const common = { title: z.string().trim().min(1).max(200).optional(), tags, visibility };

/** POST /brands/:id/sources */
export const CreateSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), url: z.url(), refreshDays: z.number().int().min(1).max(365).optional(), ...common }),
  z.object({
    type: z.literal("crawl"), url: z.url(), limit: z.number().int().min(1).max(200).default(25),
    includePaths: z.array(z.string().max(200)).max(20).optional(), excludePaths: z.array(z.string().max(200)).max(20).optional(),
    refreshDays: z.number().int().min(1).max(365).optional(), ...common,
  }),
  z.object({ type: z.literal("text"), body: z.string().trim().min(1).max(200_000), ...common, title: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal("file"), mediaAssetId: z.uuid(), ...common }),
  z.object({ type: z.literal("media"), mediaAssetId: z.uuid(), language: z.enum(["auto", "te", "en", "hi", "ta", "kn"]).default("auto"), maxMinutes: z.number().int().min(1).max(240).default(60), ...common }),
  // Own social posts pasted in by the user. Automated import arrives with connected accounts (Phase 7).
  z.object({ type: z.literal("social_reference"), platform: z.enum(["instagram", "facebook", "linkedin", "x", "youtube", "tiktok", "threads", "other"]), url: z.url().optional(), body: z.string().trim().min(1).max(20_000), ...common }),
]);
export type CreateSourceInput = z.infer<typeof CreateSourceSchema>;

export const UpdateSourceSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  visibility: z.enum(["brand", "private"]).optional(),
  refreshDays: z.number().int().min(1).max(365).nullable().optional(),
});

export const SearchSchema = z.object({
  query: z.string().trim().min(2).max(500),
  limit: z.number().int().min(1).max(30).default(8),
  sourceTypes: z.array(z.enum(["url", "crawl", "file", "text", "media", "drive", "social_reference"])).optional(),
  tags: z.array(z.string()).max(12).optional(),
});

export const DriveImportSchema = z.object({
  /** short-lived token from Google Identity Services (drive.file scope); stored encrypted for ≤1h, never logged */
  accessToken: z.string().min(20).max(4096),
  files: z.array(z.object({ id: z.string().regex(/^[\w-]{10,200}$/), name: z.string().max(300) })).min(1).max(20),
  tags,
  visibility,
});

export const ImportImageUrlSchema = z.object({ url: z.url(), brandId: z.uuid().optional(), title: z.string().max(200).optional(), tags });
export const FinalizeUploadSchema = z.object({ assetId: z.uuid() });
export const UpdateMediaSchema = z.object({ title: z.string().max(200).optional(), altText: z.string().max(500).optional(), tags: z.array(z.string().max(40)).max(20).optional() });

/** Freshness: a source is stale once its refresh interval has passed. */
export function isStale(lastIngestedAt: string | null, refreshIntervalDays: number | null, now = new Date()): boolean {
  if (!lastIngestedAt || !refreshIntervalDays) return false;
  return now.getTime() - new Date(lastIngestedAt).getTime() > refreshIntervalDays * 86_400_000;
}

export const charsToPages = (chars: number) => Math.max(1, Math.ceil(chars / 3000));
