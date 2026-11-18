/**
 * File type detection from magic bytes (never trust the extension or the browser's MIME alone).
 */
export type FileKind = "pdf" | "docx" | "pptx" | "xlsx" | "html" | "markdown" | "text" | "csv" | "png" | "jpeg" | "gif" | "webp" | "svg" | "audio" | "video" | "unknown";

export const KNOWLEDGE_DOC_KINDS: ReadonlySet<FileKind> = new Set(["pdf", "docx", "pptx", "xlsx", "html", "markdown", "text", "csv"]);
export const DOCLING_KINDS: ReadonlySet<FileKind> = new Set(["pdf", "docx", "pptx", "xlsx", "html"]);
export const IMAGE_KINDS: ReadonlySet<FileKind> = new Set(["png", "jpeg", "gif", "webp"]);
export const MEDIA_KINDS: ReadonlySet<FileKind> = new Set(["audio", "video"]);

const ascii = (b: Uint8Array, start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));
const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";

function looksLikeUtf8Text(b: Uint8Array): boolean {
  const sample = b.subarray(0, 4096);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.length === b.length ? sample : trimPartialUtf8(sample));
    return true;
  } catch {
    return false;
  }
}
function trimPartialUtf8(b: Uint8Array): Uint8Array {
  let end = b.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const c = b[end - i]!;
    if ((c & 0xc0) === 0xc0) return b.subarray(0, end - i);   // lead byte of a cut sequence
    if ((c & 0xc0) !== 0x80) break;
  }
  return b;
}

export function sniffFile(bytes: Uint8Array, filename: string): { kind: FileKind; mime: string } {
  const b = bytes;
  const e = ext(filename);
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    const head = ascii(b, 0, Math.min(b.length, 2000));
    if (e === "docx" || head.includes("word/")) return { kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    if (e === "pptx" || head.includes("ppt/")) return { kind: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
    if (e === "xlsx" || head.includes("xl/")) return { kind: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    return { kind: "unknown", mime: "application/zip" };
  }
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { kind: "png", mime: "image/png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "jpeg", mime: "image/jpeg" };
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return { kind: "gif", mime: "image/gif" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return { kind: "webp", mime: "image/webp" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return { kind: "audio", mime: "audio/wav" };
  if (b.length >= 4 && ascii(b, 0, 4) === "OggS") return { kind: "audio", mime: "audio/ogg" };
  if (b.length >= 4 && ascii(b, 0, 4) === "fLaC") return { kind: "audio", mime: "audio/flac" };
  if (b.length >= 3 && (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0))) return { kind: "audio", mime: "audio/mpeg" };
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    return /^(M4A |M4B |mp42?$)/.test(brand) && ["m4a", "aac"].includes(e) ? { kind: "audio", mime: "audio/mp4" } : { kind: "video", mime: brand.startsWith("qt") ? "video/quicktime" : "video/mp4" };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: e === "weba" ? "audio" : "video", mime: e === "weba" ? "audio/webm" : "video/webm" };
  if (looksLikeUtf8Text(b)) {
    const head = new TextDecoder().decode(b.subarray(0, 1024)).trimStart().toLowerCase();
    if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { kind: "svg", mime: "image/svg+xml" };
    if (head.startsWith("<!doctype html") || head.startsWith("<html") || (e === "html" || e === "htm")) return { kind: "html", mime: "text/html" };
    if (e === "csv" || e === "tsv") return { kind: "csv", mime: "text/csv" };
    if (e === "md" || e === "markdown") return { kind: "markdown", mime: "text/markdown" };
    return { kind: "text", mime: "text/plain" };
  }
  return { kind: "unknown", mime: "application/octet-stream" };
}

/** Width/height from image headers (PNG, JPEG, GIF, WebP) without decoding pixels. */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 12, 4) === "IHDR") return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b.length >= 10 && ascii(b, 0, 3) === "GIF") return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const fmt = ascii(b, 12, 4);
    if (fmt === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (fmt === "VP8L") {
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fmt === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
      i += 2 + len;
    }
  }
  return undefined;
}
