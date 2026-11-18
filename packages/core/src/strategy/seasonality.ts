import { addDays, toISO } from "./dates.js";

export interface SeasonalMoment {
  name: string;
  date: string;
  region: string;   // "IN", "IN-TG", "IN-AP", or a workspace-specific region
  kind: "festival" | "national" | "commercial" | "awareness" | "business";
  note?: string;
}

/**
 * Built-in moments whose dates follow fixed rules. Lunar-calendar festivals (Ugadi, Holi,
 * Diwali, Dasara, Bathukamma, Eid, Ganesh Chaturthi, Raksha Bandhan …) change every year and are
 * NOT guessed here — they come from the seasonal_events table, maintained per year.
 */
const FIXED: Array<{ md: string; name: string; region: string; kind: SeasonalMoment["kind"]; note?: string }> = [
  { md: "01-01", name: "New Year's Day", region: "IN", kind: "national" },
  { md: "01-14", name: "Makar Sankranti / Pongal", region: "IN", kind: "festival", note: "Usually 14 or 15 January; Bhogi falls the day before" },
  { md: "01-26", name: "Republic Day", region: "IN", kind: "national" },
  { md: "02-14", name: "Valentine's Day", region: "IN", kind: "commercial" },
  { md: "03-08", name: "International Women's Day", region: "IN", kind: "awareness" },
  { md: "04-07", name: "World Health Day", region: "IN", kind: "awareness" },
  { md: "05-01", name: "Labour Day", region: "IN", kind: "national" },
  { md: "06-02", name: "Telangana Formation Day", region: "IN-TG", kind: "national" },
  { md: "06-21", name: "International Yoga Day", region: "IN", kind: "awareness" },
  { md: "08-15", name: "Independence Day", region: "IN", kind: "national" },
  { md: "09-05", name: "Teachers' Day", region: "IN", kind: "awareness" },
  { md: "10-02", name: "Gandhi Jayanti", region: "IN", kind: "national" },
  { md: "11-01", name: "Andhra Pradesh Formation Day", region: "IN-AP", kind: "national" },
  { md: "11-14", name: "Children's Day", region: "IN", kind: "awareness" },
  { md: "12-25", name: "Christmas", region: "IN", kind: "festival" },
  { md: "12-31", name: "New Year's Eve", region: "IN", kind: "commercial" },
];

/** n-th weekday of a month (weekday: 0=Sun … 6=Sat), UTC. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return toISO(new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)));
}

const RULES: Array<{ name: string; kind: SeasonalMoment["kind"]; at: (y: number) => string }> = [
  { name: "Mother's Day", kind: "commercial", at: (y) => nthWeekday(y, 5, 0, 2) },
  { name: "Father's Day", kind: "commercial", at: (y) => nthWeekday(y, 6, 0, 3) },
  { name: "Friendship Day", kind: "commercial", at: (y) => nthWeekday(y, 8, 0, 1) },
  { name: "Black Friday", kind: "commercial", at: (y) => addDays(nthWeekday(y, 11, 4, 4), 1) },
];

export function builtInMoments(from: string, to: string, regions: readonly string[] = ["IN"]): SeasonalMoment[] {
  const out: SeasonalMoment[] = [];
  const y0 = Number(from.slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  const inRegion = (r: string) => r === "IN" || regions.includes(r);
  for (let y = y0; y <= y1; y++) {
    for (const f of FIXED) if (inRegion(f.region)) out.push({ name: f.name, date: `${y}-${f.md}`, region: f.region, kind: f.kind, note: f.note });
    for (const r of RULES) out.push({ name: r.name, date: r.at(y), region: "IN", kind: r.kind });
  }
  return out.filter((m) => m.date >= from && m.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** Built-ins + table rows (global and workspace), de-duplicated by name+date. */
export function mergeMoments(builtIn: readonly SeasonalMoment[], fromDb: readonly SeasonalMoment[]): SeasonalMoment[] {
  const seen = new Set<string>();
  return [...fromDb, ...builtIn]
    .filter((m) => {
      const k = `${m.name.toLowerCase()}|${m.date}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** Regions implied by a location string ("Hyderabad" → Telangana). */
export function regionsForLocation(location: string | undefined): string[] {
  const l = (location ?? "").toLowerCase();
  const out = ["IN"];
  if (/telangana|hyderabad|secunderabad|warangal|karimnagar|nizamabad|khammam/.test(l)) out.push("IN-TG");
  if (/andhra|vijayawada|visakhapatnam|vizag|guntur|tirupati|nellore|kakinada|rajahmundry/.test(l)) out.push("IN-AP");
  return out;
}
