import type { ContentDoc } from "../content/doc.js";
import { plainOf, sentences } from "../seo/text.js";
import { googleLength, RSA } from "./google.js";
import { META_RECOMMENDED } from "./meta.js";
import type { GoogleCreative, MetaCreative } from "./schemas.js";

/**
 * Organic → paid: seed an ad from a post that already performed. Only text that fits the limits
 * as-is is used (no mid-word truncation); the AI copy step fills the rest and a person reviews it.
 */
const pick = (doc: ContentDoc, kinds: string[]) => doc.blocks.filter((b) => kinds.includes(b.kind)).map((b) => plainOf(b.text).replace(/https?:\/\/\S+/g, "").replace(/#\w+/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);

function fitting(texts: string[], max: number, measure: (s: string) => number = (s) => [...s].length): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const s of [t, ...sentences(t)]) {
      const clean = s.replace(/[.\s]+$/, "").trim();
      if (clean && measure(clean) <= max && !out.some((o) => o.toLowerCase() === clean.toLowerCase())) out.push(clean);
    }
  }
  return out;
}

export function seedGoogleCreative(doc: ContentDoc): GoogleCreative {
  const short = pick(doc, ["title", "headline", "hook", "heading", "slide_headline", "subhead"]);
  const long = pick(doc, ["hook", "caption", "body", "primary_text", "paragraph", "description", "meta_description"]);
  return {
    headlines: fitting(short, RSA.headlines.chars, googleLength).slice(0, RSA.headlines.max),
    descriptions: fitting(long, RSA.descriptions.chars, googleLength).slice(0, RSA.descriptions.max),
    path1: null, path2: null,
  };
}

export function seedMetaCreative(doc: ContentDoc): MetaCreative {
  const body = pick(doc, ["primary_text", "caption", "hook", "body", "paragraph"]);
  const heads = fitting(pick(doc, ["headline", "title", "hook", "slide_headline"]), META_RECOMMENDED.headline);
  return { primaryText: body.join("\n\n").slice(0, 2000), headline: heads[0] ?? "", description: null, cta: "LEARN_MORE", mediaAssetId: null };
}
