"use client";
import { useState } from "react";

/**
 * One measure over time: 2px line, light area, recessive grid, crosshair tooltip.
 * Single series → no legend; the card title names it. A table view sits next to it.
 */
export function LineChart({ points, label, format = (n) => n.toLocaleString("en-IN"), height = 160 }: {
  points: Array<{ date: string; value: number }>; label: string; format?: (n: number) => string; height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 640, H = height, PAD = { l: 44, r: 8, t: 8, b: 22 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const nice = (() => { const e = 10 ** Math.floor(Math.log10(max)); const m = max / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; })();
  const x = (i: number) => PAD.l + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / nice) * (H - PAD.t - PAD.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = points.length ? `${line}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : "";
  const ticks = [0, nice / 2, nice];
  const every = Math.max(1, Math.ceil(points.length / 6));
  const h = hover !== null ? points[hover] : undefined;
  const empty = points.every((p) => p.value === 0);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-end"><button type="button" className="text-xs text-[var(--text-muted)] hover:underline" onClick={() => setTable(!table)}>{table ? "Show chart" : "Show table"}</button></div>
      {table ? (
        <div className="max-h-56 overflow-auto"><table className="w-full text-xs"><thead><tr className="text-left text-[var(--text-muted)]"><th className="py-1">Date</th><th className="py-1 text-right">{label}</th></tr></thead>
          <tbody>{points.map((p) => <tr key={p.date} className="border-t border-[var(--border)]"><td className="py-1">{p.date}</td><td className="py-1 text-right tabular-nums">{format(p.value)}</td></tr>)}</tbody></table></div>
      ) : empty ? (
        <p className="flex items-center justify-center text-sm text-[var(--text-muted)]" style={{ height }}>No data in this period yet.</p>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label} per day`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (points.length - 1)); setHover(Math.max(0, Math.min(points.length - 1, i))); }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
                <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">{format(t)}</text>
              </g>
            ))}
            {points.map((p, i) => (i % every === 0 ? <text key={p.date} x={x(i)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--text-muted)">{p.date.slice(5)}</text> : null))}
            <path d={area} fill="var(--accent)" opacity={0.12} />
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {h && hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" />
                <circle cx={x(hover)} cy={y(h.value)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
              </g>
            )}
          </svg>
          {h && hover !== null && (
            <div className="pointer-events-none absolute top-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs shadow"
              style={{ left: `${(x(hover) / W) * 100}%`, transform: hover > points.length / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}>
              <div className="text-[var(--text-muted)]">{h.date}</div><div className="font-medium tabular-nums">{format(h.value)} {label.toLowerCase()}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
