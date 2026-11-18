/**
 * Pick which pages of a site to analyse. Deterministic: same link list → same selection.
 */
export const PAGE_TYPES = ["home", "about", "services", "products", "pricing", "testimonials", "faq", "contact", "blog"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

const RULES: Array<[PageType, RegExp]> = [
  ["about", /(^|[/-])(about|about-us|our-story|story|who-we-are|company|team|mission)([/-]|$)/],
  ["pricing", /(^|[/-])(pricing|prices|plans|packages|rates|fees|tariff)([/-]|$)/],
  ["services", /(^|[/-])(services?|what-we-do|solutions|treatments|courses|programs?)([/-]|$)/],
  ["products", /(^|[/-])(products?|shop|store|menu|collections?|catalog(ue)?)([/-]|$)/],
  ["testimonials", /(^|[/-])(testimonials?|reviews?|clients|case-stud(y|ies)|success-stor(y|ies)|customers)([/-]|$)/],
  ["faq", /(^|[/-])(faqs?|help|questions|support)([/-]|$)/],
  ["contact", /(^|[/-])(contact|contact-us|locations?|visit|find-us|reach-us)([/-]|$)/],
  ["blog", /(^|[/-])(blog|news|articles|insights|journal|stories)([/-]|$)/],
];

const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|mp4|mp3|webm|css|js|xml|json|txt|docx?|xlsx?)$/i;
const SKIP_PATH = /(^|\/)(wp-admin|wp-json|login|signin|sign-in|register|cart|checkout|account|my-account|privacy|terms|cookie|legal|tag|author|feed|cdn-cgi)(\/|$)/i;

export const hostKey = (h: string) => h.toLowerCase().replace(/^www\./, "");

export function classifyUrl(raw: string, siteHost: string): PageType | "other" | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || hostKey(u.hostname) !== hostKey(siteHost)) return null;
  const path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, "") || "/";
  if (SKIP_EXT.test(path) || SKIP_PATH.test(path)) return null;
  if (path === "/" || /^\/(index\.html?|home|en|te)$/.test(path)) return "home";
  for (const [type, re] of RULES) if (re.test(path)) return type;
  return "other";
}

export interface SelectedPage {
  url: string;
  type: PageType;
  title?: string;
}

/** Home first, then up to `perType` per type (shallowest paths first), capped at `max`. */
export function selectPages(
  seedUrl: string,
  links: ReadonlyArray<{ url: string; title?: string }>,
  opts: { max?: number; perType?: number } = {},
): SelectedPage[] {
  const max = opts.max ?? 12;
  const perType = opts.perType ?? 2;
  const seed = new URL(seedUrl);
  const byType = new Map<PageType, SelectedPage[]>();
  const seen = new Set<string>();
  const canonical = (u: string) => {
    const x = new URL(u);
    x.hash = "";
    x.search = "";
    x.hostname = hostKey(x.hostname);
    return x.toString().replace(/\/$/, "");
  };

  const all = [{ url: seed.origin + "/" }, ...links];
  for (const l of all) {
    const type = classifyUrl(l.url, seed.hostname);
    if (!type || type === "other") continue;
    const key = canonical(l.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byType.get(type) ?? [];
    list.push({ url: l.url.split("#")[0]!, type, title: l.title });
    byType.set(type, list);
  }

  const depth = (u: string) => new URL(u).pathname.split("/").filter(Boolean).length;
  const out: SelectedPage[] = [];
  for (const type of PAGE_TYPES) {
    const items = (byType.get(type) ?? []).sort((a, b) => depth(a.url) - depth(b.url) || a.url.length - b.url.length || a.url.localeCompare(b.url));
    out.push(...items.slice(0, type === "home" || type === "blog" ? 1 : perType));
  }
  return out.slice(0, max);
}
