"use client";
import type { Version } from "./types";
import { Card, cn } from "@arcatic/ui";

/** Ready-to-ship checklist from deterministic validation (blocks approval when there are errors). */
export function Checklist({ report, dirty }: { report: Version["validation_report"]; dirty: boolean }) {
  if (!report) return null;
  const all = [...report.issues, ...(report.scene?.issues ?? [])];
  const errors = all.filter((i) => i.severity === "error");
  const warnings = all.filter((i) => i.severity === "warning");
  const ok = report.passed && (report.scene?.passed ?? true);
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{ok ? "✓ Ready to submit" : "Needs fixes"}</h3>
        {report.stats?.limit ? <span className={cn("text-xs", report.stats.length > report.stats.limit ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>{report.stats.length} / {report.stats.limit}</span> : null}
      </div>
      {dirty && <p className="text-xs text-[var(--text-muted)]">Save to re-check your edits.</p>}
      {errors.map((i) => <p key={i.message} className="text-sm text-[var(--danger)]">✕ {i.message}</p>)}
      {warnings.map((i) => <p key={i.message} className="text-sm text-[var(--warning)]">! {i.message}</p>)}
      {!all.length && <p className="text-sm text-[var(--text-muted)]">Brand words, platform limits, disclaimers and claims all check out.</p>}
    </Card>
  );
}
