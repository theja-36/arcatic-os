import { z } from "zod";
import type { ContentDoc } from "../content/doc.js";
import { isQuestion, shapeOf } from "./score.js";
import { plainOf, sentences } from "./text.js";

/** Per-content SEO settings stored in content_items.seo. */
export const SeoSettingsSchema = z.object({
  primary: z.string().trim().max(120).nullable().optional(),
  secondary: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  question: z.string().trim().max(300).nullable().optional(),
  intent: z.enum(["informational", "commercial", "transactional", "navigational"]).nullable().optional(),
  canonicalUrl: z.string().url().max(2000).nullable().optional(),
  keywordSetId: z.string().uuid().nullable().optional(),
});
export type SeoSettings = z.infer<typeof SeoSettingsSchema>;

/** Question headings followed by their first paragraph → FAQ pairs. */
export function faqPairs(doc: ContentDoc): Array<{ q: string; a: string }> {
  const out: Array<{ q: string; a: string }> = [];
  doc.blocks.forEach((b, i) => {
    if (b.kind !== "heading" || !isQuestion(b.text)) return;
    const next = doc.blocks[i + 1];
    if (next && (next.kind === "paragraph" || next.kind === "body")) out.push({ q: b.text.trim(), a: plainOf(next.text).trim() });
  });
  return out;
}

/**
 * schema.org JSON-LD for a published article (+ FAQPage when the article has question/answer
 * pairs). Only facts Arcatic knows are included; nothing is invented (no ratings, no authors
 * that weren't given).
 */
export function articleJsonLd(doc: ContentDoc, meta: { url?: string | null; publisher?: string | null; author?: string | null; datePublished?: string | null; dateModified?: string | null; image?: string | null; language?: string | null }): Record<string, unknown>[] {
  const d = shapeOf(doc);
  const article: Record<string, unknown> = {
    "@context": "https://schema.org", "@type": "Article",
    headline: d.title.slice(0, 110),
    ...(d.meta && { description: d.meta }),
    ...(meta.url && { mainEntityOfPage: meta.url, url: meta.url }),
    ...(meta.image && { image: [meta.image] }),
    ...(meta.datePublished && { datePublished: meta.datePublished }),
    ...(meta.dateModified && { dateModified: meta.dateModified }),
    ...(meta.author && { author: { "@type": "Person", name: meta.author } }),
    ...(meta.publisher && { publisher: { "@type": "Organization", name: meta.publisher } }),
    ...(meta.language && { inLanguage: meta.language }),
    wordCount: d.wordCount,
  };
  const faqs = faqPairs(doc);
  const out = [article];
  if (faqs.length >= 2) {
    out.push({
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: sentences(f.a).slice(0, 3).join(" ") } })),
    });
  }
  return out;
}
