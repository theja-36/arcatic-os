/**
 * Supabase key / JWT compatibility check, against whatever SUPABASE_URL points at.
 * Proves, with real requests, how the new publishable / secret keys and the project's JWT signing
 * keys behave with this codebase. Never prints a key. Creates (and removes) ONE throw-away auth
 * user only when --create-test-user is passed; without it, it makes read-only requests.
 *
 *   npx tsx --env-file=<env> scripts/staging/supabase-keys-check.ts [--create-test-user]
 *
 * Env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY|SUPABASE_ANON_KEY, SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY
 *      (optional: SUPABASE_JWT_SECRET → legacy HS256 mode, SUPABASE_JWT_ISSUER)
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createJwtVerifier } from "../../apps/api/src/jwt.ts";
import { dbConfigFromEnv, getServiceClient } from "../../packages/database/src/clients.ts";

const env = process.env;
const create = process.argv.includes("--create-test-user");
const rows: Array<{ id: string; ok: boolean | "info"; note?: string }> = [];
const check = (id: string, ok: boolean | "info", note?: string) => { rows.push({ id, ok, note }); console.log(`${ok === "info" ? "INFO" : ok ? "PASS" : "FAIL"}  ${id}${note ? `  — ${note}` : ""}`); };

async function main() {
  const cfg = dbConfigFromEnv(env);
  const { url, anonKey: pub, serviceRoleKey: sec } = cfg;
  const kind = (k: string) => (k.startsWith("sb_publishable_") ? "publishable" : k.startsWith("sb_secret_") ? "secret" : k.split(".").length === 3 ? "legacy-jwt" : "unknown");
  check("K0 key formats", "info", `public=${kind(pub)} privileged=${kind(sec)}`);
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

  // --- privileged key stays server-side and works through supabase-js
  const svc = getServiceClient(cfg);   // the same client the API and worker use
  const plans = await svc.from("plans").select("key").limit(1);
  check("K1 privileged key reads through supabase-js", !plans.error && (plans.data?.length ?? 0) > 0, plans.error?.message);
  const buckets = await svc.storage.listBuckets();
  const priv = (id: string) => buckets.data?.find((b) => b.id === id);
  check("K2 storage buckets media + service-files exist and are private", !!priv("media") && priv("media")!.public === false && !!priv("service-files") && priv("service-files")!.public === false, buckets.error?.message);

  // --- public key can't read private data
  const anon = createClient(url, pub, noSession);
  for (const t of ["users", "service_requests", "notifications", "credit_reservations", "workspace_members"]) {
    const r = await anon.from(t).select("*").limit(1);
    check(`K3 public key reads nothing from ${t}`, (r.data?.length ?? 0) === 0, r.error ? `denied: ${r.error.code}` : "0 rows");
  }
  const up = await anon.storage.from("service-files").list("", { limit: 1 });
  check("K4 public key cannot list service-files", (up.data?.length ?? 0) === 0, up.error?.message ?? "0 objects");

  // --- how the new keys behave on the wire (informational: this is what the SDK sends)
  const raw = (k: string, h: Record<string, string> = {}) => fetch(`${url}/rest/v1/plans?select=key&limit=1`, { headers: { apikey: k, ...h } });
  const asApikey = await raw(sec);
  check("K5 privileged key in the apikey header only", asApikey.ok, `HTTP ${asApikey.status}`);
  const asBearer = await raw(sec, { authorization: `Bearer ${sec}` });
  check("K6 privileged key also sent as Bearer (what supabase-js 2.119 does)", "info", `HTTP ${asBearer.status}`);
  const browser = await raw(sec, { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36" });
  check("K7 privileged key from a browser user-agent (hosted Supabase answers 401; the local gateway does not enforce it)", "info", `HTTP ${browser.status}`);

  // --- JWKS + our verifier
  const jwksRes = await fetch(`${url}/auth/v1/.well-known/jwks.json`);
  const jwks = (await jwksRes.json().catch(() => ({ keys: [] }))) as { keys?: Array<{ alg?: string; kty?: string; kid?: string }> };
  check("K8 JWKS published (asymmetric signing keys active)", !!jwks.keys?.length || !!env.SUPABASE_JWT_SECRET, `${jwks.keys?.length ?? 0} key(s): ${(jwks.keys ?? []).map((k) => k.alg ?? k.kty).join(",")}${env.SUPABASE_JWT_SECRET ? " (legacy HS256 secret also configured)" : ""}`);
  const verify = createJwtVerifier({ supabaseUrl: url, issuer: env.SUPABASE_JWT_ISSUER || undefined, hs256Secret: env.SUPABASE_JWT_SECRET || undefined });
  check("K9 verifier refuses the public key", (await verify(pub)) === null);
  check("K10 verifier refuses the privileged key", (await verify(sec)) === null);

  if (!create) { console.log("\n(user-token checks skipped: pass --create-test-user)"); return; }

  // --- a real user token end to end
  const email = `keys-check-${randomBytes(4).toString("hex")}@example.test`, password = randomBytes(18).toString("base64url");
  const made = await svc.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error || !made.data.user) { check("K11 create throw-away user", false, made.error?.message); return; }
  const uid = made.data.user.id;
  try {
    const login = await createClient(url, pub, noSession).auth.signInWithPassword({ email, password });
    const token = login.data.session?.access_token;
    check("K11 user signs in with the public key", !!token, login.error?.message);
    if (!token) return;
    const hdr = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
    const pl = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    check("K12 token header/claims", "info", `alg=${hdr.alg} kid=${hdr.kid ? "yes" : "no"} iss=${pl.iss} aud=${pl.aud} role=${pl.role} exp_in=${Math.round((pl.exp * 1000 - Date.now()) / 60000)}min`);
    check("K13 our verifier accepts the user token", (await verify(token))?.sub === uid);
    check("K14 …and rejects it with a tampered payload", (await verify(`${token.split(".")[0]}.${Buffer.from(JSON.stringify({ ...pl, sub: "00000000-0000-4000-8000-000000000000" })).toString("base64url")}.${token.split(".")[2]}`)) === null);
    // user client exactly as the API builds it: publishable apikey + user Bearer
    const uc = createClient(url, pub, { ...noSession, global: { headers: { Authorization: `Bearer ${token}` } } });
    const me = await uc.from("users").select("id,email").eq("id", uid).maybeSingle();
    check("K15 user client (public key + user token) reads its own row under RLS", me.data?.id === uid, me.error?.message);
    const others = await uc.from("users").select("id").neq("id", uid).limit(5);
    check("K16 …and sees no other user", (others.data?.length ?? 0) === 0, others.error?.message ?? "0 rows");
    const sr = await uc.from("service_requests").select("id").limit(5);
    check("K17 …and no service requests from other tenants", (sr.data?.length ?? 0) === 0, sr.error?.message ?? "0 rows");
    // the web app's server-side session handling (middleware): @supabase/ssr with the public key
    const ssr = createRequire(new URL("../../apps/web/package.json", import.meta.url).pathname)("@supabase/ssr") as typeof import("@supabase/ssr");
    const jar = new Map<string, string>();
    const web = ssr.createServerClient(url, pub, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (l: Array<{ name: string; value: string }>) => l.forEach((c) => jar.set(c.name, c.value)) } });
    const wl = await web.auth.signInWithPassword({ email, password });
    const wu = await web.auth.getUser();
    check("K20 web middleware path: @supabase/ssr + public key signs in and getUser() validates server-side", !wl.error && wu.data.user?.id === uid, wl.error?.message ?? wu.error?.message);
    await web.auth.signOut();
    check("K21 after sign-out the server no longer returns a user", (await web.auth.getUser()).data.user === null);
  } finally {
    await svc.auth.admin.deleteUser(uid);
    const gone = await svc.from("users").select("id").eq("id", uid).maybeSingle();
    check("K19 throw-away user removed", !gone.data);
  }
}
main().then(() => { const f = rows.filter((r) => r.ok === false); console.log(`\n${rows.filter((r) => r.ok === true).length} pass · ${f.length} fail`); process.exit(f.length ? 1 : 0); }).catch((e) => { console.error(String((e as Error).message).slice(0, 300)); process.exit(1); });
