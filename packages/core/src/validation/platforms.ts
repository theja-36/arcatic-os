/**
 * Platform text limits used by deterministic validation. Phase 7: aligned with the limits
 * Postiz enforces before publishing (postiz-app-main …/integrations/social/*.provider.ts
 * `maxLength()`), since Postiz rejects anything longer. Keep this table the single source.
 */
export type Channel =
  | "instagram" | "facebook" | "linkedin" | "x" | "threads" | "tiktok" | "youtube"
  | "pinterest" | "gbp" | "email_subject" | "meta_description";

export interface ChannelLimits {
  maxChars: number;
  maxHashtags?: number;
  counting: "graphemes" | "x_weighted";
  linksClickable: boolean;
}

export const CHANNEL_LIMITS: Record<Channel, ChannelLimits> = {
  instagram: { maxChars: 2200, maxHashtags: 30, counting: "graphemes", linksClickable: false },
  facebook: { maxChars: 63206, counting: "graphemes", linksClickable: true },
  linkedin: { maxChars: 3000, counting: "graphemes", linksClickable: true },
  x: { maxChars: 280, counting: "x_weighted", linksClickable: true },
  threads: { maxChars: 500, counting: "graphemes", linksClickable: true },
  tiktok: { maxChars: 2000, counting: "graphemes", linksClickable: false },   // Postiz tiktok.provider.ts
  youtube: { maxChars: 5000, counting: "graphemes", linksClickable: true },
  pinterest: { maxChars: 500, counting: "graphemes", linksClickable: true },
  gbp: { maxChars: 1500, counting: "graphemes", linksClickable: false },
  email_subject: { maxChars: 60, counting: "graphemes", linksClickable: false },
  meta_description: { maxChars: 160, counting: "graphemes", linksClickable: false },
};
