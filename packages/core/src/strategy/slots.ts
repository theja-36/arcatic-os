import { addDays } from "./dates.js";
import type { StrategyPlan } from "./plan.js";

/**
 * Deterministic weekly slot allocation: which channel posts on which day, for which campaign,
 * in which format. The model only writes the topic for each slot.
 */
export interface SlotCampaign {
  id: string;            // campaign row id
  key?: string;
  name: string;
  startsOn: string | null;
  endsOn: string | null;
  channels: string[];
  contentTypes: string[];
}

export interface Slot {
  slotKey: string;       // "<date>:<channel>:<n>"
  date: string;
  channel: string;
  contentType: string;
  campaignId: string;
}

/** Days to use for n posts a week (Mon=0). Spread out, favouring Tue/Thu/Sat. */
const DAY_ORDER = [1, 3, 5, 0, 2, 4, 6];
export function postingDays(n: number): number[] {
  if (n <= 0) return [];
  const days: number[] = [];
  for (let i = 0; i < n; i++) days.push(DAY_ORDER[i % 7]!);
  return days.sort((a, b) => a - b);
}

export function allocateWeekSlots(args: {
  weekStart: string;
  channelMix: StrategyPlan["channelMix"];
  campaigns: SlotCampaign[];
  /** used when no campaign is running on a day for that channel */
  fallbackCampaignId: string;
  existingSlotKeys?: ReadonlySet<string>;
}): Slot[] {
  const slots: Slot[] = [];
  const cursor = new Map<string, number>();   // round-robin per channel
  for (const mix of args.channelMix) {
    const perDay = new Map<number, number>();
    postingDays(mix.postsPerWeek).forEach((d, i) => {
      const date = addDays(args.weekStart, d);
      const n = perDay.get(d) ?? 0;
      perDay.set(d, n + 1);
      const slotKey = `${date}:${mix.channel}:${n}`;
      if (args.existingSlotKeys?.has(slotKey)) return;
      const running = args.campaigns.filter((c) =>
        (!c.startsOn || c.startsOn <= date) && (!c.endsOn || c.endsOn >= date) && (c.channels.length === 0 || c.channels.includes(mix.channel)));
      const idx = cursor.get(mix.channel) ?? 0;
      cursor.set(mix.channel, idx + 1);
      const campaign = running.length ? running[idx % running.length]! : undefined;
      const types = campaign?.contentTypes.length ? campaign.contentTypes.filter((t) => mix.contentTypes.includes(t as never)) : [];
      const pool = types.length ? types : mix.contentTypes;
      slots.push({ slotKey, date, channel: mix.channel, contentType: pool[i % pool.length] ?? "social_post", campaignId: campaign?.id ?? args.fallbackCampaignId });
    });
  }
  return slots.sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) || a.slotKey.localeCompare(b.slotKey));
}
