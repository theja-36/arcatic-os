import type { GoogleCreative } from "./schemas.js";

/**
 * Google responsive search ad limits (Google Ads Help "About responsive search ads" and the
 * Google Ads API RSA guide): 3–15 headlines of ≤ 30 characters, 2–4 descriptions of ≤ 90,
 * display paths ≤ 15 each. Double-width characters (e.g. CJK) count as two.
 */
export const RSA = { headlines: { min: 3, max: 15, chars: 30 }, descriptions: { min: 2, max: 4, chars: 90 }, path: 15 } as const;

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;
export const googleLength = (s: string) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);

/** Minor currency units (paise, cents) → Google micros (1 unit = 1,000,000 micros). */
export const minorToMicros = (minor: number) => Math.round(minor) * 10_000;
export const microsToMinor = (micros: number) => Math.round(micros / 10_000);

export interface AdIssue { code: string; severity: "error" | "warning"; field: string; message: string }

export function checkRsa(c: GoogleCreative): AdIssue[] {
  const out: AdIssue[] = [];
  const h = c.headlines.map((s) => s.trim()).filter(Boolean);
  const d = c.descriptions.map((s) => s.trim()).filter(Boolean);
  if (h.length < RSA.headlines.min) out.push({ code: "rsa_headlines_min", severity: "error", field: "headlines", message: `Add at least ${RSA.headlines.min} headlines (${h.length} now).` });
  if (h.length > RSA.headlines.max) out.push({ code: "rsa_headlines_max", severity: "error", field: "headlines", message: `At most ${RSA.headlines.max} headlines.` });
  if (d.length < RSA.descriptions.min) out.push({ code: "rsa_descriptions_min", severity: "error", field: "descriptions", message: `Add at least ${RSA.descriptions.min} descriptions (${d.length} now).` });
  if (d.length > RSA.descriptions.max) out.push({ code: "rsa_descriptions_max", severity: "error", field: "descriptions", message: `At most ${RSA.descriptions.max} descriptions.` });
  h.forEach((s, i) => { if (googleLength(s) > RSA.headlines.chars) out.push({ code: "rsa_headline_length", severity: "error", field: `headlines.${i}`, message: `Headline ${i + 1} is ${googleLength(s)} characters (max ${RSA.headlines.chars}).` }); });
  d.forEach((s, i) => { if (googleLength(s) > RSA.descriptions.chars) out.push({ code: "rsa_description_length", severity: "error", field: `descriptions.${i}`, message: `Description ${i + 1} is ${googleLength(s)} characters (max ${RSA.descriptions.chars}).` }); });
  for (const [k, v] of [["path1", c.path1], ["path2", c.path2]] as const) if (v && googleLength(v) > RSA.path) out.push({ code: "rsa_path_length", severity: "error", field: k, message: `${k} is over ${RSA.path} characters.` });
  if (c.path2 && !c.path1) out.push({ code: "rsa_path_order", severity: "error", field: "path2", message: "Set path 1 before path 2." });
  const dupes = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) !== i);
  if (dupes(h).length) out.push({ code: "rsa_duplicate", severity: "error", field: "headlines", message: "Headlines must be different from each other." });
  if (dupes(d).length) out.push({ code: "rsa_duplicate", severity: "error", field: "descriptions", message: "Descriptions must be different from each other." });
  if (h.length >= RSA.headlines.min && h.length < 8) out.push({ code: "rsa_variety", severity: "warning", field: "headlines", message: "More distinct headlines (8–10+) give Google more combinations to test." });
  // Google editorial rules: no "!" in headlines, no gimmicky capitalisation or repeated punctuation
  h.forEach((s, i) => { if (s.includes("!")) out.push({ code: "editorial_exclamation", severity: "warning", field: `headlines.${i}`, message: `Headline ${i + 1} has "!"; Google's editorial policy does not allow exclamation marks in headlines.` }); });
  [...h, ...d].forEach((s) => {
    if (/([!?.])\1/.test(s)) out.push({ code: "editorial_punctuation", severity: "warning", field: "creative", message: `Repeated punctuation in "${s}" is usually disapproved.` });
    if (/\b[A-Z]{4,}\b/.test(s) && !/\b(HTTP|HTTPS|USA|INR|GST|SaaS)\b/.test(s)) out.push({ code: "editorial_caps", severity: "warning", field: "creative", message: `All-caps words in "${s}" may be disapproved (acronyms are fine).` });
    if (/(\+?\d[\d\s-]{8,}\d)/.test(s)) out.push({ code: "editorial_phone", severity: "warning", field: "creative", message: "Phone numbers belong in a call asset, not in ad text." });
  });
  return out;
}
