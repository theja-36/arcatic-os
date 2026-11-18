import type { NoticeContent } from "@arcatic/core";
import type { Db } from "@arcatic/database";
import type { Mailer, WebPushSender } from "@arcatic/integrations";

/**
 * One way to notify people: an in-app row (the feed), then Web Push to their registered
 * browsers and, for critical events, an email. Delivery is best effort and recorded on the row
 * (`delivery`); a failed push or email never fails the action that caused it. Repeats with the
 * same dedupe key are skipped before anything is sent.
 */
export interface Recipient { userId: string; audience: "customer" | "staff"; workspaceId?: string | null }
export interface DeliveryReport { notificationId: string; userId: string; push: Array<{ status: number | null; ok: boolean; expired?: boolean }>; email: { sent: boolean; reason?: string } | null }

export function createNotifier(deps: { db: Db; push?: WebPushSender | null; mailer?: Mailer | null; appUrl?: string; log?: (m: string, d?: unknown) => void }) {
  const { db } = deps;
  const log = deps.log ?? ((m, d) => console.warn(JSON.stringify({ level: "warn", msg: m, ...(d as object) })));

  async function deliver(id: string, userId: string, n: NoticeContent): Promise<DeliveryReport> {
    const report: DeliveryReport = { notificationId: id, userId, push: [], email: null };
    if (deps.push) {
      const devs = await db.from("user_devices").select("id, endpoint, keys").eq("user_id", userId).eq("kind", "webpush");
      for (const d of (devs.data ?? []) as Array<{ id: string; endpoint: string; keys: { p256dh?: string; auth?: string } }>) {
        const r = await deps.push.send({ endpoint: d.endpoint, keys: d.keys }, { title: n.title, body: n.body, link: n.link, tag: n.kind });
        report.push.push(r.ok ? { status: r.status, ok: true } : { status: r.status, ok: false, expired: r.expired });
        if (!r.ok && r.expired) await db.from("user_devices").delete().eq("id", d.id);
        else if (r.ok) await db.from("user_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", d.id);
      }
    }
    if (n.email && deps.mailer) {
      const u = await db.from("users").select("email").eq("id", userId).maybeSingle();
      const to = (u.data as { email?: string } | null)?.email;
      if (!to) report.email = { sent: false, reason: "no email address" };
      else {
        try {
          const r = await deps.mailer.send({ to, subject: n.email.subject, text: n.email.text });
          report.email = r.sent ? { sent: true } : { sent: false, reason: r.reason };
        } catch (e) {
          report.email = { sent: false, reason: String((e as Error).message).slice(0, 200) };
        }
      }
    }
    await db.from("notifications").update({ delivery: { push: report.push, email: report.email, at: new Date().toISOString() } }).eq("id", id);
    return report;
  }

  return {
    async send(items: Array<{ to: Recipient; notice: NoticeContent; dedupeKey?: string; data?: Record<string, unknown> }>): Promise<DeliveryReport[]> {
      const seen = new Set<string>();
      const reports: DeliveryReport[] = [];
      for (const it of items) {
        if (!it.to.userId) continue;
        const key = `${it.to.userId}:${it.dedupeKey ?? it.notice.kind + it.notice.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ins = await db.from("notifications").insert({
          user_id: it.to.userId, workspace_id: it.to.workspaceId ?? null, audience: it.to.audience, kind: it.notice.kind, title: it.notice.title.slice(0, 200),
          body: it.notice.body.slice(0, 1000), link: it.notice.link, data: it.data ?? {}, dedupe_key: it.dedupeKey ?? null,
        }).select("id").maybeSingle();
        if (ins.error || !ins.data) continue;   // 23505: already notified
        try {
          reports.push(await deliver((ins.data as { id: string }).id, it.to.userId, it.notice));
        } catch (e) {
          log("notification delivery failed", { error: String(e) });
        }
      }
      return reports;
    },
  };
}
export type Notifier = ReturnType<typeof createNotifier>;

/** Active service managers. */
export async function serviceManagers(db: Db): Promise<string[]> {
  const r = await db.from("service_staff").select("user_id").eq("role", "manager").eq("active", true);
  return ((r.data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
}
/** Customer-side recipients of a request: whoever asked, plus members who can approve. */
export async function requestCustomers(db: Db, req: { workspace_id?: string; created_by: string | null }): Promise<string[]> {
  const r = req.workspace_id ? await db.from("workspace_members").select("user_id").eq("workspace_id", req.workspace_id).eq("status", "active").in("role", ["owner", "admin", "editor", "reviewer"]) : { data: [] };
  return [...new Set([req.created_by, ...((r.data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id)].filter((x): x is string => !!x))];
}
