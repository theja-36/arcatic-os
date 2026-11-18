import webpush from "web-push";

/**
 * Web Push (RFC 8030 + VAPID RFC 8292, payload encryption RFC 8291) through the `web-push`
 * library. Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY; generate them once with
 * `npx web-push generate-vapid-keys`. FCM / APNs for a native app would be a second sender.
 */
export interface PushSubscriptionRow { endpoint: string; keys: { p256dh?: string; auth?: string } }
export interface PushPayload { title: string; body?: string; link?: string; tag?: string }
export type PushResult = { ok: true; status: number } | { ok: false; status: number | null; expired: boolean; message: string };

export class WebPushSender {
  constructor(private readonly opts: { publicKey: string; privateKey: string; subject: string; ttlSeconds?: number }) {
    if (!/^(mailto:|https:)/.test(opts.subject)) throw new Error("VAPID subject must be a mailto: or https: URL");
  }
  get publicKey() { return this.opts.publicKey; }

  async send(sub: PushSubscriptionRow, payload: PushPayload): Promise<PushResult> {
    if (!sub.keys.p256dh || !sub.keys.auth) return { ok: false, status: null, expired: true, message: "subscription has no keys" };
    try {
      const res = await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: this.opts.subject, publicKey: this.opts.publicKey, privateKey: this.opts.privateKey },
        TTL: this.opts.ttlSeconds ?? 24 * 3600, urgency: "normal", timeout: 10_000,
      });
      return { ok: true, status: res.statusCode };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? null;
      // 404 / 410: the browser unsubscribed; the device row should be removed
      return { ok: false, status, expired: status === 404 || status === 410, message: String((e as Error).message).slice(0, 300) };
    }
  }
}

export function pushFromEnv(env: NodeJS.ProcessEnv = process.env): WebPushSender | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return new WebPushSender({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "mailto:ops@example.test" });
}
