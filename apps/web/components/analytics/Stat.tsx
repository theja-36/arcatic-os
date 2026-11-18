"use client";
import { Card, cn } from "@arcatic/ui";

/** Hero number with the change vs the previous period (text + arrow, never colour alone). */
export function Stat({ label, value, previous, format = (n: number) => n.toLocaleString("en-IN"), hint, invert }: {
  label: string; value: number | null; previous?: number | null; format?: (n: number) => string; hint?: string; invert?: boolean;
}) {
  const change = value != null && previous != null && previous > 0 ? (value - previous) / previous : null;
  const good = change == null ? null : invert ? change < 0 : change > 0;
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-[var(--text-muted)]">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value == null ? "—" : format(value)}</span>
      <span className="text-xs text-[var(--text-muted)]">
        {change == null ? (previous === 0 && value ? "new this period" : hint ?? "no earlier data") : (
          <span className={cn(Math.abs(change) < 0.02 ? "" : good ? "text-[var(--success)]" : "text-[var(--danger)]")}>
            {change > 0.02 ? "▲" : change < -0.02 ? "▼" : "■"} {Math.abs(Math.round(change * 100))}% vs previous period
          </span>
        )}
      </span>
    </Card>
  );
}

export const pctFmt = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
export const money = (minor: number, currency?: string | null) => `${currency ?? ""} ${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`.trim();
