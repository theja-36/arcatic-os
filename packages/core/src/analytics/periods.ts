export const PERIODS = { "7d": 7, "30d": 30, "365d": 365 } as const;
export type Period = keyof typeof PERIODS;

/** The last N calendar days (UTC) including today, and the N days before that. */
export function periodRange(period: Period, now = new Date()) {
  const days = PERIODS[period];
  const to = new Date(now);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86_400_000);
  const prevFrom = new Date(from.getTime() - days * 86_400_000);
  return { days, from, to, prevFrom, prevTo: from };
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export function dayList(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t < to.getTime(); t += 86_400_000) out.push(isoDay(new Date(t)));
  return out;
}
