/**
 * Normalised metric columns (performance_metrics) and mappings from source labels.
 * Postiz labels verified in postiz-app-main …/integrations/social/*.provider.ts postAnalytics():
 *   X: Impressions, Likes, Replies, Retweets, Quotes, Bookmarks · TikTok: Views, Likes, Comments, Shares
 *   YouTube: Views, Likes, Comments, Favorites · Instagram: Views, Reach, Saves, Likes, Comments, Shares, Engagement
 *   Facebook: Impressions (post_total_media_view_unique), Clicks, Reactions · Threads: Views, Likes, Replies, Reposts, Quotes
 *   LinkedIn page: Impressions, Unique Impressions, Clicks, Likes, Comments, Shares, Engagement · GBP: none per post
 */
export const METRIC_COLUMNS = [
  "impressions", "reach", "engagements", "likes", "comments", "shares", "saves", "clicks", "unique_clicks", "video_views", "watch_time_seconds",
  "opens", "sends", "failed", "conversions", "conversion_value_minor", "spend_minor", "followers", "visits", "visitors", "bounces",
] as const;
export type MetricColumn = (typeof METRIC_COLUMNS)[number];
export type MetricValues = Partial<Record<MetricColumn, number>>;

const POSTIZ_LABELS: Record<string, MetricColumn> = {
  impressions: "impressions", "unique impressions": "reach", reach: "reach", views: "video_views", likes: "likes", reactions: "likes",
  comments: "comments", replies: "comments", shares: "shares", retweets: "shares", reposts: "shares", saves: "saves", bookmarks: "saves",
  clicks: "clicks", engagement: "engagements", followers: "followers", "page impressions": "impressions",
};

export interface PostizAnalyticsData { label: string; data: Array<{ total: string | number; date: string }>; percentageChange?: number }

/** One post's lifetime totals: the latest point of each series. Unknown labels go to `extra`. */
export function normalizePostiz(data: PostizAnalyticsData[]): { values: MetricValues; extra: Record<string, number> } {
  const values: MetricValues = {};
  const extra: Record<string, number> = {};
  for (const series of data ?? []) {
    const pts = [...(series.data ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const last = pts.at(-1);
    const n = Number(last?.total);
    if (!last || !Number.isFinite(n)) continue;
    const col = POSTIZ_LABELS[series.label.trim().toLowerCase()];
    if (col) values[col] = (values[col] ?? 0) + n;   // e.g. Replies + Comments both count as comments
    else extra[slug(series.label)] = n;
  }
  return { values, extra };
}

/** Account-level daily series (GET /analytics/:integration): one value per label per day. */
export function normalizePostizDaily(data: PostizAnalyticsData[]): Map<string, { values: MetricValues; extra: Record<string, number> }> {
  const byDay = new Map<string, { values: MetricValues; extra: Record<string, number> }>();
  for (const series of data ?? []) {
    const col = POSTIZ_LABELS[series.label.trim().toLowerCase()];
    for (const p of series.data ?? []) {
      const n = Number(p.total);
      const day = String(p.date).slice(0, 10);
      if (!Number.isFinite(n) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const row = byDay.get(day) ?? { values: {}, extra: {} };
      if (col) row.values[col] = (row.values[col] ?? 0) + n;
      else row.extra[slug(series.label)] = n;
      byDay.set(day, row);
    }
  }
  return byDay;
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

/** What "seen" means per platform: impressions if reported, else views, else reach. */
export const seen = (m: MetricValues) => m.impressions ?? m.video_views ?? m.reach ?? null;
/** Interactions: the platform's own engagement figure if given, else likes + comments + shares + saves. */
export function interactions(m: MetricValues): number | null {
  if (m.engagements != null) return m.engagements;
  const parts = [m.likes, m.comments, m.shares, m.saves].filter((x): x is number => x != null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}
/** Interactions per view; null when there's no audience figure to divide by. */
export function engagementRate(m: MetricValues): number | null {
  const s = seen(m);
  const i = interactions(m);
  return s && s > 0 && i != null ? i / s : null;
}

export function sumValues(rows: MetricValues[]): MetricValues {
  const out: MetricValues = {};
  for (const r of rows) for (const k of METRIC_COLUMNS) if (r[k] != null) out[k] = (out[k] ?? 0) + Number(r[k]);
  return out;
}
