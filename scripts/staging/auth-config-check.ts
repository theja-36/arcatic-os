/**
 * Read-only check of the hosted Supabase project's Auth settings through the Management API:
 * site URL, redirect allow-list, signup, anonymous sign-ins, token lifetime, SMTP. It changes nothing.
 *
 * Needs a personal access token with the `auth_config_read` permission, exported as
 * SUPABASE_ACCESS_TOKEN in YOUR terminal (never in chat). The project ref is taken from SUPABASE_URL.
 *
 *   npx tsx --env-file=<staging env> scripts/staging/auth-config-check.ts
 */
const env = process.env;
type Cfg = Record<string, unknown>;
async function main() {
  if (env.STAGING_TARGET !== "staging") { console.error("Set STAGING_TARGET=staging."); process.exit(2); }
  const ref = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(env.SUPABASE_URL ?? "")?.[1];
  if (!ref) { console.error("SUPABASE_URL must be https://<20-char-ref>.supabase.co"); process.exit(2); }
  if (!env.SUPABASE_ACCESS_TOKEN) { console.error("SUPABASE_ACCESS_TOKEN is not set (create a token with auth_config_read; export it in your shell)."); process.exit(2); }
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, { headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) { console.error(`Management API answered HTTP ${r.status} (token missing auth_config_read, or wrong project?)`); process.exit(1); }
  const c = (await r.json()) as Cfg;
  const app = new URL(env.APP_URL ?? "https://invalid.example").origin;
  const allow = String(c.uri_allow_list ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const rows: Array<[string, boolean | "info", string]> = [];
  rows.push(["site_url equals the staging web origin", String(c.site_url ?? "").replace(/\/$/, "") === app, `site_url=${c.site_url}`]);
  rows.push([`redirect allow-list covers ${app}/auth/callback (with ?next=…)`, allow.some((a) => a === `${app}/auth/callback**` || a === `${app}/**` || a === `${app}/auth/callback?*`), `${allow.length} entr${allow.length === 1 ? "y" : "ies"}`]);
  rows.push(["allow-list has no localhost / wildcard-everything entries", !allow.some((a) => /localhost|127\.0\.0\.1/.test(a) || a === "*" || a === "**" || /^https?:\/\/\*\*?$/.test(a)), allow.filter((a) => /localhost|127\.0\.0\.1|^\*+$/.test(a)).join(" ") || "clean"]);
  rows.push(["anonymous sign-ins are off", c.external_anonymous_users_enabled !== true, `external_anonymous_users_enabled=${c.external_anonymous_users_enabled}`]);
  rows.push(["email confirmation is not auto-confirmed", c.mailer_autoconfirm !== true, `mailer_autoconfirm=${c.mailer_autoconfirm}`]);
  rows.push(["access-token lifetime ≤ 1 hour (local verification can't see revoked sessions)", typeof c.jwt_exp === "number" && c.jwt_exp <= 3600, `jwt_exp=${c.jwt_exp}s`]);
  rows.push(["custom SMTP configured (built-in sends only to team members, 2/hour)", !!c.smtp_host, c.smtp_host ? `host set; sender ${c.smtp_admin_email ?? "?"}` : "built-in service"]);
  rows.push(["email rate limit is sensible", "info", `rate_limit_email_sent=${c.rate_limit_email_sent}/hour`]);
  rows.push(["sign-ups", "info", `disable_signup=${c.disable_signup} (staging should usually be invite-only)`]);
  for (const [n, ok, note] of rows) console.log(`${ok === "info" ? "INFO" : ok ? "PASS" : "FAIL"}  ${n}  — ${note}`);
  process.exit(rows.some((x) => x[1] === false) ? 1 : 0);
}
main().catch((e) => { console.error(String((e as Error).message).slice(0, 200)); process.exit(1); });
