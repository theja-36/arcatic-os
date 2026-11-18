import { estimateTokens } from "../brand/context.js";
import type { Chunk } from "./chunk.js";

/** RFC 4180 parser (quotes, escaped quotes, CRLF, embedded newlines). Auto-detects , ; or tab. */
export function parseCsv(text: string, maxRows = 5000): { header: string[]; rows: string[][]; truncated: boolean } {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.indexOf("\n") >= 0 ? src.indexOf("\n") : src.length);
  const delim = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"' && src[i + 1] === '"') field += '"', i++;
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"' && field === "") q = true;
    else if (ch === delim) row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field), (field = "");
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) break;   // header + maxRows + one extra to detect truncation
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  const [header = [], ...body] = rows;
  return { header: header.map((h, i) => h.trim() || `column_${i + 1}`), rows: body.slice(0, maxRows), truncated: body.length > maxRows };
}

/** Each row becomes "Column: value; …" so every chunk is self-describing; rows packed to the target size. */
export function chunkCsv(header: readonly string[], rows: readonly string[][], targetTokens = 380): Chunk[] {
  const lines = rows.map((r, idx) => ({ idx, text: header.map((h, i) => (r[i]?.trim() ? `${h}: ${r[i]!.trim()}` : "")).filter(Boolean).join("; ") })).filter((l) => l.text);
  const out: Chunk[] = [];
  let cur: typeof lines = [];
  const emit = () => {
    if (!cur.length) return;
    const content = cur.map((l) => l.text).join("\n");
    out.push({ ordinal: out.length, content, tokenCount: estimateTokens(content), metadata: { rowStart: cur[0]!.idx + 1, rowEnd: cur.at(-1)!.idx + 1 } });
    cur = [];
  };
  for (const l of lines) {
    if (cur.length && estimateTokens([...cur, l].map((x) => x.text).join("\n")) > targetTokens) emit();
    cur.push(l);
  }
  emit();
  return out;
}

/** Markdown rendering for storage/preview (first rows only). */
export function csvToMarkdown(header: readonly string[], rows: readonly string[][], maxRows = 200): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${header.map(esc).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.slice(0, maxRows).map((r) => `| ${header.map((_, i) => esc(r[i] ?? "")).join(" | ")} |`)].join("\n");
}
