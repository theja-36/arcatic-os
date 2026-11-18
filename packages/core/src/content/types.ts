import type { CostedKind } from "../credits.js";
import type { Channel } from "../validation/platforms.js";

export type ContentCategory = "text" | "visual" | "image" | "video";

export interface ContentTypeDef {
  label: string;
  category: ContentCategory;
  template: string | null;           // generation template (null → not generatable)
  costKind: CostedKind;
  channels: readonly string[] | null; // allowed channels (null = no channel)
  defaultChannel?: string;
  /** validation channel for the whole text, if any */
  limitChannel?: (channel: string | null) => Channel | undefined;
}

const SOCIAL = ["instagram", "facebook", "linkedin", "x", "threads", "tiktok", "youtube", "pinterest", "gbp"] as const;
const socialLimit = (ch: string | null) => (ch && (SOCIAL as readonly string[]).includes(ch) ? (ch as Channel) : undefined);

/** Every content type Arcatic can create. Mirrors the `content_items.type` values in use. */
export const CONTENT_TYPE_DEFS = {
  social_post: { label: "Social post", category: "text", template: "social.post@1", costKind: "generate.social_post", channels: SOCIAL, defaultChannel: "instagram", limitChannel: socialLimit },
  carousel: { label: "Carousel", category: "text", template: "social.carousel@1", costKind: "generate.social_post", channels: ["instagram", "linkedin", "facebook"], defaultChannel: "instagram", limitChannel: socialLimit },
  story: { label: "Story", category: "text", template: "social.post@1", costKind: "generate.social_post", channels: ["instagram", "facebook"], defaultChannel: "instagram" },
  caption: { label: "Caption for an image", category: "text", template: "social.caption@1", costKind: "generate.caption", channels: SOCIAL, defaultChannel: "instagram", limitChannel: socialLimit },
  email: { label: "Email campaign", category: "text", template: "email.campaign@1", costKind: "generate.email", channels: ["email"], defaultChannel: "email" },
  blog: { label: "Blog article", category: "text", template: "blog.article@2", costKind: "generate.blog", channels: ["blog", "website"], defaultChannel: "blog" },
  x_thread: { label: "X thread", category: "text", template: "x.thread@1", costKind: "generate.x_thread", channels: ["x"], defaultChannel: "x" },
  yt_script: { label: "YouTube script", category: "text", template: "video.script@1", costKind: "generate.yt_script", channels: ["youtube"], defaultChannel: "youtube" },
  short_video: { label: "Short video script", category: "text", template: "video.script@1", costKind: "generate.yt_script", channels: ["instagram", "youtube", "tiktok", "facebook"], defaultChannel: "instagram" },
  ad: { label: "Facebook / Instagram ad copy", category: "text", template: "ads.meta.copy@1", costKind: "generate.ad_copy", channels: ["facebook", "instagram"], defaultChannel: "facebook" },
  static_visual: { label: "Static visual post", category: "visual", template: "visual.copy@1", costKind: "generate.static_visual", channels: SOCIAL, defaultChannel: "instagram" },
  profile_asset: { label: "Profile picture, cover, banner, thumbnail or sticker", category: "visual", template: "visual.copy@1", costKind: "generate.static_visual", channels: null },
  image: { label: "AI image", category: "image", template: "image.generate@1", costKind: "generate.image", channels: null },
  product_photo: { label: "Product photo", category: "image", template: "image.product@1", costKind: "generate.image", channels: null },
  video: { label: "Video", category: "video", template: null, costKind: "render.video_minute", channels: SOCIAL, defaultChannel: "instagram", limitChannel: socialLimit },
  // ---- growth suite (Phase 9)
  newsletter: { label: "Newsletter", category: "text", template: "email.newsletter@1", costKind: "generate.newsletter", channels: ["email"], defaultChannel: "email" },
  press_release: { label: "Press release", category: "text", template: "pr.release@1", costKind: "generate.press_release", channels: ["website", "blog"], defaultChannel: "website" },
  case_study: { label: "Case study", category: "text", template: "case.study@1", costKind: "generate.case_study", channels: ["website", "blog"], defaultChannel: "website" },
  brief: { label: "Creative brief", category: "text", template: "brief.creative@1", costKind: "generate.brief", channels: null },
  landing_page: { label: "Landing-page copy", category: "text", template: "web.landing@1", costKind: "generate.landing_page", channels: ["website"], defaultChannel: "website" },
  sales_sheet: { label: "Sales sheet", category: "text", template: "sales.sheet@1", costKind: "generate.sales_sheet", channels: null },
  product_copy: { label: "Product copy", category: "text", template: "product.copy@1", costKind: "generate.product_copy", channels: ["website", "marketplace"], defaultChannel: "website" },
  brainstorm: { label: "Idea list", category: "text", template: "ideas.brainstorm@1", costKind: "generate.brainstorm", channels: null },
  document: { label: "Document", category: "text", template: "doc.write@1", costKind: "generate.document", channels: null },
} as const satisfies Record<string, ContentTypeDef>;
export type ContentType = keyof typeof CONTENT_TYPE_DEFS;
export const CONTENT_TYPE_KEYS = Object.keys(CONTENT_TYPE_DEFS) as ContentType[];
export const isContentType = (t: string): t is ContentType => t in CONTENT_TYPE_DEFS;

export const LANGUAGES = { en: "English", te: "Telugu", hi: "Hindi", ta: "Tamil", kn: "Kannada", ml: "Malayalam", mr: "Marathi", bn: "Bengali" } as const;
export type LanguageCode = keyof typeof LANGUAGES;

export const TRANSFORMS = ["improve", "simplify", "shorten", "expand", "rewrite", "fix_grammar", "tone"] as const;
export type Transform = (typeof TRANSFORMS)[number];

export const TONE_OPTIONS = ["friendly", "professional", "playful", "bold", "warm", "urgent", "calm", "premium"] as const;
