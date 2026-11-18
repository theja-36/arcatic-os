import { estimateTokens } from "../brand/context.js";

export interface Chunk {
  ordinal: number;
  content: string;
  tokenCount: number;
  headingPath?: string[];
  pageUrl?: string;
  pageNumber?: number;
  startMs?: number;
  endMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  /** sentences carried into the next chunk for continuity */
  overlapSentences?: number;
}

const DEFAULTS: Required<ChunkOptions> = { targetTokens: 380, maxTokens: 600, overlapSentences: 1 };
const sentenceSeg = new Intl.Segmenter(undefined, { granularity: "sentence" });
const sentences = (t: string) => [...sentenceSeg.segment(t)].map((s) => s.segment.trim()).filter(Boolean);

/** Split one oversized paragraph by sentences, then by hard character windows as a last resort. */
function splitLong(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of sentences(text)) {
    if (estimateTokens(s) > maxTokens) {
      if (cur) out.push(cur), (cur = "");
      const width = maxTokens * 3;
      for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
      continue;
    }
    if (cur && estimateTokens(`${cur} ${s}`) > maxTokens) out.push(cur), (cur = s);
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Heading-aware Markdown chunker. Chunks never cross a heading; paragraphs are packed up to
 * `targetTokens`; each chunk records its heading path so retrieval can show where it came from.
 */
export function chunkMarkdown(md: string, opts: ChunkOptions & { pageUrl?: string } = {}): Chunk[] {
  const o = { ...DEFAULTS, ...opts };
  const chunks: Chunk[] = [];
  const path: string[] = [];
  let paras: string[] = [];

  const flush = () => {
    let cur: string[] = [];
    let carry = "";
    const emit = () => {
      const body = cur.join("\n\n").trim();
      if (!body) return;
      const content = carry ? `${carry} ${body}` : body;
      chunks.push({ ordinal: chunks.length, content, tokenCount: estimateTokens(content), headingPath: path.length ? [...path] : undefined, pageUrl: o.pageUrl });
      carry = o.overlapSentences > 0 ? sentences(body).slice(-o.overlapSentences).join(" ") : "";
      if (estimateTokens(carry) > o.targetTokens / 3) carry = "";
      cur = [];
    };
    for (const p of paras.flatMap((p) => (estimateTokens(p) > o.maxTokens ? splitLong(p, o.maxTokens) : [p]))) {
      if (cur.length && estimateTokens([...cur, p].join("\n\n")) > o.targetTokens) emit();
      cur.push(p);
    }
    emit();
    paras = [];
  };

  for (const block of md.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i]!.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!h) continue;
      // a heading ends the current section
      const before = lines.slice(0, i).join("\n").trim();
      if (before) paras.push(before);
      flush();
      const level = h[1]!.length;
      path.splice(level - 1);
      path[level - 1] = h[2]!.trim();
      for (let j = 0; j < path.length; j++) if (path[j] === undefined) path[j] = "";
      lines.splice(0, i + 1);
      i = -1;
    }
    const rest = lines.join("\n").trim();
    if (rest) paras.push(rest);
  }
  flush();
  return chunks.map((c) => (c.headingPath ? { ...c, headingPath: c.headingPath.filter(Boolean) } : c));
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/** Transcript chunks keep time ranges so search results can jump to the moment in the video. */
export function chunkTranscript(segments: readonly TranscriptSegment[], opts: ChunkOptions = {}): Chunk[] {
  const o = { ...DEFAULTS, ...opts };
  const out: Chunk[] = [];
  let cur: TranscriptSegment[] = [];
  const emit = () => {
    if (!cur.length) return;
    const content = cur.map((s) => s.text.trim()).filter(Boolean).join(" ");
    if (content) out.push({ ordinal: out.length, content, tokenCount: estimateTokens(content), startMs: cur[0]!.startMs, endMs: cur.at(-1)!.endMs });
    cur = [];
  };
  for (const s of segments) {
    if (cur.length && estimateTokens([...cur, s].map((x) => x.text).join(" ")) > o.targetTokens) emit();
    cur.push(s);
  }
  emit();
  return out;
}

/** Text used for the embedding: heading context helps short chunks retrieve well. */
export const embeddingText = (c: Pick<Chunk, "content" | "headingPath">, title?: string) =>
  [title, c.headingPath?.join(" › ")].filter(Boolean).join(" — ").concat(title || c.headingPath?.length ? "\n" : "", c.content);
