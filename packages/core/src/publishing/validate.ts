import { graphemeLength, xWeightedLength } from "../validation/text.js";
import { CHANNEL_RULES, CHANNEL_SETTINGS, POSTIZ_MEDIA_EXTENSIONS, type PublishChannel } from "./channels.js";

export interface MediaFacts {
  assetId: string;
  kind: "image" | "video";
  /** file extension of the stored file, lower-case, no dot */
  ext: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

export interface TargetInput {
  channel: PublishChannel;
  text: string;
  thread?: string[];
  media: MediaFacts[];
  settings: Record<string, unknown>;
  /** body HTML for WordPress / email */
  html?: string;
}

export interface TargetIssue {
  severity: "error" | "warning";
  field?: string;
  message: string;
}

export interface TargetReport {
  passed: boolean;
  issues: TargetIssue[];
  /** settings after defaults were applied (send these) */
  settings: Record<string, unknown>;
  length: number;
  limit: number | null;
}

const len = (t: string, counting: "graphemes" | "x_weighted") => (counting === "x_weighted" ? xWeightedLength(t) : graphemeLength(t));
const vertical = (m: MediaFacts) => !!m.width && !!m.height && m.height / m.width >= 1.6;

/**
 * Deterministic pre-publish checks for one target. Mirrors what Postiz's checkValidity()
 * and settings DTOs refuse, plus Arcatic rules (Postiz media formats, short-video shape).
 */
export function validateTarget(input: TargetInput): TargetReport {
  const rule = CHANNEL_RULES[input.channel];
  const issues: TargetIssue[] = [];
  const err = (message: string, field?: string) => issues.push({ severity: "error", message, field });
  const warn = (message: string, field?: string) => issues.push({ severity: "warning", message, field });

  const parsed = CHANNEL_SETTINGS[input.channel].safeParse(input.settings ?? {});
  const settings = (parsed.success ? parsed.data : input.settings) as Record<string, unknown>;
  if (!parsed.success) for (const i of parsed.error.issues) err(i.message, `settings.${i.path.join(".")}`);

  const media = input.media;
  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");
  const posts = input.thread?.length ? input.thread : [input.text];
  const length = len(posts[0] ?? "", rule.counting);

  if (rule.maxChars) {
    posts.forEach((p, i) => {
      const n = len(p, rule.counting);
      if (n > rule.maxChars!) err(`${posts.length > 1 ? `Post ${i + 1} of the thread` : "The text"} is ${n} characters; ${rule.label} allows ${rule.maxChars}.`, "text");
    });
  }
  if (rule.transport === "postiz") {
    if (!input.text.trim() && media.length === 0) err("Add some text or at least one image or video.", "text");
    for (const m of media) {
      if (!(POSTIZ_MEDIA_EXTENSIONS as readonly string[]).includes(m.ext)) err(`A ${m.kind} is .${m.ext}; publishing accepts ${POSTIZ_MEDIA_EXTENSIONS.join(", ")}. Re-export it (videos: render in the video editor).`, "media");
    }
    if (input.thread && input.thread.length > 1 && media.length && input.channel === "linkedin") err("LinkedIn comments can only contain text.", "media");
  }

  switch (input.channel) {
    case "instagram": {
      if (!media.length) err("Instagram needs at least one image or video.", "media");
      if (media.length > 20) err("Instagram carousels take up to 20 items.", "media");
      if (settings.is_trial_reel && (media.length !== 1 || !videos.length)) err("A trial Reel must be exactly one video.", "settings.is_trial_reel");
      if (videos.length === 1 && media.length === 1 && !vertical(videos[0]!)) warn("Reels look best as vertical 9:16 video.", "media");
      break;
    }
    case "facebook":
      if (settings.post_type === "story" && !media.length) err("A Facebook story needs an image or video.", "media");
      break;
    case "linkedin":
      if (settings.post_as_images_carousel && (images.length < 2 || videos.length)) err("A LinkedIn carousel needs 2 or more images and no video.", "settings.post_as_images_carousel");
      if (media.length > 1 && videos.length) err("LinkedIn allows one media item when it's a video.", "media");
      break;
    case "tiktok": {
      if (!media.length) err("TikTok needs a video or photos.", "media");
      if (media.length > 1 && videos.length) err("TikTok takes one video, or several photos (not both).", "media");
      const big = images.find((m) => Math.min(m.width ?? 0, m.height ?? 0) > 1080);
      if (big) err(`TikTok photos can be at most 1080 px on the shorter side (one is ${big.width}×${big.height}).`, "media");
      if (videos.length === 1 && !vertical(videos[0]!)) warn("TikTok is vertical: 9:16 video is recommended.", "media");
      if (settings.content_posting_method === "UPLOAD") warn("“Upload” only sends the video to the TikTok app inbox; someone must finish posting it there within 24 hours.", "settings.content_posting_method");
      break;
    }
    case "youtube": {
      if (media.length !== 1 || videos.length !== 1) err("YouTube needs exactly one video.", "media");
      const tagsLen = ((settings.tags as Array<{ label: string }> | undefined) ?? []).reduce((s, t) => s + t.label.length + (/\s/.test(t.label) ? 2 : 0), 0);
      if (tagsLen > 500) err("YouTube tags can total at most 500 characters.", "settings.tags");
      break;
    }
    case "gbp":
      if (media.length > 1) err("Business Profile posts take one image.", "media");
      if (videos.length) err("Business Profile posts don't support video.", "media");
      if (settings.topicType === "EVENT" && !settings.eventTitle) err("Event posts need an event title.", "settings.eventTitle");
      if (settings.callToActionType && settings.callToActionType !== "NONE" && settings.callToActionType !== "CALL" && !settings.callToActionUrl) err("Add the link for the call-to-action button.", "settings.callToActionUrl");
      warn("Business Profile posts are labelled as English by the publisher (Postiz sends languageCode “en”).");
      break;
    case "wordpress":
      if (!input.html?.trim()) err("The article body is empty.", "text");
      if (videos.length) warn("Videos aren't uploaded to WordPress; only the first image is used as the featured image.", "media");
      break;
    case "email":
      if (!input.html?.trim()) err("The email body is empty.", "text");
      if (media.length) warn("Attachments aren't sent; put images in the email content instead.", "media");
      break;
    default:
      break;
  }
  return { passed: !issues.some((i) => i.severity === "error"), issues, settings, length, limit: rule.maxChars };
}
