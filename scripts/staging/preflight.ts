/**
 * Hosted-staging preflight. Read-only: checks configuration by NAME and shape, then probes the
 * deployment (Supabase, storage buckets, API, CORS, web/PWA files, Temporal schedules, SMTP).
 * It never prints a secret value, never writes to the database, and never sends mail.
 *
 *   npx tsx --env-file=<staging env file> scripts/staging/preflight.ts [--offline]
 *
 * Exit code 1 if anything FAILs. `--offline` checks configuration only (no network).
 * Writes docs/evidence/staging/preflight-<UTC timestamp>.json (names and verdicts only).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const offline = process.argv.includes("--offline");
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
type Row = { area: string; name: string; verdict: "PASS" | "FAIL" | "WARN" | "SKIP"; note?: string };
const rows: Row[] = [];
const add = (area: string, name: string, verdict: Row["verdict"], note?: string) => { rows.push({ area, name, verdict, note }); };
const has = (k: string) => !!env[k]?.trim();
const secretish = /KEY|SECRET|TOKEN|PASS/;

// ---------------------------------------------------------------- 0. guard: right environment
if (env.STAGING_TARGET !== "staging") { console.error("Set STAGING_TARGET=staging. Refusing to probe an unmarked environment."); process.exit(2); }
const urlOf = (k: string) => { try { return new URL(env[k] ?? ""); } catch { return null; } };

// ---------------------------------------------------------------- 1. configuration
const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "APP_URL", "NEXT_PUBLIC_API_URL", "API_PUBLIC_URL", "API_CORS_ORIGINS",
  "TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "ENCRYPTION_KEY", "ADMIN_API_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "SMTP_HOST", "SMTP_PORT", "EMAIL_FROM", "EMAIL_MODE", "EMAIL_ALLOWLIST"];
for (const k of required) add("config", k, has(k) ? "PASS" : "FAIL", has(k) ? (secretish.test(k) ? "set (value hidden)" : undefined) : "missing");
if (!has("SUPABASE_JWT_SECRET")) add("config", "SUPABASE_JWT_SECRET", "WARN", "unset → API verifies tokens via the project's JWKS endpoint (fine for asymmetric-key projects)");
if (!has("TEMPORAL_API_KEY") && /tmprl\.cloud/.test(env.TEMPORAL_ADDRESS ?? "")) add("config", "TEMPORAL_API_KEY", "FAIL", "Temporal Cloud needs an API key");

for (const k of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "APP_URL", "NEXT_PUBLIC_API_URL", "API_PUBLIC_URL"]) {
  const u = urlOf(k);
  if (!u) continue;
  add("safety", `${k} is HTTPS`, u.protocol === "https:" ? "PASS" : "FAIL", u.protocol === "https:" ? undefined : "service workers / Web Push / install need HTTPS");
  if (/localhost|127\.0\.0\.1/.test(u.hostname)) add("safety", `${k} not local`, "FAIL", "points at this machine, not a hosted staging environment");
  if (/(^|[.-])prod(uction)?([.-]|$)/i.test(u.hostname)) add("safety", `${k} not production`, "FAIL", "hostname looks like production");
}
if (env.SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_URL !== env.NEXT_PUBLIC_SUPABASE_URL) add("safety", "Supabase URLs agree", "FAIL", "SUPABASE_URL ≠ NEXT_PUBLIC_SUPABASE_URL");
add("safety", "EMAIL_MODE is not 'all'", env.EMAIL_MODE === "all" ? "FAIL" : ["allowlist", "off"].includes(env.EMAIL_MODE ?? "") ? "PASS" : "FAIL", `EMAIL_MODE=${env.EMAIL_MODE ?? "(unset)"}`);
const allow = (env.EMAIL_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const publicMail = allow.filter((d) => /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|proton|protonmail|aol)\./.test(d) || /^(gmail|yahoo|outlook)\.com$/.test(d));
add("safety", "EMAIL_ALLOWLIST holds test domains only", allow.length === 0 ? "FAIL" : publicMail.length ? "FAIL" : "PASS", publicMail.length ? `contains public mailbox domain(s): ${publicMail.join(", ")}` : `${allow.length} domain(s)`);
const cors = (env.API_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
add("safety", "API_CORS_ORIGINS exact, no wildcard", cors.length && !cors.some((o) => o === "*" || o.includes("*")) ? "PASS" : "FAIL", `${cors.length} origin(s)`);
if (env.APP_URL && cors.length) add("safety", "APP_URL is an allowed CORS origin", urlOf("APP_URL") && cors.includes(urlOf("APP_URL")!.origin) ? "PASS" : "FAIL");
const len = (k: string, n: number) => add("config", `${k} strength`, (env[k]?.length ?? 0) >= n ? "PASS" : "FAIL", `needs ≥ ${n} characters`);
len("ENCRYPTION_KEY", 32); len("ADMIN_API_TOKEN", 32);
if (has("PUSH_RECEIPT_SECRET")) len("PUSH_RECEIPT_SECRET", 32); else add("config", "PUSH_RECEIPT_SECRET", "WARN", "unset → receipts are signed with VAPID_PRIVATE_KEY");
add("config", "VAPID_PUBLIC_KEY shape", /^[A-Za-z0-9_-]{87}$/.test(env.VAPID_PUBLIC_KEY ?? "") ? "PASS" : "FAIL", "expected a 65-byte uncompressed P-256 key, base64url (87 chars)");
add("config", "VAPID_SUBJECT shape", /^(mailto:|https:\/\/)/.test(env.VAPID_SUBJECT ?? "") ? "PASS" : "FAIL");

// ---------------------------------------------------------------- 2. live probes
async function probe() {
  const to = async (label: string, f: () => Promise<void>, area: string) => { try { await f(); } catch (e) { add(area, label, "FAIL", String((e as Error).message).replace(/(eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, "<jwt>").slice(0, 160)); } };
  const fetchT = (u: string, init: RequestInit = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(15_000), redirect: "manual" });
  const sb = env.SUPABASE_URL!, svc = env.SUPABASE_SERVICE_ROLE_KEY!, anon = env.SUPABASE_ANON_KEY!;
  const sbH = { apikey: svc, authorization: `Bearer ${svc}` };

  await to("Auth reachable", async () => { const r = await fetchT(`${sb}/auth/v1/health`, { headers: { apikey: anon } }); add("supabase", "Auth reachable", r.ok ? "PASS" : "FAIL", `HTTP ${r.status}`); }, "supabase");
  // migrations: probe one object introduced by each recent migration (0017 tables, 0018 view, 0019 column)
  for (const [path, label] of [["service_offerings?select=key&limit=1", "0017 service_offerings"], ["service_ops?select=id&limit=1", "0018 service_ops view"], ["notifications?select=receipts&limit=1", "0019 notifications.receipts"], ["plans?select=key&limit=1", "0004 plans seeded"]] as const) {
    await to(label, async () => { const r = await fetchT(`${sb}/rest/v1/${path}`, { headers: sbH }); add("migrations", label, r.ok ? "PASS" : "FAIL", r.ok ? undefined : `HTTP ${r.status} — apply migrations`); }, "migrations");
  }
  await to("offerings seeded", async () => { const r = await fetchT(`${sb}/rest/v1/service_offerings?select=key&active=eq.true`, { headers: sbH }); const j = (await r.json()) as unknown[]; add("migrations", "service offerings seeded", Array.isArray(j) && j.length > 0 ? "PASS" : "FAIL", `${Array.isArray(j) ? j.length : 0} active`); }, "migrations");
  await to("storage buckets", async () => {
    const r = await fetchT(`${sb}/storage/v1/bucket`, { headers: sbH });
    const j = (await r.json()) as Array<{ id: string; public: boolean }>;
    for (const b of ["media", "service-files"]) { const f = Array.isArray(j) ? j.find((x) => x.id === b) : undefined; add("storage", `bucket ${b} exists and is private`, f && !f.public ? "PASS" : "FAIL", !f ? "missing" : f.public ? "PUBLIC — must be private" : undefined); }
  }, "storage");
  await to("anon cannot read private tables", async () => { const r = await fetchT(`${sb}/rest/v1/service_requests?select=id&limit=1`, { headers: { apikey: anon, authorization: `Bearer ${anon}` } }); const j = await r.json().catch(() => null); add("security", "anonymous read of service_requests returns nothing", r.ok && Array.isArray(j) && j.length === 0 || r.status === 401 || r.status === 403 ? "PASS" : "FAIL", `HTTP ${r.status}`); }, "security");

  const api = env.API_PUBLIC_URL!, app = env.APP_URL!;
  await to("API /health", async () => { const r = await fetchT(`${api}/health`); add("api", "GET /health", r.ok ? "PASS" : "FAIL", `HTTP ${r.status}`); }, "api");
  await to("API /health/ready", async () => { const r = await fetchT(`${api}/health/ready`); const j = (await r.json().catch(() => ({}))) as { db?: boolean; temporal?: boolean }; add("api", "GET /health/ready (db + temporal)", r.ok ? "PASS" : "FAIL", `db=${j.db} temporal=${j.temporal}`); }, "api");
  await to("CORS preflight", async () => {
    const origin = new URL(app).origin;
    const ok = await fetchT(`${api}/v1/me/notifications`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    add("api", "CORS allows the web origin", ok.headers.get("access-control-allow-origin") === origin ? "PASS" : "FAIL", `allow-origin=${ok.headers.get("access-control-allow-origin") ?? "(none)"}`);
    const bad = await fetchT(`${api}/v1/me/notifications`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    add("api", "CORS refuses another origin", bad.headers.get("access-control-allow-origin") !== "https://evil.example" && bad.headers.get("access-control-allow-origin") !== "*" ? "PASS" : "FAIL");
  }, "api");
  await to("unauthenticated API", async () => { const r = await fetchT(`${api}/v1/me/notifications`); add("api", "authenticated routes refuse anonymous callers", r.status === 401 ? "PASS" : "FAIL", `HTTP ${r.status}`); }, "api");
  await to("push receipt route", async () => { const r = await fetchT(`${api}/push/receipt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: "x", event: "displayed" }) }); add("api", "/push/receipt rejects a forged token (403)", r.status === 403 ? "PASS" : "FAIL", `HTTP ${r.status}`); }, "api");

  for (const [p, label] of [["/", "app shell"], ["/manifest.webmanifest", "web app manifest"], ["/sw.js", "service worker script"], ["/offline", "offline page"], ["/icons/icon-192.png", "icon 192"], ["/icons/icon-512.png", "icon 512"]] as const) {
    await to(label, async () => { const r = await fetchT(`${app}${p}`); add("web", `${label} (${p})`, r.status === 200 || (p === "/" && [302, 307].includes(r.status)) ? "PASS" : "FAIL", `HTTP ${r.status}`); }, "web");
  }
  await to("sw headers", async () => { const r = await fetchT(`${app}/sw.js`); const ct = r.headers.get("content-type") ?? ""; add("web", "sw.js is served as JavaScript", /javascript/.test(ct) ? "PASS" : "FAIL", ct); }, "web");

  await to("Temporal schedules", async () => {
    const { connectTemporal, temporalConfigFromEnv } = await import("../../packages/jobs/src/client.ts");
    const client = await connectTemporal(temporalConfigFromEnv(env));
    for (const id of ["billing-maintenance", "analytics-daily"]) {
      try { const d = await client.schedule.getHandle(id).describe(); add("temporal", `schedule ${id} exists`, "PASS", d.state.paused ? "PAUSED" : "running"); if (d.state.paused) add("temporal", `schedule ${id} running`, "FAIL", "paused"); }
      catch { add("temporal", `schedule ${id} exists`, "FAIL", "not found — start the worker once (it creates both schedules)"); }
    }
  }, "temporal");

  await to("SMTP", async () => {
    const nm = createRequire(join(root, "packages/integrations/package.json"))("nodemailer") as typeof import("nodemailer");
    const tx = nm.createTransport({ host: env.SMTP_HOST!, port: Number(env.SMTP_PORT ?? 587), secure: env.SMTP_SECURE === "true", ...(env.SMTP_USER && { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }) });
    await tx.verify();   // connects and authenticates; sends nothing
    add("email", "SMTP connect + auth (nothing sent)", "PASS");
  }, "email");
}

(async () => {
  if (offline) add("probes", "network probes", "SKIP", "--offline");
  else await probe();
  const w = Math.max(...rows.map((r) => `${r.area}/${r.name}`.length));
  for (const r of rows) console.log(`${r.verdict.padEnd(4)}  ${`${r.area}/${r.name}`.padEnd(w)}${r.note ? `  — ${r.note}` : ""}`);
  const c = (v: Row["verdict"]) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n${c("PASS")} pass · ${c("WARN")} warn · ${c("FAIL")} fail · ${c("SKIP")} skipped`);
  const out = join(root, "docs/evidence/staging"); mkdirSync(out, { recursive: true });
  const file = join(out, `preflight-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), host: env.APP_URL, offline, rows }, null, 2));
  console.log(`report: ${file}`);
  process.exit(c("FAIL") ? 1 : 0);
})();
