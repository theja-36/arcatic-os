/** Date-only arithmetic in UTC (strings "YYYY-MM-DD"), so plans don't shift with time zones. */
export const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const toISO = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => toISO(new Date(toDate(iso).getTime() + n * 86_400_000));
export const dayOfWeek = (iso: string) => (toDate(iso).getUTCDay() + 6) % 7;   // Mon=0 … Sun=6
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);

/** The Monday on or after a date. */
export const nextMonday = (iso: string) => addDays(iso, (7 - dayOfWeek(iso)) % 7);
export const mondayOf = (iso: string) => addDays(iso, -dayOfWeek(iso));

export function weekStarts(startMonday: string, weeks = 13): string[] {
  if (dayOfWeek(startMonday) !== 0) throw new Error(`${startMonday} is not a Monday`);
  return Array.from({ length: weeks }, (_, i) => addDays(startMonday, i * 7));
}

export const isISODate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(toDate(s)) === s;
export const clampDate = (iso: string, min: string, max: string) => (iso < min ? min : iso > max ? max : iso);
