/**
 * Deterministic text cleaning before chunking. Conservative: removes things that are never
 * useful as knowledge (images, nav link lists, cookie banners), never rewrites sentences.
 */
const IMAGE_MD = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_ONLY_LINE = /^\s*(?:[-*•|]\s*)?(?:\[[^\]]{0,80}\]\([^)]*\)\s*[|·•,-]?\s*)+$/;
const COOKIE_LINE = /\b(cookies?|consent)\b.*\b(accept|agree|preferences|settings|reject)\b|\b(accept|reject) (all )?cookies\b/i;
const SKIP_LINE = /^\s*(skip to (main )?content|toggle navigation|menu|close|search|back to top|share this|©.*all rights reserved.*)\s*$/i;

export function cleanMarkdown(md: string): string {
  const out: string[] = [];
  for (const raw of md.replace(/\r\n?/g, "\n").replace(IMAGE_MD, "").split("\n")) {
    const line = raw.replace(/[ \t]+$/g, "").replace(/ /g, " ");
    if (LINK_ONLY_LINE.test(line) || COOKIE_LINE.test(line) || SKIP_LINE.test(line)) continue;
    // keep link text, drop URLs: "[About us](https://…)" → "About us"
    out.push(line.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1"));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Lines that repeat across most pages of one crawl (headers, footers, menus) are boilerplate.
 * Needs at least 3 pages; a line is dropped if it appears on ≥60% of them.
 */
export function removeCrossPageBoilerplate(pages: readonly string[], threshold = 0.6): string[] {
  if (pages.length < 3) return [...pages];
  const counts = new Map<string, number>();
  for (const p of pages) {
    for (const l of new Set(p.split("\n").map((x) => x.trim()).filter((x) => x.length > 2))) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const min = Math.ceil(pages.length * threshold);
  const boiler = new Set([...counts].filter(([, n]) => n >= min).map(([l]) => l));
  return pages.map((p) => p.split("\n").filter((l) => !boiler.has(l.trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim());
}
