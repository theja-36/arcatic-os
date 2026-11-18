import { z } from "zod";
import type { BrandKit } from "./kit.js";
import { applyKitOps, type KitOp, type OpContext } from "./ops.js";

export const GOALS = ["awareness", "leads", "sales", "footfall", "bookings", "retention", "launch", "community", "hiring"] as const;
export const TONES = ["friendly", "professional", "warm", "bold", "playful", "expert", "premium", "youthful", "calm", "inspiring", "witty", "traditional"] as const;
export const CHANNELS = ["instagram", "facebook", "linkedin", "x", "youtube", "tiktok", "threads", "pinterest", "gbp", "whatsapp", "email", "blog", "website"] as const;
export const MATURITY = ["starting", "occasional", "consistent", "advanced"] as const;

/** Answers from the onboarding wizard. Every field optional so the wizard can save per step. */
export const OnboardingAnswersSchema = z.object({
  businessName: z.string().trim().min(1).max(120).optional(),
  businessType: z.string().trim().max(120).optional(),
  industry: z.string().trim().max(120).optional(),
  description: z.string().trim().max(600).optional(),
  location: z.string().trim().max(200).optional(),
  website: z.string().trim().max(400).optional(),
  goals: z.array(z.enum(GOALS)).max(5).optional(),
  audience: z.object({ description: z.string().trim().max(1000), geography: z.string().max(200).optional() }).optional(),
  offers: z.array(z.object({ name: z.string().trim().min(1).max(160), kind: z.enum(["product", "service", "bundle", "subscription", "event", "other"]).default("service"), price: z.string().max(80).optional() })).max(20).optional(),
  competitors: z.array(z.object({ name: z.string().trim().min(1).max(120), url: z.string().max(400).optional() })).max(10).optional(),
  tone: z.array(z.enum(TONES)).max(5).optional(),
  bannedWords: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  languages: z.object({ primary: z.string().min(2).max(10), supported: z.array(z.string().min(2).max(10)).min(1) }).optional(),
  channels: z.array(z.enum(CHANNELS)).max(13).optional(),
  maturity: z.enum(MATURITY).optional(),
});
export type OnboardingAnswers = z.infer<typeof OnboardingAnswersSchema>;

const MATURITY_LABEL: Record<(typeof MATURITY)[number], string> = {
  starting: "Just starting with marketing",
  occasional: "Posts occasionally, no plan",
  consistent: "Posts consistently with a basic plan",
  advanced: "Runs planned multi-channel campaigns",
};

/** What the owner told us is approved by definition; it seeds the kit before website analysis. */
export function onboardingToOps(a: OnboardingAnswers): KitOp[] {
  const ops: KitOp[] = [];
  const set = (path: string, value: unknown) => {
    if (value === undefined || (Array.isArray(value) && value.length === 0) || value === "") return;
    ops.push({ op: "set", path, value });
  };
  if (a.businessName || a.languages) ops.push({ op: "set_meta", name: a.businessName, languages: a.languages });
  set("profile.businessType", a.businessType);
  set("profile.industry", a.industry);
  set("profile.location", a.location);
  set("oneLiner", a.description && a.description.length <= 200 ? a.description : undefined);
  set("marketing.goals", a.goals);
  set("marketing.channels", a.channels);
  set("marketing.maturity", a.maturity ? MATURITY_LABEL[a.maturity] : undefined);
  set("voice.tone", a.tone);
  set("vocabulary.banned", a.bannedWords);
  set("competitors", a.competitors?.map((c) => (c.url ? `${c.name} (${c.url})` : c.name)));
  if (a.audience?.description) {
    ops.push({ op: "add", list: "audiences", value: { name: a.audience.geography ? `Customers in ${a.audience.geography}` : "Primary customers", description: a.audience.description } });
  }
  for (const o of a.offers ?? []) ops.push({ op: "add", list: "offers", value: o });
  if (a.website) set("profile.contact", { website: a.website });
  return ops;
}

/** Re-seeding replaces list items that came from onboarding, so saving the wizard twice doesn't duplicate them. */
export function seedKitFromOnboarding(kit: BrandKit, answers: OnboardingAnswers, ctx: Omit<OpContext, "origin">) {
  const cleaned: BrandKit = {
    ...kit,
    audiences: kit.audiences.filter((f) => f.origin !== "onboarding"),
    offers: kit.offers.filter((f) => f.origin !== "onboarding"),
  };
  // a value someone edited in the Brand Kit (or an approved AI fact) wins over the wizard
  const ops = onboardingToOps(answers).filter((op) => {
    if (op.op !== "set") return true;
    const cur = kit.facts[op.path];
    return !cur || cur.origin === "onboarding" || cur.status !== "approved";
  });
  return applyKitOps(cleaned, ops, { ...ctx, origin: "onboarding" });
}
