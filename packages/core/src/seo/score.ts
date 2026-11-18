import type { ContentDoc } from "../content/doc.js";
import { contentWords, countPhrase, hasPhrase, hostOf, isInternal, linksIn, sentences, words, type DocLink } from "./text.js";

/**
 * Deterministic SEO + AEO (answer-engine) checks for long-form content. These are writing
 * heuristics, not a ranking prediction: no tool can promise positions in Google or in AI answers.
 * Every check says what it looked at so a person can disagree with it.
 */
export type CheckStatus = "pass" | "warn" | "fail";
export interface SeoCheck { id: string; group: "seo" | "aeo"; label: string; status: CheckStatus; detail: string; weight: number; blockId?: string }
export interface SeoTarget { primary?: string | null; secondary?: readonly string[]; question?: string | null }
export interface ScoreResult { score: number; checks: SeoCheck[] }

const QUESTION = /^(what|why|how|when|where|who|which|can|should|is|are|does|do|will)\b|\?\s*$/i;
export const isQuestion = (s: string) => QUESTION.test(s.trim());

function grade(checks: SeoCheck[]): number {
  const total = checks.reduce((s, c) => s + c.weight, 0);
  if (!total) return 0;
  const got = checks.reduce((s, c) => s + c.weight * (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);
  return Math.round((got / total) * 100);
}

export interface DocShape {
  title: string;
  meta: string;
  headings: Array<{ id: string; text: string }>;
  paragraphs: Array<{ id: string; text: string }>;
  listItems: number;
  bodyText: string;
  wordCount: number;
  links: DocLink[];
}

export function shapeOf(doc: ContentDoc): DocShape {
  const by = (k: string) => doc.blocks.filter((b) => b.kind === k);
  const paragraphs = doc.blocks.filter((b) => b.kind === "paragraph" || b.kind === "body" || b.kind === "hook").map((b) => ({ id: b.id, text: b.text }));
  const bodyBlocks = doc.blocks.filter((b) => !["title", "meta_description", "hashtags", "alt_text", "image_prompt"].includes(b.kind));
  const bodyText = bodyBlocks.map((b) => b.text).join("\n\n");
  return {
    title: by("title")[0]?.text ?? by("headline")[0]?.text ?? "",
    meta: by("meta_description")[0]?.text ?? "",
    headings: by("heading").map((b) => ({ id: b.id, text: b.text })),
    paragraphs,
    listItems: by("list_item").length,
    bodyText,
    wordCount: words(bodyText).length,
    links: doc.blocks.flatMap((b) => linksIn(b.id, b.text)),
  };
}

const check = (c: SeoCheck) => c;

export function scoreSeo(doc: ContentDoc, target: SeoTarget, opts: { siteHosts?: readonly string[]; minWords?: number } = {}): ScoreResult {
  const d = shapeOf(doc);
  const kw = target.primary?.trim() || null;
  const checks: SeoCheck[] = [];
  const minWords = opts.minWords ?? 600;

  if (!kw) {
    checks.push(check({ id: "keyword_set", group: "seo", label: "Target keyword", status: "warn", detail: "No target keyword set, so placement checks were skipped.", weight: 2 }));
  } else {
    checks.push(check({ id: "kw_title", group: "seo", label: "Keyword in title", status: hasPhrase(d.title, kw) ? "pass" : "fail", detail: d.title ? `Title: "${d.title}"` : "No title.", weight: 3 }));
    const first100 = words(d.paragraphs.map((p) => p.text).join(" ")).slice(0, 100).join(" ");
    checks.push(check({ id: "kw_intro", group: "seo", label: "Keyword in the first 100 words", status: hasPhrase(first100, kw) ? "pass" : "warn", detail: "Readers and search engines both use the opening to judge relevance.", weight: 2 }));
    const inHeading = d.headings.some((h) => hasPhrase(h.text, kw) || (target.secondary ?? []).some((s) => hasPhrase(h.text, s)));
    checks.push(check({ id: "kw_heading", group: "seo", label: "Keyword or a secondary keyword in a heading", status: d.headings.length === 0 ? "warn" : inHeading ? "pass" : "warn", detail: `${d.headings.length} heading(s).`, weight: 1 }));
    checks.push(check({ id: "kw_meta", group: "seo", label: "Keyword in meta description", status: !d.meta ? "fail" : hasPhrase(d.meta, kw) ? "pass" : "warn", detail: d.meta ? `${d.meta.length} characters.` : "No meta description.", weight: 1 }));
    const n = countPhrase(d.bodyText, kw);
    const density = d.wordCount ? (n * words(kw).length * 100) / d.wordCount : 0;
    checks.push(check({
      id: "kw_density", group: "seo", label: "Keyword used naturally",
      status: n === 0 ? "fail" : density > 3 ? "fail" : density > 2.5 ? "warn" : "pass",
      detail: `${n} use(s), about ${density.toFixed(1)}% of words.${density > 2.5 ? " Reads as keyword stuffing; use synonyms." : ""}`, weight: 2,
    }));
  }

  const tl = [...d.title].length;
  checks.push(check({ id: "title_length", group: "seo", label: "Title length", status: tl === 0 ? "fail" : tl >= 30 && tl <= 60 ? "pass" : tl <= 70 ? "warn" : "fail", detail: `${tl} characters; titles over about 60 are often cut off in results.`, weight: 1 }));
  const ml = [...d.meta].length;
  checks.push(check({ id: "meta_length", group: "seo", label: "Meta description length", status: ml === 0 ? "fail" : ml >= 70 && ml <= 160 ? "pass" : "warn", detail: `${ml} characters (70–160 recommended).`, weight: 1 }));
  checks.push(check({ id: "length", group: "seo", label: "Depth", status: d.wordCount >= minWords ? "pass" : d.wordCount >= minWords / 2 ? "warn" : "fail", detail: `${d.wordCount} words (aim for ${minWords}+ for this format).`, weight: 1 }));
  checks.push(check({ id: "structure", group: "seo", label: "Headings break up the text", status: d.wordCount < 400 || d.headings.length >= Math.max(2, Math.floor(d.wordCount / 350)) ? "pass" : d.headings.length > 0 ? "warn" : "fail", detail: `${d.headings.length} heading(s) for ${d.wordCount} words.`, weight: 1 }));

  const long = d.paragraphs.filter((p) => words(p.text).length > 150);
  checks.push(check({ id: "paragraphs", group: "seo", label: "Short paragraphs", status: long.length === 0 ? "pass" : "warn", detail: long.length ? `${long.length} paragraph(s) over 150 words.` : "All paragraphs are easy to scan.", weight: 1, ...(long[0] && { blockId: long[0].id }) }));
  const sents = sentences(d.bodyText);
  const avg = sents.length ? words(d.bodyText).length / sents.length : 0;
  checks.push(check({ id: "readability", group: "seo", label: "Sentence length", status: avg <= 22 ? "pass" : avg <= 28 ? "warn" : "fail", detail: `About ${Math.round(avg)} words per sentence.`, weight: 1 }));

  const hosts = opts.siteHosts ?? [];
  const internal = d.links.filter((l) => isInternal(l.url, hosts));
  const external = d.links.filter((l) => !isInternal(l.url, hosts) && hostOf(l.url));
  checks.push(check({ id: "internal_links", group: "seo", label: "Internal links", status: !hosts.length ? "warn" : internal.length >= 2 ? "pass" : internal.length === 1 ? "warn" : "fail", detail: hosts.length ? `${internal.length} link(s) to your site.` : "Add your website in the brand kit to check internal links.", weight: 1 }));
  checks.push(check({ id: "external_sources", group: "seo", label: "Links to sources", status: external.length ? "pass" : "warn", detail: `${external.length} outbound link(s).`, weight: 1 }));

  checks.push(...aeoChecks(d, target));
  return { score: grade(checks), checks };
}

/** Answer-engine checks: is the content easy to quote as a direct answer? */
function aeoChecks(d: DocShape, target: SeoTarget): SeoCheck[] {
  const out: SeoCheck[] = [];
  const first = d.paragraphs[0];
  const firstWords = first ? words(first.text).length : 0;
  const firstSentence = first ? sentences(first.text)[0] ?? "" : "";
  const topic = target.primary ?? target.question ?? "";
  out.push({
    id: "answer_first", group: "aeo", label: "Answer first",
    status: !first ? "fail" : words(firstSentence).length <= 35 && (!topic || overlap(firstSentence, topic) >= 0.5) ? "pass" : "warn",
    detail: "Open with a one- or two-sentence direct answer, then expand.", weight: 3, ...(first && { blockId: first.id }),
  });
  if (first && firstWords > 90) out[out.length - 1]!.detail += ` The first paragraph is ${firstWords} words.`;

  const qHeads = d.headings.filter((h) => isQuestion(h.text));
  out.push({ id: "question_headings", group: "aeo", label: "Question-style headings", status: qHeads.length >= 2 ? "pass" : qHeads.length === 1 ? "warn" : "fail", detail: `${qHeads.length} heading(s) phrased as the questions people ask.`, weight: 2 });

  // each question heading should be followed by a short paragraph that answers it
  const blocks = [...d.headings.map((h) => ({ ...h, k: "h" as const })), ...d.paragraphs.map((p) => ({ ...p, k: "p" as const }))]
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const unanswered: string[] = [];
  for (const q of qHeads) {
    const i = blocks.findIndex((b) => b.id === q.id);
    const next = blocks[i + 1];
    if (!next || next.k !== "p" || words(sentences(next.text)[0] ?? "").length > 40) unanswered.push(q.id);
  }
  if (qHeads.length) out.push({ id: "concise_answers", group: "aeo", label: "Short answer under each question", status: unanswered.length === 0 ? "pass" : "warn", detail: unanswered.length ? `${unanswered.length} question(s) are not followed by a short direct answer.` : "Each question gets a quotable answer.", weight: 2, ...(unanswered[0] && { blockId: unanswered[0] }) });

  const faq = d.headings.some((h) => /\b(faq|frequently asked)/i.test(h.text)) || qHeads.length >= 3;
  out.push({ id: "faq", group: "aeo", label: "FAQ section", status: faq ? "pass" : "warn", detail: faq ? "FAQ structured data can be generated." : "Add 3+ common questions with short answers.", weight: 1 });
  out.push({ id: "lists", group: "aeo", label: "Lists or steps", status: d.listItems >= 3 ? "pass" : "warn", detail: `${d.listItems} list item(s); steps and lists are easy to extract.`, weight: 1 });
  const specifics = (d.bodyText.match(/\b\d[\d,.]*\s?(%|percent|years?|months?|days?|hours?|minutes?|kg|km|₹|rs\.?|inr|usd|\$)?/gi) ?? []).length;
  out.push({ id: "specifics", group: "aeo", label: "Concrete facts", status: specifics >= 3 ? "pass" : "warn", detail: `${specifics} figure(s). Specific, sourced facts are more likely to be quoted.`, weight: 1 });
  return out;
}

/** Share of the topic's content words that appear in the text. */
export function overlap(text: string, topic: string): number {
  const t = new Set(contentWords(text));
  const q = [...new Set(contentWords(topic))];
  if (!q.length) return 1;
  return q.filter((w) => t.has(w)).length / q.length;
}
