import { CHANNEL_LIMITS, type Channel } from "./platforms.js";
import { extractHashtags, extractUrls, findTerm, graphemeLength, xWeightedLength } from "./text.js";

export type Severity = "error" | "warning";

export interface ValidationIssue {
  code:
    | "banned_word" | "too_long" | "too_many_hashtags" | "missing_cta" | "missing_link"
    | "link_not_clickable" | "missing_disclaimer" | "empty" | "uncited_claim";
  severity: Severity;
  message: string;
  index?: number;
  length?: number;
}

export interface ValidationReport {
  passed: boolean;
  issues: ValidationIssue[];
  stats: { length: number; limit?: number; hashtags: number; links: number };
}

export interface ContentRules {
  channel?: Channel;
  bannedWords?: readonly string[];
  requiredCta?: boolean;
  ctaPhrases?: readonly string[];
  requireLink?: boolean;
  requiredDisclaimers?: readonly string[];
  /** strict: numeric claims ("40% faster", "₹999") must be backed by a citation id */
  claimsPolicy?: "strict" | "relaxed";
  citedClaims?: readonly string[];
  maxHashtagsOverride?: number;
}

/** Numbers/prices that count as claims; any that also appear in the sources count as cited. */
export const numericClaims = (text: string) => [...text.matchAll(NUMERIC_CLAIM_RE)].map((m) => m[0]);
const NUMERIC_CLAIM_RE = /(?:[₹$€£]\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|x\b|percent|lakh|crore|k\b|m\b))/giu;

export function validateContent(text: string, rules: ContentRules = {}): ValidationReport {
  const issues: ValidationIssue[] = [];
  const trimmed = text.trim();
  const limits = rules.channel ? CHANNEL_LIMITS[rules.channel] : undefined;
  const length = limits?.counting === "x_weighted" ? xWeightedLength(trimmed) : graphemeLength(trimmed);
  const hashtags = extractHashtags(trimmed);
  const links = extractUrls(trimmed);

  if (!trimmed) issues.push({ code: "empty", severity: "error", message: "Content is empty." });

  for (const word of rules.bannedWords ?? []) {
    for (const hit of findTerm(trimmed, word)) {
      issues.push({ code: "banned_word", severity: "error", message: `Avoid "${word}".`, ...hit });
    }
  }

  if (limits && length > limits.maxChars) {
    issues.push({
      code: "too_long",
      severity: "error",
      message: `${length} characters; ${rules.channel} allows ${limits.maxChars}.`,
    });
  }

  const maxTags = rules.maxHashtagsOverride ?? limits?.maxHashtags;
  if (maxTags !== undefined && hashtags.length > maxTags) {
    issues.push({ code: "too_many_hashtags", severity: "error", message: `${hashtags.length} hashtags; max ${maxTags}.` });
  }

  if (rules.requiredCta) {
    const phrases = rules.ctaPhrases ?? [];
    const hasCta = phrases.length === 0 ? links.length > 0 : phrases.some((p) => findTerm(trimmed, p).length > 0);
    if (!hasCta) issues.push({ code: "missing_cta", severity: "warning", message: "No call to action found." });
  }

  if (rules.requireLink && links.length === 0) {
    issues.push({ code: "missing_link", severity: "error", message: "A link is required." });
  }
  if (limits && !limits.linksClickable && links.length > 0) {
    issues.push({
      code: "link_not_clickable",
      severity: "warning",
      message: `Links are not clickable on ${rules.channel}; use "link in bio" or a sticker.`,
    });
  }

  for (const d of rules.requiredDisclaimers ?? []) {
    if (findTerm(trimmed, d).length === 0) {
      issues.push({ code: "missing_disclaimer", severity: "error", message: `Missing required disclaimer: "${d}".` });
    }
  }

  if (rules.claimsPolicy === "strict") {
    const cited = new Set((rules.citedClaims ?? []).map((c) => c.toLowerCase()));
    for (const m of trimmed.matchAll(NUMERIC_CLAIM_RE)) {
      if (!cited.has(m[0].toLowerCase())) {
        issues.push({
          code: "uncited_claim",
          severity: "error",
          message: `"${m[0]}" needs a source.`,
          index: m.index,
          length: m[0].length,
        });
      }
    }
  }

  return {
    passed: !issues.some((i) => i.severity === "error"),
    issues,
    stats: { length, limit: limits?.maxChars, hashtags: hashtags.length, links: links.length },
  };
}
