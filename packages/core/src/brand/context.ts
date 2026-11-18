import { BrandKitSchema, type BrandKit } from "./kit.js";
import { sha256Hex, stableStringify } from "./util.js";

/**
 * Compact, versioned Brand Context injected into every generation. Built from approved facts
 * only, capped to a token budget so it stays cheap and prompt-cacheable.
 */
export interface BrandContext {
  brandId: string;
  version: number;
  hash: string;
  /** Fact ids used — stored on content_versions.depends_on_facts for selective regeneration */
  factIds: string[];
  tokenEstimate: number;
  data: {
    name: string;
    businessType?: string;
    location?: string;
    oneLiner?: string;
    positioning?: string;
    mission?: string;
    audiences: Array<{ name: string; description?: string; pains: string[]; desires: string[]; objections: string[] }>;
    offers: Array<{ name: string; kind: string; price?: string; benefit?: string }>;
    differentiators: string[];
    proofPoints: string[];
    objections: string[];
    voice: { tone: string[]; personality: string[]; emotions: string[]; syntax: string[]; do: string[]; dont: string[] };
    vocabulary: { preferred: string[]; banned: string[] };
    visual: { colors: Array<{ hex: string; role: string }>; fonts: Array<{ family: string; role: string }>; imageryStyle?: string; layoutRules: string[] };
    channelRules: Record<string, string[]>;
    languages: { primary: string; supported: string[] };
    compliance: { disclaimers: string[]; claimsPolicy: "strict" | "relaxed" };
  };
}

export const CONTEXT_TOKEN_BUDGET = 1500;

/** Conservative estimate: ~3 chars/token handles mixed English/Telugu (Telugu tokenises denser). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3);

interface Caps {
  audiences: number;
  offers: number;
  list: number;
  /** max chars for a paragraph-like field */
  text: number;
  /** max chars for one list item */
  item: number;
  includeMission: boolean;
}
const CAP_STEPS: Caps[] = [
  { audiences: 3, offers: 6, list: 8, text: 400, item: 160, includeMission: true },
  { audiences: 3, offers: 5, list: 6, text: 300, item: 120, includeMission: true },
  { audiences: 2, offers: 4, list: 5, text: 240, item: 100, includeMission: false },
  { audiences: 2, offers: 3, list: 4, text: 180, item: 80, includeMission: false },
  { audiences: 1, offers: 2, list: 3, text: 120, item: 50, includeMission: false },
];

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

export async function compileBrandContext(kitInput: unknown, opts: { channel?: string; budget?: number } = {}): Promise<BrandContext> {
  const kit: BrandKit = BrandKitSchema.parse(kitInput);
  const budget = opts.budget ?? CONTEXT_TOKEN_BUDGET;

  let built = build(kit, CAP_STEPS[0]!, opts.channel);
  for (const caps of CAP_STEPS.slice(1)) {
    if (estimateTokens(stableStringify(built.data)) <= budget) break;
    built = build(kit, caps, opts.channel);
  }
  const json = stableStringify(built.data);
  const hash = await sha256Hex(stableStringify({ v: kit.version, data: built.data }));
  return { brandId: kit.brandId, version: kit.version, hash, factIds: [...built.ids].sort(), tokenEstimate: estimateTokens(json), data: built.data };
}

function build(kit: BrandKit, caps: Caps, channel?: string) {
  const ids = new Set<string>();
  const get = <V>(path: string): V | undefined => {
    const f = kit.facts[path];
    if (!f || f.status !== "approved") return undefined;
    ids.add(path);
    return f.value as V;
  };
  const txt = (path: string) => {
    const v = get<string>(path);
    return v === undefined ? undefined : clip(v, caps.text);
  };
  const items = (arr: readonly string[] | undefined, n = caps.list) => (arr ?? []).slice(0, n).map((x) => clip(x, caps.item));
  const list = (path: string, n = caps.list) => items(get<string[]>(path), n);
  const approvedItems = <V>(arr: Array<{ id: string; status: string; value: unknown }>, n: number) =>
    arr.filter((f) => f.status === "approved").slice(0, n).map((f) => {
      ids.add(f.id);
      return f.value as V;
    });

  const channelRules: Record<string, string[]> = {};
  for (const [path, f] of Object.entries(kit.facts)) {
    if (!path.startsWith("channelRules.") || f.status !== "approved") continue;
    const ch = path.slice("channelRules.".length);
    if (channel && ch !== channel) continue;
    channelRules[ch] = items(f.value as string[]);
    ids.add(path);
  }

  type A = BrandContext["data"]["audiences"][number];
  type O = { name: string; kind: string; price?: string; benefit?: string; description?: string };
  const data: BrandContext["data"] = {
    name: kit.name,
    businessType: txt("profile.businessType"),
    location: txt("profile.location"),
    oneLiner: txt("oneLiner"),
    positioning: txt("positioning"),
    mission: caps.includeMission ? txt("mission") : undefined,
    audiences: approvedItems<A>(kit.audiences, caps.audiences).map((a) => ({
      name: a.name,
      description: a.description === undefined ? undefined : clip(a.description, caps.text),
      pains: items(a.pains, 3),
      desires: items(a.desires, 3),
      objections: items(a.objections, 3),
    })),
    offers: approvedItems<O>(kit.offers, caps.offers).map(({ name, kind, price, benefit }) => ({
      name: clip(name, caps.item), kind, price, benefit: benefit === undefined ? undefined : clip(benefit, caps.item),
    })),
    differentiators: list("differentiators"),
    proofPoints: list("proofPoints", Math.min(caps.list, 5)),
    objections: list("objections", Math.min(caps.list, 5)),
    voice: { tone: list("voice.tone"), personality: list("voice.personality"), emotions: list("voice.emotions"), syntax: list("voice.syntax"), do: list("voice.do"), dont: list("voice.dont") },
    // banned words are never truncated: they also drive deterministic validation
    vocabulary: { preferred: list("vocabulary.preferred"), banned: get<string[]>("vocabulary.banned") ?? [] },
    visual: {
      colors: get<Array<{ hex: string; role: string }>>("visual.colors") ?? [],
      fonts: get<Array<{ family: string; role: string }>>("visual.fonts") ?? [],
      imageryStyle: txt("visual.imageryStyle"),
      layoutRules: list("visual.layoutRules"),
    },
    channelRules,
    languages: kit.languages,
    compliance: { disclaimers: get<string[]>("compliance.disclaimers") ?? [], claimsPolicy: kit.claimsPolicy },
  };
  return { data, ids };
}

/** Content whose generation depended on any changed fact must be offered for regeneration. */
export function isAffectedByFactChange(dependsOn: readonly string[], changedFactIds: readonly string[]): boolean {
  const changed = new Set(changedFactIds);
  return dependsOn.some((id) => changed.has(id));
}
