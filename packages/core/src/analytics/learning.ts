import type { InsightDraft } from "./insights.js";

/**
 * Edit learning: what people consistently change between the AI draft and the version they
 * approve. Produces Brand Kit change proposals (voice_refinement) with their evidence; a person
 * accepts one, it becomes a Brand Kit draft, and only an approved kit reaches generation.
 */
export interface EditPair {
  contentItemId: string;
  channel: string | null;
  aiText: string;
  finalText: string;
  editClasses: string[];
}

const STOP = new Set(("the a an and or but for to of in on at by with from as is are was were be been it its this that these those our your you we they he she them his her their " +
  "will can just more most very so not no yes all any each into out up about than then there here what when where who how why also get got").split(" "));
const tokens = (t: string) => new Set((t.toLowerCase().match(/[\p{L}\p{M}][\p{L}\p{M}\p{N}'’-]{2,}/gu) ?? []).filter((w) => !STOP.has(w)));
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export interface EditStats {
  pairs: number;
  edited: number;
  editedShare: number;
  medianLengthRatio: number | null;
  classes: Record<string, number>;
  removed: Array<{ word: string; pairs: number; rate: number }>;
  added: Array<{ word: string; pairs: number }>;
}

export function analyzeEdits(pairs: EditPair[], existing: { banned?: string[]; preferred?: string[] } = {}): { stats: EditStats; proposals: InsightDraft[] } {
  const edited = pairs.filter((p) => p.aiText.trim() !== p.finalText.trim());
  const classes: Record<string, number> = {};
  for (const p of edited) for (const c of p.editClasses) classes[c] = (classes[c] ?? 0) + 1;
  const ratios = edited.filter((p) => p.aiText.length > 0).map((p) => p.finalText.length / p.aiText.length);

  const appeared = new Map<string, number>(), removed = new Map<string, Set<string>>(), added = new Map<string, Set<string>>();
  for (const p of edited) {
    const a = tokens(p.aiText), f = tokens(p.finalText);
    for (const w of a) { appeared.set(w, (appeared.get(w) ?? 0) + 1); if (!f.has(w)) removed.set(w, (removed.get(w) ?? new Set()).add(p.contentItemId)); }
    for (const w of f) if (!a.has(w)) added.set(w, (added.get(w) ?? new Set()).add(p.contentItemId));
  }
  const banned = new Set((existing.banned ?? []).map((w) => w.toLowerCase()));
  const preferred = new Set((existing.preferred ?? []).map((w) => w.toLowerCase()));
  const removedList = [...removed.entries()].map(([word, s]) => ({ word, pairs: s.size, rate: s.size / (appeared.get(word) ?? s.size) }))
    .filter((x) => x.pairs >= 3 && x.rate >= 0.6 && !banned.has(x.word) && !added.has(x.word)).sort((a, b) => b.pairs - a.pairs).slice(0, 10);
  const addedList = [...added.entries()].map(([word, s]) => ({ word, pairs: s.size })).filter((x) => x.pairs >= 3 && !preferred.has(x.word) && !removed.has(x.word))
    .sort((a, b) => b.pairs - a.pairs).slice(0, 10);

  const stats: EditStats = {
    pairs: pairs.length, edited: edited.length, editedShare: pairs.length ? edited.length / pairs.length : 0,
    medianLengthRatio: ratios.length ? median(ratios) : null, classes, removed: removedList, added: addedList,
  };

  const proposals: InsightDraft[] = [];
  const shortened = ratios.filter((r) => r <= 0.85).length;
  if (ratios.length >= 5 && stats.medianLengthRatio !== null && stats.medianLengthRatio <= 0.85 && shortened / ratios.length >= 0.6) {
    const cut = Math.round((1 - stats.medianLengthRatio) * 100);
    proposals.push({
      kind: "voice_refinement", fingerprint: "voice:shorter", title: `Your team shortens AI drafts by about ${cut}%`,
      body: `In ${shortened} of ${ratios.length} edited drafts the approved text was at least 15% shorter (median ${cut}% shorter).`,
      confidence: Math.min(0.9, 0.4 + 0.04 * ratios.length), evidence: { pairs: ratios.length, shortened, medianLengthRatio: stats.medianLengthRatio },
      guidance: `Write about ${cut}% shorter than you otherwise would; the team consistently trims drafts.`,
    });
  }
  if (removedList.length) {
    proposals.push({
      kind: "voice_refinement", fingerprint: `voice:avoid:${removedList.map((x) => x.word).sort().join(",")}`, title: `Words your team keeps removing: ${removedList.slice(0, 5).map((x) => x.word).join(", ")}`,
      body: removedList.map((x) => `“${x.word}” removed in ${x.pairs} drafts (${Math.round(x.rate * 100)}% of the drafts it appeared in)`).join("; ") + ".",
      confidence: Math.min(0.85, 0.4 + 0.05 * removedList[0]!.pairs), evidence: { removed: removedList, ops: { addBanned: removedList.map((x) => x.word) } },
    });
  }
  if (addedList.length) {
    proposals.push({
      kind: "voice_refinement", fingerprint: `voice:prefer:${addedList.map((x) => x.word).sort().join(",")}`, title: `Words your team keeps adding: ${addedList.slice(0, 5).map((x) => x.word).join(", ")}`,
      body: addedList.map((x) => `“${x.word}” added in ${x.pairs} drafts`).join("; ") + ".",
      confidence: Math.min(0.8, 0.35 + 0.05 * addedList[0]!.pairs), evidence: { added: addedList, ops: { addPreferred: addedList.map((x) => x.word) } },
    });
  }
  return { stats, proposals };
}

/** Per prompt template × model: how humans and audiences received its output. */
export interface QualityRow {
  template: string;
  model: string;
  firstPassApproved: boolean | null;   // null = never reviewed
  edited: boolean;
  regenerations: number;
  rejected: boolean;
  engagementScore: number | null;      // robust z vs channel (engagement_outcome)
}
export interface QualitySummary {
  template: string; model: string; items: number; reviewed: number;
  firstPassApprovalRate: number | null; editRate: number; rejectRate: number | null; avgRegenerations: number; avgEngagementScore: number | null; published: number;
}

export function summarizeQuality(rows: QualityRow[]): QualitySummary[] {
  const groups = new Map<string, QualityRow[]>();
  for (const r of rows) groups.set(`${r.template}\u0000${r.model}`, [...(groups.get(`${r.template}\u0000${r.model}`) ?? []), r]);
  return [...groups.entries()].map(([k, g]) => {
    const [template, model] = k.split("\u0000") as [string, string];
    const reviewed = g.filter((r) => r.firstPassApproved !== null);
    const eng = g.map((r) => r.engagementScore).filter((x): x is number => x !== null);
    return {
      template, model, items: g.length, reviewed: reviewed.length,
      firstPassApprovalRate: reviewed.length ? reviewed.filter((r) => r.firstPassApproved).length / reviewed.length : null,
      editRate: g.filter((r) => r.edited).length / g.length,
      rejectRate: reviewed.length ? g.filter((r) => r.rejected).length / reviewed.length : null,
      avgRegenerations: g.reduce((s, r) => s + r.regenerations, 0) / g.length,
      avgEngagementScore: eng.length ? eng.reduce((s, x) => s + x, 0) / eng.length : null,
      published: eng.length,
    };
  }).sort((a, b) => b.items - a.items);
}

/** The accepted learnings for a generation, as one short block for the prompt. */
export function learningsBlock(accepted: Array<{ id: string; guidance: string | null; applies_to: { channel?: string; contentType?: string } | null }>, ctx: { channel?: string | null; contentType: string }) {
  const used = accepted.filter((i) => i.guidance && (!i.applies_to?.channel || i.applies_to.channel === ctx.channel) && (!i.applies_to?.contentType || i.applies_to.contentType === ctx.contentType)).slice(0, 8);
  if (!used.length) return { text: "", ids: [] as string[] };
  return { text: `What has worked for this brand (approved by the team):\n${used.map((i) => `- ${i.guidance}`).join("\n")}`, ids: used.map((i) => i.id) };
}
