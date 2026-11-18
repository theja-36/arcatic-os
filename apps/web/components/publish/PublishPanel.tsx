"use client";
import { useEffect, useMemo, useState } from "react";
import { CHANNEL_RULES, type PublishChannel } from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { ChannelSettings } from "./ChannelSettings";

type Account = { id: string; display_name: string | null; avatar_url: string | null; channel: PublishChannel; status: string; enabled: boolean; min_role: string };
type Issue = { severity: "error" | "warning"; message: string; field?: string };
type Preview = { accountId: string; channel: PublishChannel; text: string; thread?: string[]; title: string | null; media: Array<{ kind: string; ext: string }>; settings: Record<string, unknown>; report: { passed: boolean; issues: Issue[]; length: number; limit: number | null } };
type Schedule = {
  id: string; group_id: string; publish_at: string; status: string; enabled: boolean; external_url: string | null; last_error: { message?: string } | null; attempts: number; revision: number;
  account: { display_name: string | null; channel: string } | null;
};
type Target = { on: boolean; custom: boolean; text: string; settings: Record<string, unknown> };

const SHORT_VIDEO: PublishChannel[] = ["instagram", "tiktok", "youtube", "facebook"];
const tone = (s: string) => (s === "published" ? "success" : s === "failed" || s === "missed" ? "danger" : s === "publishing" ? "warning" : s === "scheduled" ? "accent" : "neutral");
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function PublishPanel({ workspaceId, brandId, contentId, contentType, title, canPublish }: { workspaceId: string; brandId: string; contentId: string; contentType: string; title: string | null; canPublish: boolean }) {
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const options = useApi<{ channels: PublishChannel[]; accounts: Account[]; approval: string | null; status: string }>(`${base}/content/${contentId}/publish-options`);
  const schedules = useApi<{ data: Schedule[] }>(`${base}/schedules?contentItemId=${contentId}`);
  const [targets, setTargets] = useState<Record<string, Target>>({});
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [when, setWhen] = useState<"now" | "later">("later");
  const [at, setAt] = useState(localInput(new Date(Date.now() + 86_400_000)));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState<string>();

  useEffect(() => {
    const ch = supabase().channel(`schedules:${contentId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "schedules", filter: `content_item_id=eq.${contentId}` }, () => void schedules.reload())
      .subscribe();
    return () => void supabase().removeChannel(ch);
  }, [contentId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const usable = (options.data?.accounts ?? []).filter((a) => a.enabled && a.status === "active");
  const chosen = useMemo(() => Object.entries(targets).filter(([, t]) => t.on).map(([id]) => id), [targets]);
  const toggle = (id: string, on: boolean) => setTargets((t) => ({ ...t, [id]: t[id] ? { ...t[id]!, on } : { on, custom: false, text: "", settings: {} } }));
  const update = (id: string, patch: Partial<Target>) => setTargets((t) => ({ ...t, [id]: { ...t[id]!, ...patch } }));
  const body = (ids: string[]) => ids.map((id) => {
    const t = targets[id]!;
    return { accountId: id, text: t.custom ? t.text : null, settings: t.settings };
  });

  async function check(ids = chosen) {
    if (!ids.length) return;
    const r = await api<{ data: Preview[] }>(`${base}/content/${contentId}/publish/preview`, { method: "POST", body: JSON.stringify({ targets: body(ids) }) });
    setPreviews((p) => ({ ...p, ...Object.fromEntries(r.data.map((x) => [x.accountId, x])) }));
    // fill defaults the server applied (titles etc.) so the person sees them
    setTargets((t) => ({ ...t, ...Object.fromEntries(r.data.map((x) => [x.accountId, { ...t[x.accountId]!, settings: { ...x.settings, ...t[x.accountId]!.settings }, text: t[x.accountId]!.custom ? t[x.accountId]!.text : x.text }])) }));
    return r.data;
  }
  async function run<T>(fn: () => Promise<T>, ok: string | ((r: T) => string)) {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await fn();
      setMsg({ text: typeof ok === "string" ? ok : ok(r) });
      await schedules.reload();
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.details)) {
        const by: Record<string, string[]> = {};
        for (const d of e.details as Array<{ path: string; message: string }>) (by[d.path.split(".")[0]!] ??= []).push(d.message);
        setErrors(by);
      }
      setMsg({ err: true, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const schedule = () => run(async () => {
    setErrors({});
    const publishAt = when === "now" ? "now" : new Date(at).toISOString();
    const r = await api<{ approval: string | null; scheduleIds: string[] }>(`${base}/content/${contentId}/publish`, {
      method: "POST", body: JSON.stringify({ publishAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, targets: body(chosen) }),
    });
    setTargets({});
    setPreviews({});
    return r;
  }, (r) => `Scheduled to ${r.scheduleIds.length} account(s).${r.approval ? ` ${r.approval}` : ""}`);

  const shortVideoSet = () => {
    const next: Record<string, Target> = { ...targets };
    for (const a of usable) if (SHORT_VIDEO.includes(a.channel)) next[a.id] = { on: true, custom: false, text: "", settings: a.channel === "youtube" ? { title: (title ?? "").slice(0, 100) } : {} };
    setTargets(next);
  };

  if (options.error) return null;
  const live = (schedules.data?.data ?? []).filter((s) => s.status !== "cancelled");
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between"><h3 className="font-semibold">Publish</h3>{options.data?.status === "approved" ? <Badge tone="success">approved</Badge> : <Badge tone="warning">needs approval</Badge>}</div>

      {live.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {live.map((s) => (
            <li key={s.id} className="rounded-md border border-[var(--border)] p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{s.account?.display_name ?? s.account?.channel}</span>
                <Badge tone={tone(s.status)}>{s.status}</Badge>
              </div>
              <p className="text-xs text-[var(--text-muted)]">{new Date(s.publish_at).toLocaleString()}{s.attempts > 1 ? ` · ${s.attempts} tries` : ""}{!s.enabled ? " · turned off" : ""}</p>
              {s.last_error?.message && <p className="text-xs text-[var(--danger)]">{s.last_error.message}</p>}
              {s.external_url && <a className="text-xs text-[var(--accent)] hover:underline" href={s.external_url} target="_blank" rel="noreferrer">View post</a>}
              {canPublish && ["scheduled", "missed", "failed"].includes(s.status) && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {editing === s.id ? (
                    <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); const v = (e.currentTarget.elements.namedItem("at") as HTMLInputElement).value; void run(() => api(`${base}/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ publishAt: new Date(v).toISOString() }) }).then(() => setEditing(undefined)), "Rescheduled."); }}>
                      <Input name="at" type="datetime-local" defaultValue={localInput(new Date(Math.max(Date.now() + 600_000, Date.parse(s.publish_at))))} className="h-7 text-xs" />
                      <Button className="h-7 px-2 text-xs" type="submit" disabled={busy}>Save</Button>
                    </form>
                  ) : <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(s.id)}>Reschedule</Button>}
                  {s.status === "scheduled" && <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run(() => api(`${base}/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) }), s.enabled ? "Turned off." : "Turned on.")}>{s.enabled ? "Turn off" : "Turn on"}</Button>}
                  {s.status !== "scheduled" && <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run(() => api(`${base}/schedules/${s.id}/retry`, { method: "POST" }), "Trying again.")}>Retry</Button>}
                  <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => { if (confirm("Cancel this post?")) void run(() => api(`${base}/schedules/${s.id}/cancel`, { method: "POST" }), "Cancelled."); }}>Cancel</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!options.data?.channels.length ? (
        <p className="text-sm text-[var(--text-muted)]">{contentType === "short_video" || contentType === "yt_script" ? "This is a script. Make the video in the video editor and send it to content, then publish that." : "This kind of content isn't published to a channel directly."}</p>
      ) : !usable.length ? (
        <p className="text-sm text-[var(--text-muted)]">No connected {options.data.channels.map((c) => CHANNEL_RULES[c].label).join(" / ")} accounts for this brand. Connect them in Settings → Channels.</p>
      ) : canPublish && (
        <>
          {options.data.approval && <p className="text-xs text-[var(--warning)]">{options.data.approval}</p>}
          {contentType === "video" && <div><Button variant="secondary" className="h-7 px-2 text-xs" onClick={shortVideoSet}>Short-video set (Reels, TikTok, Shorts, Facebook)</Button></div>}
          <ul className="flex flex-col gap-2">
            {usable.map((a) => {
              const t = targets[a.id];
              const p = previews[a.id];
              const errs = errors[a.id] ?? [];
              return (
                <li key={a.id} className={cn("rounded-md border p-2", t?.on ? "border-[var(--accent)]" : "border-[var(--border)]")}>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={!!t?.on} onChange={(e) => toggle(a.id, e.target.checked)} />
                    {a.avatar_url ? <img src={a.avatar_url} alt="" className="h-5 w-5 rounded-full" /> : null}
                    <span className="min-w-0 flex-1 truncate">{a.display_name}</span>
                    <span className="text-xs text-[var(--text-muted)]">{CHANNEL_RULES[a.channel].label}</span>
                  </label>
                  {t?.on && (
                    <div className="mt-2 flex flex-col gap-2">
                      <ChannelSettings channel={a.channel} value={t.settings} onChange={(settings) => update(a.id, { settings })} />
                      {a.channel !== "wordpress" && a.channel !== "email" && (
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="flex items-center gap-2 text-[var(--text-muted)]"><input type="checkbox" checked={t.custom} onChange={(e) => update(a.id, { custom: e.target.checked, text: t.text || p?.text || "" })} /> Different text for this account</span>
                          {t.custom && <textarea className="min-h-20 rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={t.text} onChange={(e) => update(a.id, { text: e.target.value })} />}
                        </label>
                      )}
                      {p && (
                        <div className="text-xs">
                          <span className={cn(p.report.limit && p.report.length > p.report.limit ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>{p.report.length}{p.report.limit ? ` / ${p.report.limit}` : ""} characters · {p.media.length ? p.media.map((m) => m.kind).join(", ") : "no media"}{p.thread ? ` · thread of ${p.thread.length}` : ""}</span>
                          {p.report.issues.map((i, k) => <p key={k} className={i.severity === "error" ? "text-[var(--danger)]" : "text-[var(--warning)]"}>{i.severity === "error" ? "✕" : "!"} {i.message}</p>)}
                        </div>
                      )}
                      {errs.map((m, k) => <p key={k} className="text-xs text-[var(--danger)]">✕ {m}</p>)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex gap-3">
              <label className="flex items-center gap-1"><input type="radio" checked={when === "later"} onChange={() => setWhen("later")} /> Schedule</label>
              <label className="flex items-center gap-1"><input type="radio" checked={when === "now"} onChange={() => setWhen("now")} disabled={options.data.status !== "approved" && options.data.status !== "published"} /> Now</label>
            </div>
            {when === "later" && <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Publish at" />}
            <div className="flex gap-2">
              <Button variant="secondary" disabled={busy || !chosen.length} onClick={() => void run(() => check(), "Checked.")}>Check</Button>
              <Button disabled={busy || !chosen.length} onClick={() => void schedule()}>{when === "now" ? "Publish" : "Schedule"} to {chosen.length || "…"}</Button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">Posts go out only if this content is approved and unchanged at that time; otherwise they&apos;re marked missed.</p>
          </div>
        </>
      )}
      {msg && <p className={cn("text-xs", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
    </Card>
  );
}
