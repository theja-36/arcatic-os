/**
 * Staging email check. By default it only connects and authenticates to the SMTP relay
 * (nothing is sent). With --send <address> it sends ONE test message — and only if the address
 * is on EMAIL_ALLOWLIST and EMAIL_MODE is allowlist. Sending needs the owner's go-ahead.
 *
 *   npx tsx --env-file=<staging env> scripts/staging/smtp-check.ts
 *   npx tsx --env-file=<staging env> scripts/staging/smtp-check.ts --send qa@staging-inbox.example.com
 *
 * After a send, confirm in the provider's sandbox log: delivered, SPF/DKIM aligned, From header.
 */
import { Mailer, mailerFromEnv } from "../../packages/integrations/src/email.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
if (env.STAGING_TARGET !== "staging" && env.STAGING_TARGET !== "local-staging") { console.error("Set STAGING_TARGET=staging (or local-staging)."); process.exit(2); }
if (env.EMAIL_MODE === "all") { console.error("Refusing: EMAIL_MODE=all is production-only."); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
async function main() {
  const mailer: Mailer | null = mailerFromEnv(env);
  if (!mailer) { console.error("SMTP_HOST is not set."); process.exit(1); }
  const nm = createRequire(join(root, "packages/integrations/package.json"))("nodemailer") as typeof import("nodemailer");
  const tx = nm.createTransport({ host: env.SMTP_HOST!, port: Number(env.SMTP_PORT ?? 587), secure: env.SMTP_SECURE === "true", ...(env.SMTP_USER && { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }) });
  await tx.verify();
  console.log(`SMTP ok: ${env.SMTP_HOST}:${env.SMTP_PORT ?? 587} (connect + auth, nothing sent) · mode=${env.EMAIL_MODE ?? "allowlist"} · allowlist=${env.EMAIL_ALLOWLIST ?? "example.test"}`);
  const i = process.argv.indexOf("--send");
  if (i > 0) {
    const to = process.argv[i + 1];
    if (!to || !mailer.allowed(to)) { console.error(`Refusing: ${to ?? "(no address)"} is not on the allowlist.`); process.exit(1); }
    const r = await mailer.send({ to, subject: "Arcatic staging email check", text: "This is a staging connectivity test. No action needed." });
    console.log(r.sent ? `sent (${r.id})` : `not sent: ${r.reason}`);
  }
}
main().catch((e) => { console.error(String((e as Error).message ?? e).slice(0, 300)); process.exit(1); });
