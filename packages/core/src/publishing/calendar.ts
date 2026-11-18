/**
 * Unified marketing calendar: campaign topics (plans), content (drafts → approved) and publish
 * targets (scheduled → published / failed), merged into one dated list. Pure; the API loads rows.
 */
export type CalendarState =
  | "idea" | "planned" | "draft" | "in_review" | "changes_requested" | "approved"
  | "scheduled" | "publishing" | "published" | "failed" | "missed" | "cancelled";

export interface CalendarEntry {
  key: string;
  date: string;                 // ISO timestamp (topics: date at 09:00 local)
  kind: "topic" | "content" | "post";
  state: CalendarState;
  title: string;
  channel: string | null;
  campaignId?: string | null;
  contentItemId?: string | null;
  scheduleId?: string;
  groupId?: string;
  accountName?: string | null;
  url?: string | null;
  error?: string | null;
  metrics?: { impressions?: number | null; engagements?: number | null; clicks?: number | null } | null;
}

export interface CalendarInput {
  topics: Array<{ id: string; title: string; planned_for: string | null; status: string; channel: string | null; campaign_id: string | null; content_item_id: string | null }>;
  items: Array<{ id: string; title: string | null; status: string; channel: string | null; type: string; updated_at: string; campaign_id?: string | null }>;
  schedules: Array<{
    id: string; group_id: string; content_item_id: string; publish_at: string; status: string; external_url: string | null; last_error: { message?: string } | null;
    account: { display_name: string | null; channel: string | null } | null;
  }>;
  metrics?: Record<string, { impressions?: number | null; engagements?: number | null; clicks?: number | null }>;   // by schedule id
}

const CONTENT_STATES = new Set(["draft", "in_review", "changes_requested", "approved"]);

export function buildCalendar(input: CalendarInput): { entries: CalendarEntry[]; unscheduled: CalendarEntry[] } {
  const itemById = new Map(input.items.map((i) => [i.id, i]));
  const scheduled = new Set(input.schedules.filter((s) => s.status !== "cancelled").map((s) => s.content_item_id));
  const entries: CalendarEntry[] = [];
  const unscheduled: CalendarEntry[] = [];
  const placed = new Set<string>();

  for (const s of input.schedules) {
    const item = itemById.get(s.content_item_id);
    entries.push({
      key: `post:${s.id}`, date: s.publish_at, kind: "post", state: s.status as CalendarState,
      title: item?.title ?? "Untitled", channel: s.account?.channel ?? item?.channel ?? null, contentItemId: s.content_item_id,
      scheduleId: s.id, groupId: s.group_id, accountName: s.account?.display_name ?? null, url: s.external_url,
      error: s.last_error?.message ?? null, metrics: input.metrics?.[s.id] ?? null, campaignId: item?.campaign_id ?? null,
    });
  }

  for (const t of input.topics) {
    if (t.status === "dropped") continue;
    const item = t.content_item_id ? itemById.get(t.content_item_id) : undefined;
    if (item && scheduled.has(item.id)) continue;                 // its posts already show
    if (!t.planned_for) continue;
    if (item && CONTENT_STATES.has(item.status)) {
      placed.add(item.id);
      entries.push({ key: `content:${item.id}`, date: `${t.planned_for}T09:00:00`, kind: "content", state: item.status as CalendarState, title: item.title ?? t.title, channel: item.channel ?? t.channel, contentItemId: item.id, campaignId: t.campaign_id });
    } else if (!item) {
      entries.push({ key: `topic:${t.id}`, date: `${t.planned_for}T09:00:00`, kind: "topic", state: t.status === "idea" ? "idea" : "planned", title: t.title, channel: t.channel, campaignId: t.campaign_id });
    }
  }

  for (const i of input.items) {
    if (placed.has(i.id) || scheduled.has(i.id) || !CONTENT_STATES.has(i.status)) continue;
    unscheduled.push({ key: `content:${i.id}`, date: i.updated_at, kind: "content", state: i.status as CalendarState, title: i.title ?? "Untitled", channel: i.channel, contentItemId: i.id, campaignId: i.campaign_id ?? null });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  unscheduled.sort((a, b) => b.date.localeCompare(a.date));
  return { entries, unscheduled };
}
