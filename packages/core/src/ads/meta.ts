import type { AdAudience, MetaCreative } from "./schemas.js";
import type { AdIssue } from "./google.js";

/** Meta's recommended lengths (text beyond these is truncated in many placements). */
export const META_RECOMMENDED = { primaryText: 125, headline: 40, description: 30 } as const;

export const META_OBJECTIVE_MAP = {
  traffic: { objective: "OUTCOME_TRAFFIC", optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS" },
  awareness: { objective: "OUTCOME_AWARENESS", optimizationGoal: "REACH", billingEvent: "IMPRESSIONS" },
} as const;

export function checkMetaCreative(c: MetaCreative, opts: { hasImage: boolean }): AdIssue[] {
  const out: AdIssue[] = [];
  if (!c.primaryText.trim()) out.push({ code: "meta_primary_text", severity: "error", field: "primaryText", message: "Primary text is required." });
  if (!c.headline.trim()) out.push({ code: "meta_headline", severity: "error", field: "headline", message: "Headline is required." });
  if (!opts.hasImage) out.push({ code: "meta_image", severity: "error", field: "mediaAssetId", message: "Pick an image from the media library." });
  if ([...c.primaryText].length > META_RECOMMENDED.primaryText) out.push({ code: "meta_primary_long", severity: "warning", field: "primaryText", message: `Primary text over ${META_RECOMMENDED.primaryText} characters is cut off behind "See more" in most placements.` });
  if ([...c.headline].length > META_RECOMMENDED.headline) out.push({ code: "meta_headline_long", severity: "warning", field: "headline", message: `Headlines over ${META_RECOMMENDED.headline} characters are often truncated.` });
  if (c.description && [...c.description].length > META_RECOMMENDED.description) out.push({ code: "meta_description_long", severity: "warning", field: "description", message: `Descriptions over ${META_RECOMMENDED.description} characters are often truncated.` });
  return out;
}

/**
 * Meta advertising standards: ads must not assert or imply personal attributes (race, religion,
 * health, sexual orientation, financial status, criminal record…), e.g. "Struggling with your
 * debt?" or "Meet other Christian singles". We flag second-person text near sensitive terms.
 */
const SENSITIVE = /\b(depress\w*|anxiety|diabet\w*|cancer|hiv|disab\w*|obes\w*|overweight|fat|addict\w*|pregnan\w*|infertil\w*|gay|lesbian|bisexual|transgender|christian|muslim|hindu|jewish|sikh|religion|caste|race|ethnic\w*|debt|bankrupt\w*|broke|poor|unemployed|criminal record|arrest\w*|divorc\w*|single(s)?\b)/i;
const SECOND_PERSON = /\b(you|your|you're|yourself)\b/i;

export function personalAttributeRisk(text: string): string | null {
  for (const s of text.split(/(?<=[.!?])\s+/)) if (SECOND_PERSON.test(s) && SENSITIVE.test(s)) return s.trim();
  return null;
}

/** Special ad category rules: age 18–65 and all genders (Meta limits targeting for these categories). */
export function checkSpecialCategory(categories: readonly string[], a: AdAudience): AdIssue[] {
  if (!categories.length) return [];
  const out: AdIssue[] = [];
  if (a.ageMin !== 18 || a.ageMax !== 65) out.push({ code: "special_age", severity: "error", field: "audience.age", message: "Special ad categories can't target by age: use 18–65." });
  if (a.genders.length) out.push({ code: "special_gender", severity: "error", field: "audience.genders", message: "Special ad categories can't target by gender." });
  if (a.interests.length) out.push({ code: "special_interests", severity: "warning", field: "audience.interests", message: "Meta restricts detailed targeting for special ad categories; some interests may be rejected." });
  return out;
}

const CATEGORY_HINTS: Array<[string, RegExp]> = [
  ["HOUSING", /\b(rent|rental|apartment|flat|real estate|property|home loan|mortgage|for lease|bhk)\b/i],
  ["EMPLOYMENT", /\b(hiring|we're hiring|job opening|vacanc\w+|apply now for|career opportunit\w+|recruit\w*)\b/i],
  ["CREDIT", /\b(loan|credit card|credit line|emi|financing|borrow)\b/i],
  ["ONLINE_GAMBLING_AND_GAMING", /\b(casino|betting|bet now|poker|rummy|fantasy (cricket|sports)|jackpot)\b/i],
];
export const suggestSpecialCategories = (text: string) => CATEGORY_HINTS.filter(([, re]) => re.test(text)).map(([k]) => k);
export const POLITICAL = /\b(vote|election|candidate|political party|mla|mp candidate|campaign for|referendum|ballot)\b/i;
