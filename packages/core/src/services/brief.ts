import type { BrandContext } from "../brand/context.js";
import type { IntakeField } from "./intake.js";

/**
 * The brief a specialist works from. Assembled deterministically at submission and frozen on the
 * request, so the service team never needs access to the customer's workspace: brand essentials,
 * the answers, the source draft (for "finish my draft") and acceptance criteria.
 */
export interface ServiceBrief {
  offering: { key: string; name: string; deliverable: string };
  title: string;
  requirements: Array<{ label: string; value: string }>;
  brand: {
    name: string; oneLiner?: string; positioning?: string; audiences: string[]; offers: string[];
    voice: { tone: string[]; do: string[]; dont: string[] }; bannedWords: string[]; preferredWords: string[];
    language: string; colors: string[]; fonts: string[]; disclaimers: string[]; claimsPolicy: string;
  };
  source?: { title: string | null; type: string; text: string };
  references: Array<{ name: string; kind: string }>;
  acceptanceCriteria: string[];
  dueAt: string;
}

const DELIVERABLE: Record<string, string> = { content: "Finished text in the editor", files: "Export-ready files", content_and_files: "Finished text plus files" };

export function buildServiceBrief(a: {
  offering: { key: string; name: string; deliverable_kind: string; deliverable_type: string | null; category: string };
  fields: readonly IntakeField[]; values: Record<string, string>; title: string;
  brand: BrandContext["data"]; source?: { title: string | null; type: string; text: string } | null;
  references?: Array<{ name: string; kind: string }>; dueAt: Date;
}): ServiceBrief {
  const b = a.brand;
  const criteria = [
    `Sounds like ${b.name}: ${[...b.voice.tone, ...b.voice.personality].slice(0, 4).join(", ") || "follow the voice notes"}.`,
    b.vocabulary.banned.length ? `None of these words: ${b.vocabulary.banned.slice(0, 20).join(", ")}.` : "",
    b.compliance.claimsPolicy === "strict" ? "Every factual claim (numbers, rankings, results) is backed by the brand kit, the source draft or a cited link." : "No claims that can't be backed up.",
    b.compliance.disclaimers.length ? `Includes required disclaimers where relevant: ${b.compliance.disclaimers.join("; ")}.` : "",
    a.offering.category === "writing" ? `Written in ${b.languages.primary}; proofread; no placeholder text.` : "",
    a.offering.category === "design" || a.offering.category === "video" ? `Uses brand colours (${b.visual.colors.map((c) => c.hex).join(", ") || "from the kit"}) and fonts; files named clearly.` : "",
    a.offering.key === "polish_draft" ? "Keeps the draft's meaning and facts; explains any fact that was removed or changed." : "",
    a.offering.category === "ads" ? "Flags anything likely to break Google or Meta ad policies, with a suggested fix." : "",
  ].filter(Boolean);
  return {
    offering: { key: a.offering.key, name: a.offering.name, deliverable: DELIVERABLE[a.offering.deliverable_kind] ?? a.offering.deliverable_kind },
    title: a.title,
    requirements: a.fields.filter((f) => a.values[f.key]).map((f) => ({ label: f.label, value: a.values[f.key]! })),
    brand: {
      name: b.name, oneLiner: b.oneLiner, positioning: b.positioning,
      audiences: b.audiences.slice(0, 3).map((x) => (x.description ? `${x.name}: ${x.description}` : x.name)),
      offers: b.offers.slice(0, 6).map((o) => [o.name, o.price, o.benefit].filter(Boolean).join(" — ")),
      voice: { tone: b.voice.tone, do: b.voice.do.slice(0, 8), dont: b.voice.dont.slice(0, 8) },
      bannedWords: b.vocabulary.banned.slice(0, 40), preferredWords: b.vocabulary.preferred.slice(0, 40),
      language: b.languages.primary, colors: b.visual.colors.map((c) => `${c.hex} (${c.role})`), fonts: b.visual.fonts.map((f) => `${f.family} (${f.role})`),
      disclaimers: b.compliance.disclaimers, claimsPolicy: b.compliance.claimsPolicy,
    },
    ...(a.source && { source: { ...a.source, text: a.source.text.slice(0, 20_000) } }),
    references: a.references ?? [],
    acceptanceCriteria: criteria,
    dueAt: a.dueAt.toISOString(),
  };
}
