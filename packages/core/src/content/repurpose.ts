import { CONTENT_TYPE_DEFS, type ContentType } from "./types.js";

/**
 * One-to-many repurposing: a source (Knowledge source: URL, crawl, document, transcribed video;
 * or an existing content item) is read once into a digest, then each requested output is
 * generated from that digest, restricted to the same source for facts, so every piece cites it.
 */
export interface RepurposeOutput {
  id: string;
  label: string;
  type: ContentType;
  channel?: string;
  extra?: Record<string, unknown>;
}

export const REPURPOSE_OUTPUTS: RepurposeOutput[] = [
  { id: "instagram_post", label: "Instagram post", type: "social_post", channel: "instagram" },
  { id: "instagram_carousel", label: "Instagram carousel", type: "carousel", channel: "instagram" },
  { id: "linkedin_post", label: "LinkedIn post", type: "social_post", channel: "linkedin" },
  { id: "linkedin_carousel", label: "LinkedIn carousel", type: "carousel", channel: "linkedin" },
  { id: "facebook_post", label: "Facebook post", type: "social_post", channel: "facebook" },
  { id: "threads_post", label: "Threads post", type: "social_post", channel: "threads" },
  { id: "x_thread", label: "X thread", type: "x_thread", channel: "x" },
  { id: "short_video", label: "Short-video script", type: "short_video", channel: "instagram", extra: { format: "short", seconds: 45 } },
  { id: "youtube_script", label: "YouTube script", type: "yt_script", channel: "youtube" },
  { id: "blog", label: "Blog article", type: "blog", channel: "blog" },
  { id: "newsletter", label: "Newsletter", type: "newsletter", channel: "email" },
  { id: "email", label: "Promotional email", type: "email", channel: "email" },
  { id: "gbp_post", label: "Business Profile update", type: "social_post", channel: "gbp" },
  { id: "faq", label: "FAQ document", type: "document", extra: { kind: "faq", words: 600 } },
];
export const repurposeOutputById = (id: string) => REPURPOSE_OUTPUTS.find((o) => o.id === id);

export interface Digest {
  title: string;
  summary: string;
  key_points: Array<{ point: string; chunk_ids: string[] }>;
  quotes: Array<{ text: string; chunk_id: string }>;
  angles: Array<{ angle: string; best_for: string }>;
}

export interface SourceRef {
  kind: "source" | "content";
  id: string;
  title: string;
  url?: string | null;
  sourceType?: string | null;   // url | crawl | file | text | media | drive
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The generation input for one output, built from the digest (fits the templates' 2,000-character topic). */
export function repurposeInput(d: Digest, out: RepurposeOutput, o: { language: string; ref: SourceRef; angleIndex?: number }): { templateKey: string; input: Record<string, unknown> } {
  const def = CONTENT_TYPE_DEFS[out.type];
  if (!def.template) throw new Error(`${out.type} can't be generated`);
  const angle = d.angles.length ? d.angles[(o.angleIndex ?? 0) % d.angles.length]! : null;
  const points = d.key_points.slice(0, 8).map((p) => `- ${p.point}`).join("\n");
  const quote = d.quotes[0] ? `\nA line worth quoting (exact words): "${d.quotes[0].text}"` : "";
  const srcLabel = o.ref.kind === "source" && o.ref.sourceType === "media" ? "video" : o.ref.sourceType === "url" || o.ref.sourceType === "crawl" ? "web page" : o.ref.kind === "content" ? "article" : "document";
  const topic = clip(`Repurpose our ${srcLabel} "${d.title}" for this format.\nSummary: ${d.summary}\nKey points:\n${points}${quote}`, 2000);
  const focus = clip([
    angle && `Angle: ${angle.angle}`,
    "Use only facts from the source material provided as knowledge; cite the snippets you rely on.",
    o.ref.url && `Where a link fits, point readers to ${o.ref.url}.`,
  ].filter(Boolean).join(" "), 1000);
  return { templateKey: def.template, input: { ...(out.channel && { channel: out.channel }), ...out.extra, topic, focus, language: o.language } };
}

/** Brainstorm idea → generation request for a draft. */
export interface Idea { title: string; angle: string; format: string; channel: string; why: string }
export function ideaToRequest(idea: Idea, language: string): { type: ContentType; input: Record<string, unknown> } {
  const type: ContentType = idea.format in CONTENT_TYPE_DEFS && CONTENT_TYPE_DEFS[idea.format as ContentType].template && CONTENT_TYPE_DEFS[idea.format as ContentType].category === "text"
    ? (idea.format as ContentType) : "social_post";
  const def = CONTENT_TYPE_DEFS[type];
  const channel = def.channels && (def.channels as readonly string[]).includes(idea.channel) ? idea.channel : "defaultChannel" in def ? def.defaultChannel : undefined;
  return {
    type,
    input: {
      ...(channel && { channel }), topic: clip(`${idea.title}. ${idea.angle}`, 2000), focus: clip(idea.why, 1000), language,
      ...(type === "short_video" && { format: "short", seconds: 45 }),
    },
  };
}
