/**
 * Adds utm_* parameters to links in a post so website analytics (Matomo campaigns report)
 * can attribute visits to the campaign and the exact post. Links that already carry
 * utm_source are left alone.
 */
export interface UtmParams { source: string; medium: string; campaign: string; content?: string }

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const TRAILING = /[.,;:!?]+$/;

export function withUtm(text: string, p: UtmParams): string {
  return text.replace(URL_RE, (raw) => {
    const trail = raw.match(TRAILING)?.[0] ?? "";
    const link = trail ? raw.slice(0, -trail.length) : raw;
    try {
      const u = new URL(link);
      if (u.searchParams.has("utm_source")) return raw;
      u.searchParams.set("utm_source", p.source);
      u.searchParams.set("utm_medium", p.medium);
      u.searchParams.set("utm_campaign", p.campaign);
      if (p.content) u.searchParams.set("utm_content", p.content);
      return u.toString() + trail;
    } catch {
      return raw;
    }
  });
}

export const utmCampaign = (name: string | null | undefined) =>
  (name ?? "arcatic").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "arcatic";
