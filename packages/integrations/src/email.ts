import nodemailer from "nodemailer";

/**
 * Transactional email over SMTP (staging: the local / staging mail catcher; production: the
 * provider's SMTP relay). Guarded so a non-production environment can never email a real person:
 *   EMAIL_MODE=off        → nothing is sent
 *   EMAIL_MODE=allowlist  → only addresses in EMAIL_ALLOWLIST: a domain (default: example.test) or one exact address
 *   EMAIL_MODE=all        → everyone (production only, set deliberately)
 */
export interface Mail { to: string; subject: string; text: string; html?: string }
export type MailResult = { sent: true; id: string } | { sent: false; reason: string };

export class Mailer {
  private readonly tx: nodemailer.Transporter;
  constructor(private readonly opts: { host: string; port: number; secure?: boolean; user?: string; pass?: string; from: string; mode: "off" | "allowlist" | "all"; allowlist: string[] }) {
    this.tx = nodemailer.createTransport({ host: opts.host, port: opts.port, secure: !!opts.secure, ...(opts.user && { auth: { user: opts.user, pass: opts.pass } }) });
  }
  allowed(to: string): boolean {
    if (this.opts.mode === "off") return false;
    if (this.opts.mode === "all") return true;
    const addr = to.trim().toLowerCase();
    const domain = addr.split("@")[1] ?? "";
    // an entry with "@" is one exact address (a tester's real inbox); otherwise it is a domain (and its subdomains)
    return this.opts.allowlist.some((d) => (d.includes("@") ? addr === d : domain === d || domain.endsWith(`.${d}`)));
  }
  async send(m: Mail): Promise<MailResult> {
    if (!this.allowed(m.to)) return { sent: false, reason: this.opts.mode === "off" ? "email disabled" : "recipient not on the staging allowlist" };
    const info = await this.tx.sendMail({ from: this.opts.from, to: m.to, subject: m.subject, text: m.text, ...(m.html && { html: m.html }) });
    return { sent: true, id: String(info.messageId) };
  }
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | null {
  if (!env.SMTP_HOST) return null;
  const mode = (env.EMAIL_MODE ?? "allowlist") as "off" | "allowlist" | "all";
  if (!["off", "allowlist", "all"].includes(mode)) throw new Error("EMAIL_MODE must be off, allowlist or all");
  return new Mailer({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), secure: env.SMTP_SECURE === "true", user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined,
    from: env.EMAIL_FROM ?? "Arcatic <no-reply@example.test>", mode, allowlist: (env.EMAIL_ALLOWLIST ?? "example.test").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  });
}
