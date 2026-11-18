import { z } from "zod";

/**
 * Publish channels and their rules. Every limit and setting below was read from the Postiz
 * source in the project folder (postiz-app-main/libraries/nestjs-libraries/src/…):
 *   integrations/social/<provider>.provider.ts — identifier, maxLength(), checkValidity(), maxConcurrentJob
 *   dtos/posts/providers-settings/<provider>.dto.ts — the settings object Postiz validates
 *   libraries/helpers/src/utils/valid.url.path.ts — accepted media extensions
 * WordPress (direct REST) and email (Mautic REST) are Arcatic's own adapters.
 * Platform-side quotas (posts/day, upload size caps) are NOT in the Postiz source; they are
 * enforced by each platform at publish time and surface as failures (docs/15 §5).
 */
export const PUBLISH_CHANNELS = ["instagram", "facebook", "linkedin", "x", "tiktok", "youtube", "threads", "gbp", "wordpress", "email"] as const;
export type PublishChannel = (typeof PUBLISH_CHANNELS)[number];
export type Transport = "postiz" | "wordpress" | "mautic";

/** Postiz media rule: path (before ?) must end in one of these (lower-case). */
export const POSTIZ_MEDIA_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "mp4"] as const;

const bool = z.boolean();
const InstagramSettings = z.object({
  post_type: z.enum(["post", "story"]).default("post"),
  is_trial_reel: bool.optional(),
});
const FacebookSettings = z.object({
  post_type: z.enum(["post", "story"]).optional(),
  url: z.url().optional(),
});
const LinkedinSettings = z.object({
  post_as_images_carousel: bool.optional(),
  carousel_name: z.string().max(200).optional(),
});
const XSettings = z.object({
  who_can_reply_post: z.enum(["everyone", "following", "mentionedUsers", "subscribers", "verified"]).default("everyone"),
  community: z.string().regex(/^(https:\/\/x\.com\/i\/communities\/\d+)?$/, "Use an X community URL like https://x.com/i/communities/123").optional(),
  made_with_ai: bool.optional(),
  paid_partnership: bool.optional(),
});
const TikTokSettings = z.object({
  title: z.string().max(90).optional(),
  privacy_level: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]).default("PUBLIC_TO_EVERYONE"),
  duet: bool.default(false),
  stitch: bool.default(false),
  comment: bool.default(true),
  autoAddMusic: z.enum(["yes", "no"]).default("no"),
  brand_content_toggle: bool.default(false),
  brand_organic_toggle: bool.default(false),
  video_made_with_ai: bool.default(false),
  content_posting_method: z.enum(["DIRECT_POST", "UPLOAD"]).default("DIRECT_POST"),
});
const YoutubeSettings = z.object({
  title: z.string({ error: "YouTube needs a title" }).trim().min(1, "YouTube needs a title").max(100, "YouTube titles are at most 100 characters"),
  type: z.enum(["public", "private", "unlisted"]).default("public"),
  selfDeclaredMadeForKids: z.enum(["yes", "no"]).default("no"),
  tags: z.array(z.object({ value: z.string(), label: z.string() })).max(60).optional(),
  made_with_ai: bool.optional(),
});
const ThreadsSettings = z.object({ made_with_ai: bool.optional() });
const GbpSettings = z.object({
  topicType: z.enum(["STANDARD", "EVENT", "OFFER"]).default("STANDARD"),
  callToActionType: z.enum(["NONE", "BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "GET_OFFER", "CALL"]).default("NONE"),
  callToActionUrl: z.url().optional(),
  eventTitle: z.string().max(300).optional(),
  eventStartDate: z.string().optional(),
  eventEndDate: z.string().optional(),
  eventStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  eventEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});
const WordpressSettings = z.object({
  title: z.string({ error: "WordPress posts need a title" }).trim().min(2, "WordPress posts need a title (2+ characters)").max(300),
  status: z.enum(["publish", "draft", "pending", "private"]).default("publish"),
  categories: z.array(z.number().int().positive()).max(50).optional(),
  tags: z.array(z.number().int().positive()).max(50).optional(),
});
const EmailSettings = z.object({
  subject: z.string({ error: "The email needs a subject" }).trim().min(1, "The email needs a subject").max(200),
  preheader: z.string().max(200).optional(),
  fromName: z.string().max(100).optional(),
  fromAddress: z.email().optional(),
});

export const CHANNEL_SETTINGS = {
  instagram: InstagramSettings, facebook: FacebookSettings, linkedin: LinkedinSettings, x: XSettings, tiktok: TikTokSettings,
  youtube: YoutubeSettings, threads: ThreadsSettings, gbp: GbpSettings, wordpress: WordpressSettings, email: EmailSettings,
} satisfies Record<PublishChannel, z.ZodType>;
export type ChannelSettings<C extends PublishChannel> = z.infer<(typeof CHANNEL_SETTINGS)[C]>;

export interface AccountType {
  /** Postiz provider identifier (also the settings `__type`) */
  identifier: string;
  label: string;
  note?: string;
}

export interface ChannelRule {
  label: string;
  transport: Transport;
  accountTypes: AccountType[];
  maxChars: number | null;
  counting: "graphemes" | "x_weighted";
  /** Postiz maxConcurrentJob for the provider (its own publish concurrency) */
  concurrency?: number;
  source: string;
}

const SRC = "postiz-app-main/libraries/nestjs-libraries/src/integrations/social";
export const CHANNEL_RULES: Record<PublishChannel, ChannelRule> = {
  instagram: {
    label: "Instagram", transport: "postiz", maxChars: 2200, counting: "graphemes", concurrency: 400, source: `${SRC}/instagram.provider.ts`,
    accountTypes: [
      { identifier: "instagram", label: "Instagram (via Facebook Page)", note: "Business or Creator account linked to a Facebook Page" },
      { identifier: "instagram-standalone", label: "Instagram (Instagram login)", note: "Professional account without a Facebook Page" },
    ],
  },
  facebook: { label: "Facebook Page", transport: "postiz", maxChars: 63206, counting: "graphemes", concurrency: 500, source: `${SRC}/facebook.provider.ts`, accountTypes: [{ identifier: "facebook", label: "Facebook Page" }] },
  linkedin: {
    label: "LinkedIn", transport: "postiz", maxChars: 3000, counting: "graphemes", concurrency: 8, source: `${SRC}/linkedin.provider.ts`,
    accountTypes: [{ identifier: "linkedin", label: "LinkedIn profile" }, { identifier: "linkedin-page", label: "LinkedIn company page" }],
  },
  x: { label: "X", transport: "postiz", maxChars: 280, counting: "x_weighted", concurrency: 10, source: `${SRC}/x.provider.ts`, accountTypes: [{ identifier: "x", label: "X account", note: "Premium 4,000-character posts aren't used; Arcatic keeps posts within 280" }] },
  tiktok: {
    label: "TikTok", transport: "postiz", maxChars: 2000, counting: "graphemes", source: `${SRC}/tiktok.provider.ts`,
    accountTypes: [{ identifier: "tiktok", label: "TikTok" }, { identifier: "tiktok-business", label: "TikTok Business" }],
  },
  youtube: { label: "YouTube", transport: "postiz", maxChars: 5000, counting: "graphemes", concurrency: 200, source: `${SRC}/youtube.provider.ts`, accountTypes: [{ identifier: "youtube", label: "YouTube channel" }] },
  threads: { label: "Threads", transport: "postiz", maxChars: 500, counting: "graphemes", concurrency: 20, source: `${SRC}/threads.provider.ts`, accountTypes: [{ identifier: "threads", label: "Threads" }] },
  gbp: { label: "Google Business Profile", transport: "postiz", maxChars: 1500, counting: "graphemes", concurrency: 3, source: `${SRC}/gmb.provider.ts`, accountTypes: [{ identifier: "gmb", label: "Business Profile location" }] },
  wordpress: { label: "WordPress", transport: "wordpress", maxChars: null, counting: "graphemes", source: "Arcatic WordPress REST adapter (endpoints as used by Postiz wordpress.provider.ts)", accountTypes: [] },
  email: { label: "Email (Mautic segment)", transport: "mautic", maxChars: null, counting: "graphemes", source: "Arcatic Mautic adapter (mautic-7.x EmailBundle API)", accountTypes: [] },
};

export const isPublishChannel = (c: string): c is PublishChannel => (PUBLISH_CHANNELS as readonly string[]).includes(c);

/** Postiz provider identifier → Arcatic channel. */
export function channelForIdentifier(identifier: string): PublishChannel | null {
  for (const c of PUBLISH_CHANNELS) if (CHANNEL_RULES[c].accountTypes.some((a) => a.identifier === identifier)) return c;
  return null;
}

/** Which channels a content type can go to. */
export function channelsForContentType(type: string): PublishChannel[] {
  switch (type) {
    case "blog": case "press_release": case "case_study": return ["wordpress"];
    case "email": case "newsletter": return ["email"];
    case "brief": case "landing_page": case "sales_sheet": case "product_copy": case "brainstorm": case "document": return [];
    case "x_thread": return ["x", "threads"];
    case "yt_script": return [];
    case "short_video": return [];            // a script; publish the rendered video instead
    case "video": return ["instagram", "facebook", "tiktok", "youtube", "linkedin", "x", "threads"];
    case "story": return ["instagram", "facebook"];
    case "image": case "product_photo": case "profile_asset": return [];
    default: return ["instagram", "facebook", "linkedin", "x", "tiktok", "threads", "gbp"];
  }
}
