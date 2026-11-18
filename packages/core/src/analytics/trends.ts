export interface Trend {
  metric: string;
  current: number;
  previous: number;
  /** null when the previous window had nothing */
  change: number | null;
  direction: "up" | "down" | "flat";
  /** enough data and a large, consistent difference (Welch t ≥ 2, |change| ≥ 15 %, ≥ 5 points each side) */
  significant: boolean;
  t: number | null;
  points: number;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const variance = (a: number[]) => { const m = mean(a); return a.length > 1 ? a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) : 0; };

/** Compare two windows of daily values (missing days already filled with 0 where that's meaningful). */
export function compareWindows(metric: string, current: number[], previous: number[]): Trend {
  const cur = current.reduce((s, x) => s + x, 0);
  const prev = previous.reduce((s, x) => s + x, 0);
  const change = prev > 0 ? (cur - prev) / prev : null;
  let t: number | null = null;
  if (current.length >= 5 && previous.length >= 5) {
    const se = Math.sqrt(variance(current) / current.length + variance(previous) / previous.length);
    t = se > 0 ? (mean(current) - mean(previous)) / se : mean(current) === mean(previous) ? 0 : null;
  }
  const significant = t !== null && Math.abs(t) >= 2 && change !== null && Math.abs(change) >= 0.15;
  const direction = change === null ? (cur > 0 ? "up" : "flat") : change > 0.02 ? "up" : change < -0.02 ? "down" : "flat";
  return { metric, current: cur, previous: prev, change, direction, significant, t, points: current.length };
}

/** Least-squares slope per day (for the "trend line" label), null with < 3 points. */
export function slope(values: number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const xs = values.map((_, i) => i);
  const mx = mean(xs), my = mean(values);
  const num = xs.reduce((s, x, i) => s + (x - mx) * (values[i]! - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den ? num / den : null;
}
