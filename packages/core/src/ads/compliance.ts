import { checkRsa, type AdIssue } from "./google.js";
import { checkMetaCreative, checkSpecialCategory, personalAttributeRisk, POLITICAL, suggestSpecialCategories } from "./meta.js";
import { GoogleCreativeSchema, MetaCreativeSchema, type AdAudience, type AdPlatform } from "./schemas.js";
import { checkBudget, type BudgetPolicy } from "./budget.js";

/**
 * Deterministic pre-flight checks before anyone can ask to launch. They catch the common,
 * mechanical reasons for disapproval and the claims a reviewer must look at. They are not a
 * substitute for the platforms' own review, which still happens after creation.
 */
export interface ComplianceInput {
  platform: AdPlatform;
  name: string;
  objective: string;
  audience: AdAudience;
  creative: unknown;
  landingUrl: string | null | undefined;
  dailyBudgetMinor: number | null | undefined;
  startDate?: string | null;
  endDate?: string | null;
  specialAdCategories: readonly string[];
  hasImage?: boolean;
  policy: BudgetPolicy | null;
  today?: string;
}
export interface ComplianceReport { passed: boolean; issues: AdIssue[]; checkedAt: string }

const RISKY: Array<[string, RegExp, string]> = [
  ["claim_guarantee", /\b(guarantee[sd]?|100% (results|guaranteed|safe)|risk[- ]free|no risk)\b/i, "Guarantees need proof and are often disapproved."],
  ["claim_health", /\b(cure[sd]?|heal[s]?|treat[s]?|prevent[s]? (cancer|diabetes|covid)|lose \d+\s?(kg|kilos|pounds|lbs)|miracle|detox)\b/i, "Health and weight-loss claims are restricted on both platforms."],
  ["claim_money", /\b(get rich|earn ₹?\$?\d[\d,]* (a|per) (day|week|month)|double your money|guaranteed returns?|passive income)\b/i, "Income and returns claims are restricted."],
  ["claim_superlative", /\b(#1|no\.?\s?1|number one|best in (india|the world)|world'?s best)\b/i, "Superlatives need third-party proof you can show on the landing page."],
  ["claim_urgency", /\b(only \d+ left|last chance|act now|today only)\b/i, "Urgency must be true at the time the ad runs."],
];

export function checkCompliance(input: ComplianceInput): ComplianceReport {
  const issues: AdIssue[] = [];
  let texts: string[] = [];
  if (input.platform === "google") {
    const c = GoogleCreativeSchema.safeParse(input.creative ?? {});
    if (!c.success) issues.push({ code: "creative_invalid", severity: "error", field: "creative", message: "Creative is incomplete." });
    else { issues.push(...checkRsa(c.data)); texts = [...c.data.headlines, ...c.data.descriptions]; }
    if (!input.audience.keywords.length) issues.push({ code: "keywords_min", severity: "error", field: "audience.keywords", message: "Search campaigns need at least one keyword." });
    if (!input.audience.locations.length) issues.push({ code: "locations_min", severity: "error", field: "audience.locations", message: "Choose at least one location." });
  } else {
    const c = MetaCreativeSchema.safeParse(input.creative ?? {});
    if (!c.success) issues.push({ code: "creative_invalid", severity: "error", field: "creative", message: "Creative is incomplete." });
    else {
      issues.push(...checkMetaCreative(c.data, { hasImage: !!input.hasImage }));
      texts = [c.data.primaryText, c.data.headline, c.data.description ?? ""];
      const pa = texts.map(personalAttributeRisk).find(Boolean);
      if (pa) issues.push({ code: "meta_personal_attributes", severity: "error", field: "creative", message: `"${pa}" may assert or imply a personal attribute, which Meta's advertising standards prohibit. Rephrase without "you/your" plus a sensitive trait.` });
    }
    if (!input.audience.locations.length) issues.push({ code: "locations_min", severity: "error", field: "audience.locations", message: "Choose at least one location." });
    issues.push(...checkSpecialCategory(input.specialAdCategories, input.audience));
    const hinted = suggestSpecialCategories(`${input.name} ${texts.join(" ")}`).filter((k) => !input.specialAdCategories.includes(k));
    if (hinted.length) issues.push({ code: "special_category_hint", severity: "warning", field: "specialAdCategories", message: `This looks like it may be a ${hinted.join(" / ").toLowerCase().replace(/_/g, " ")} ad. If so, declare the special ad category or Meta will reject it.` });
  }
  if (input.audience.ageMin > input.audience.ageMax) issues.push({ code: "age_range", severity: "error", field: "audience.age", message: "Minimum age is above maximum age." });

  const all = `${input.name} ${texts.join(" ")}`;
  if (POLITICAL.test(all)) issues.push({ code: "political", severity: "error", field: "creative", message: "Political and election ads need platform authorisation and disclaimers; Arcatic doesn't create them." });
  for (const [code, re, why] of RISKY) {
    const m = texts.find((t) => re.test(t));
    if (m) issues.push({ code, severity: "warning", field: "creative", message: `"${m}": ${why}` });
  }

  if (!input.landingUrl) issues.push({ code: "landing_url", severity: "error", field: "landingUrl", message: "Add the landing page URL." });
  else if (!/^https:\/\//i.test(input.landingUrl)) issues.push({ code: "landing_https", severity: "error", field: "landingUrl", message: "Landing page must use https." });

  issues.push(...checkBudget(input.dailyBudgetMinor ?? null, input.policy));
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  if (input.startDate && input.startDate < today) issues.push({ code: "start_past", severity: "error", field: "startDate", message: "Start date is in the past." });
  if (input.endDate && input.endDate < (input.startDate ?? today)) issues.push({ code: "end_before_start", severity: "error", field: "endDate", message: "End date is before the start." });
  if (input.platform === "meta" && !input.endDate) issues.push({ code: "no_end_date", severity: "warning", field: "endDate", message: "No end date: the campaign runs until someone pauses it." });

  return { passed: !issues.some((i) => i.severity === "error"), issues, checkedAt: new Date().toISOString() };
}
