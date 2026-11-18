import type { BlockKind, ContentDoc } from "../content/doc.js";
import { docText } from "../content/doc.js";

/** Blocks that make up the public text of a social post (in document order). */
const SOCIAL_KINDS: readonly BlockKind[] = [
  "hook", "headline", "body", "caption", "primary_text", "paragraph", "list_item", "quote", "description", "chapter", "cta", "hashtags", "link_description",
];

export interface PostText {
  text: string;
  /** X / Threads: one entry per post in the thread (first = main post) */
  thread?: string[];
  /** title-like block, used as a default for YouTube / WordPress / TikTok titles */
  title?: string;
}

const first = (doc: ContentDoc, ...kinds: BlockKind[]) => doc.blocks.find((b) => kinds.includes(b.kind))?.text.trim() || undefined;

export function postText(type: string, doc: ContentDoc): PostText {
  const title = first(doc, "title", "headline", "subject");
  if (type === "x_thread") {
    const thread = doc.blocks.filter((b) => b.kind === "tweet").map((b) => unMarkdown(b.text.trim())).filter(Boolean);
    return { text: thread[0] ?? "", thread, title };
  }
  return { text: unMarkdown(docText(doc, SOCIAL_KINDS)), title };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MD_LINK = /\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
const bare = (s: string) => esc(s).replace(/\bhttps?:\/\/[^\s<>"')]+/g, (u) => `<a href="${u}">${u}</a>`);
/** Escapes text; renders markdown links `[anchor](https://…)` (e.g. accepted internal links) and bare URLs. */
const linkify = (s: string) => {
  let out = "", last = 0;
  for (const m of s.matchAll(MD_LINK)) {
    out += bare(s.slice(last, m.index)) + `<a href="${esc(m[2]!)}">${esc(m[1]!)}</a>`;
    last = m.index! + m[0].length;
  }
  return out + bare(s.slice(last));
};
/** Social networks don't render markdown: "[anchor](url)" becomes "anchor (url)". */
const unMarkdown = (s: string) => s.replace(MD_LINK, "$1 ($2)");
const para = (s: string) => s.split(/\n{2,}/).map((p) => `<p>${linkify(p).replace(/\n/g, "<br>")}</p>`).join("\n");

/** Article / email body as simple, safe HTML (all text escaped). Title and meta blocks are left out. */
export function docToHtml(doc: ContentDoc): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { out.push(`<ul>\n${list.join("\n")}\n</ul>`); list = []; } };
  for (const b of doc.blocks) {
    const t = b.text.trim();
    if (!t) continue;
    if (b.kind === "list_item") { list.push(`<li>${linkify(t)}</li>`); continue; }
    flush();
    switch (b.kind) {
      case "title": case "subject": case "preheader": case "meta_description": case "alt_text": case "image_prompt": case "hashtags": break;
      case "heading": out.push(`<h2>${esc(t)}</h2>`); break;
      case "subhead": out.push(`<h3>${esc(t)}</h3>`); break;
      case "quote": out.push(`<blockquote>${linkify(t)}</blockquote>`); break;
      case "cta": out.push(`<p><strong>${linkify(t)}</strong></p>`); break;
      default: out.push(para(t));
    }
  }
  flush();
  return out.join("\n");
}

export function blogParts(doc: ContentDoc) {
  return { title: first(doc, "title", "headline") ?? "", html: docToHtml(doc), excerpt: first(doc, "meta_description") };
}

export function emailParts(doc: ContentDoc) {
  const html = docToHtml(doc);
  return {
    subject: first(doc, "subject", "title") ?? "",
    preheader: first(doc, "preheader"),
    html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;max-width:640px;margin:0 auto;padding:16px">\n${html}\n<p style="font-size:12px;color:#666">{unsubscribe_text}</p>\n</body></html>`,
    plainText: unMarkdown(docText(doc, ["heading", "subhead", "paragraph", "body", "list_item", "quote", "cta"])),
  };
}
