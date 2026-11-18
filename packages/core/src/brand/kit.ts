import { z } from "zod";

/**
 * Brand Kit document. Every value is a Fact with provenance and an approval state.
 * Singleton facts use their path as a stable id ("voice.tone"); list items use "<list>:<id>".
 * Only `approved` facts are compiled into prompts; AI never overwrites an approved fact —
 * it attaches a pending `suggestion` instead (see merge.ts).
 */
export const SourceSchema = z.object({
  kind: z.enum(["page", "chunk", "onboarding", "manual", "firecrawl_branding", "html"]).default("page"),
  url: z.string().optional(),
  sourceId: z.string().optional(),
  chunkId: z.string().optional(),
  quote: z.string().max(400).optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const FactStatus = z.enum(["suggested", "approved", "rejected"]);
export const FactOrigin = z.enum(["ai", "human", "onboarding", "import"]);

const suggestionOf = <T extends z.ZodType>(value: T) =>
  z.object({ value, confidence: z.number().min(0).max(1), sources: z.array(SourceSchema).default([]), at: z.string().optional() });

export const FactSchema = <T extends z.ZodType>(value: T) =>
  z.object({
    id: z.string(),
    value,
    status: FactStatus,
    origin: FactOrigin.default("human"),
    confidence: z.number().min(0).max(1).optional(),
    sources: z.array(SourceSchema).default([]),
    unverified: z.boolean().optional(),
    suggestion: suggestionOf(value).optional(),
    updatedAt: z.string().optional(),
  });
export type Fact<V> = {
  id: string;
  value: V;
  status: z.infer<typeof FactStatus>;
  origin: z.infer<typeof FactOrigin>;
  confidence?: number;
  sources: Source[];
  unverified?: boolean;
  suggestion?: { value: V; confidence: number; sources: Source[]; at?: string };
  updatedAt?: string;
};

const text = z.string().trim().min(1).max(2000);
const shortList = z.array(z.string().trim().min(1).max(300)).max(30);

export const AudienceValue = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  pains: z.array(z.string().max(300)).max(10).default([]),
  desires: z.array(z.string().max(300)).max(10).default([]),
  objections: z.array(z.string().max(300)).max(10).default([]),
});
export const OfferValue = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["product", "service", "bundle", "subscription", "event", "other"]).default("service"),
  description: z.string().max(1000).optional(),
  price: z.string().max(80).optional(),
  benefit: z.string().max(300).optional(),
});
export const ColorValue = z.array(
  z.object({ hex: z.string().regex(/^#[0-9a-f]{6}$/i), role: z.enum(["primary", "secondary", "accent", "background", "text", "other"]).default("other") }),
).max(12);
export const FontValue = z.array(z.object({ family: z.string().min(1).max(80), role: z.enum(["heading", "body", "accent", "other"]).default("other") })).max(6);
export const ContactValue = z.object({
  email: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  address: z.string().max(400).optional(),
  website: z.string().max(400).optional(),
});

/**
 * Every singleton path a kit supports, with its value schema. The API accepts only these
 * paths in `set` operations, so the kit can't grow arbitrary keys.
 */
export const SINGLETON_PATHS = {
  "profile.businessType": text,
  "profile.industry": text,
  "profile.location": text,
  "profile.serviceArea": text,
  "profile.contact": ContactValue,
  oneLiner: z.string().trim().min(1).max(200),
  mission: text,
  vision: text,
  positioning: text,
  differentiators: shortList,
  objections: shortList,
  proofPoints: shortList,
  competitors: shortList,
  "marketing.goals": shortList,
  "marketing.channels": shortList,
  "marketing.maturity": text,
  "voice.tone": shortList,
  "voice.personality": shortList,
  "voice.emotions": shortList,
  "voice.syntax": shortList,
  "voice.do": shortList,
  "voice.dont": shortList,
  "vocabulary.preferred": shortList,
  "vocabulary.banned": shortList,
  "visual.colors": ColorValue,
  "visual.fonts": FontValue,
  "visual.logoUrl": z.string().max(1000),
  "visual.logoAssetId": z.string().uuid(),
  "visual.imageryStyle": text,
  "visual.layoutRules": shortList,
  "compliance.disclaimers": shortList,
} as const;
export type SingletonPath = keyof typeof SINGLETON_PATHS;
export const CHANNEL_RULE_PREFIX = "channelRules.";
export const isSingletonPath = (p: string): p is SingletonPath => p in SINGLETON_PATHS;

export const LIST_SECTIONS = { audiences: AudienceValue, offers: OfferValue } as const;
export type ListSection = keyof typeof LIST_SECTIONS;
export const LIST_LIMITS: Record<ListSection, number> = { audiences: 8, offers: 30 };

/** Schema for the value at any fact path (singleton, channel rule, or list section). */
export function valueSchemaFor(path: string): z.ZodType | undefined {
  if (isSingletonPath(path)) return SINGLETON_PATHS[path];
  if (path.startsWith(CHANNEL_RULE_PREFIX)) return shortList;
  if (path in LIST_SECTIONS) return LIST_SECTIONS[path as ListSection];
  return undefined;
}

const anyFact = FactSchema(z.unknown());

export const BrandKitSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    brandId: z.string(),
    version: z.number().int().nonnegative().default(0),
    name: z.string().min(1),
    languages: z.object({ primary: z.string().default("en"), supported: z.array(z.string()).default(["en"]) }).default({ primary: "en", supported: ["en"] }),
    claimsPolicy: z.enum(["strict", "relaxed"]).default("relaxed"),
    /** singleton facts keyed by path */
    facts: z.record(z.string(), anyFact).default({}),
    audiences: z.array(anyFact).default([]),
    offers: z.array(anyFact).default([]),
  })
  .superRefine((kit, ctx) => {
    for (const [path, fact] of Object.entries(kit.facts)) {
      const schema = valueSchemaFor(path);
      if (!schema) ctx.addIssue({ code: "custom", path: ["facts", path], message: `Unknown fact path ${path}` });
      else if (fact.id !== path) ctx.addIssue({ code: "custom", path: ["facts", path], message: "Singleton fact id must equal its path" });
    }
  });
export type BrandKit = z.infer<typeof BrandKitSchema>;
export type AnyFact = Fact<unknown>;

export function emptyKit(brandId: string, name: string, languages: string[] = ["en"]): BrandKit {
  return BrandKitSchema.parse({
    brandId,
    name,
    languages: { primary: languages[0] ?? "en", supported: languages.length ? languages : ["en"] },
  });
}

/** Every fact in the kit with its path ("voice.tone", "audiences", ...). */
export function allFacts(kit: BrandKit): Array<{ path: string; fact: AnyFact }> {
  return [
    ...Object.entries(kit.facts).map(([path, fact]) => ({ path, fact: fact as AnyFact })),
    ...kit.audiences.map((fact) => ({ path: "audiences", fact: fact as AnyFact })),
    ...kit.offers.map((fact) => ({ path: "offers", fact: fact as AnyFact })),
  ];
}

export const approvedValue = <V>(kit: BrandKit, path: string): V | undefined => {
  const f = kit.facts[path];
  return f && f.status === "approved" ? (f.value as V) : undefined;
};
