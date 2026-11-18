/**
 * Real-stack route sweep. Calls EVERY read endpoint of the API (found by scanning the route files)
 * against real Supabase as an owner and as a viewer, plus the write endpoints that don't need
 * background workers or external services. A 5xx is a defect; mocks can't catch PostgREST
 * relationship errors, missing columns or bad RLS interactions, real queries can.
 *
 *   E2E_TARGET=local-staging npx tsx --env-file=<env> scripts/e2e/api-sweep.ts
 *
 * Outputs docs/evidence/api-sweep/<target>-<run>/{routes.json,summary.md}. Creates new users and a new
 * workspace (never touches existing data).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const TARGET = env.E2E_TARGET;
if (TARGET !== "local-staging" && TARGET !== "staging") throw new Error("Set E2E_TARGET=local-staging or staging.");
if (/prod/i.test(env.SUPABASE_URL ?? "") || /prod/i.test(env.NEXT_PUBLIC_API_URL ?? "")) throw new Error("Refusing: looks like production.");
const SB = env.SUPABASE_URL!, ANON = env.SUPABASE_ANON_KEY!, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY!, API = env.NEXT_PUBLIC_API_URL!, ADMIN = env.ADMIN_API_TOKEN!;
const RUN = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const here = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(here, "../../apps/api/src/routes");
const OUT = join(here, "../../docs/evidence/api-sweep", `${TARGET}-${RUN}`);
mkdirSync(OUT, { recursive: true });

async function call(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
async function newUser(label: string, email: string) {
  const password = randomBytes(18).toString("base64url");
  const c = await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: label } }) });
  const created = await c.json();
  const s = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const sess = await s.json();
  if (!s.ok) throw new Error(`sign in ${label}: ${JSON.stringify(sess)}`);
  return { id: created.id as string, token: sess.access_token as string };
}
const svc = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json", prefer: "return=representation" } });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};

/** Every `r.get("…")` etc. in the route files with the file it lives in. */
function scan() {
  const out: Array<{ file: string; method: string; path: string }> = [];
  for (const f of readdirSync(ROUTES_DIR).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(join(ROUTES_DIR, f), "utf8");
    for (const m of src.matchAll(/\br\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) out.push({ file: f, method: m[1]!.toUpperCase(), path: m[2]! });
  }
  return out;
}

async function main() {
  const owner = await newUser("Sweep owner", `owner+${RUN}@example.test`);
  const viewer = await newUser("Sweep viewer", `viewer+${RUN}@example.test`);
  const org = await call(owner.token, "POST", "/v1/organizations", { organizationName: `Sweep ${RUN}`, workspaceName: "Sweep", workspaceSlug: `sweep-${RUN}` });
  const ws = org.body.workspaceId as string;
  const brand = await call(owner.token, "POST", `/v1/workspaces/${ws}/brands`, { name: "Sweep Brand", websiteUrl: "https://sweep.example.test", languages: ["en", "te"] });
  if (brand.status !== 201) throw new Error(`brand create failed: ${JSON.stringify(brand.body)}`);
  const B = brand.body.id as string;
  await svc("workspace_members", { method: "POST", body: JSON.stringify({ workspace_id: ws, user_id: viewer.id, role: "viewer" }) });
  await call(null, "POST", `/admin/workspaces/${ws}/credits/adjust`, { amount: 500, reference: `sweep-${RUN}`, reason: "sweep" }, { authorization: `Bearer ${ADMIN}` });

  // real data for the read endpoints to chew on: kit, a campaign + topic, content with a version, an approval, media
  const kit = await call(owner.token, "GET", `/v1/workspaces/${ws}/brands/${B}/kit`);
  const ops = await call(owner.token, "POST", `/v1/workspaces/${ws}/brands/${B}/kit/ops`, { baseVersion: kit.body.version, ops: [{ op: "set", path: "vocabulary.banned", value: ["cheap"] }, { op: "set_meta", claimsPolicy: "strict" }] });
  await call(owner.token, "POST", `/v1/workspaces/${ws}/brands/${B}/kit/versions/${ops.body.version}/approve`);
  const camp = await call(owner.token, "POST", `/v1/workspaces/${ws}/brands/${B}/campaigns`, { name: "Diwali 2026", goal: "Sell gift boxes", startDate: "2026-11-20", endDate: "2026-12-05", channels: ["instagram"], contentTypes: ["social_post"] });
  const item = (await svc("content_items", { method: "POST", body: JSON.stringify({ workspace_id: ws, brand_id: B, type: "social_post", channel: "instagram", title: "Diwali teaser", status: "draft", created_by: owner.id }) })).body[0];
  const doc = { format: 1, blocks: [{ id: "b1", kind: "hook", text: "Gift boxes your team will love.", origin: "human" }, { id: "b2", kind: "body", text: "Order by 1 Nov.", origin: "human" }] };
  const ver = (await svc("content_versions", { method: "POST", body: JSON.stringify({ workspace_id: ws, brand_id: B, content_item_id: item.id, version: 1, origin: "human", body: { format: 1, doc } }) })).body[0];
  await svc(`content_items?id=eq.${item.id}`, { method: "PATCH", body: JSON.stringify({ current_version_id: ver.id }) });
  const ids = { workspaceId: ws, brandId: B, contentId: item.id, itemId: item.id, campaignId: camp.body?.id ?? "00000000-0000-4000-8000-000000000001" };

  const fill = (p: string) => p.replace(/:(\w+)/g, (_m, k) => (ids as Record<string, string>)[k] ?? "00000000-0000-4000-8000-0000000000aa");
  const routes = scan();
  const rows: Array<{ file: string; method: string; path: string; owner?: number; viewer?: number; note?: string }> = [];
  // paths are relative to the router they are mounted on; /me and /desk are mounted at /v1, everything else under /v1/workspaces[/ws]
  const full = (file: string, p: string): string | null => {
    if (file === "account.ts") return `/v1${p}`;
    if (file === "desk.ts") return `/v1/desk${p}`;
    if (file === "push.ts" || (file === "billing.ts" && /^\/(webhooks|admin)/.test(p))) return null;
    if (file === "mobile.ts" && /^\/(notifications|devices|push-key)/.test(p)) return `/v1/me${p}`;
    if (p.startsWith("/:workspaceId")) return `/v1/workspaces${p}`;
    return `/v1/workspaces/${ws}${p === "/" ? "" : p}`;
  };
  for (const r of routes.filter((x) => x.method === "GET")) {
    const f = full(r.file, r.path);
    if (!f) continue;
    const url = fill(f) + (/calendar|agenda/.test(f) ? "?from=2026-11-01T00:00:00Z&to=2026-12-31T00:00:00Z" : "");
    const o = await call(owner.token, "GET", url);
    const v = await call(viewer.token, "GET", url);
    rows.push({ file: r.file, method: "GET", path: url.replace(ws, "<ws>").replace(B, "<brand>").replace(item.id, "<item>"), owner: o.status, viewer: v.status, ...((o.status >= 500 || v.status >= 500) && { note: JSON.stringify(o.status >= 500 ? o.body : v.body).slice(0, 300) }) });
  }
  const bad = rows.filter((r) => (r.owner ?? 0) >= 500 || (r.viewer ?? 0) >= 500);
  const ok = rows.filter((r) => r.owner === 200).length;

  // writes that need no workers or third parties
  const writes: Array<{ name: string; status: number; ok: boolean; detail?: unknown }> = [];
  const w = async (name: string, p: Promise<{ status: number; body: any }>, expect: number[]) => { const r = await p; writes.push({ name, status: r.status, ok: expect.includes(r.status), ...(!expect.includes(r.status) && { detail: r.body }) }); return r; };
  const B_ = `/v1/workspaces/${ws}/brands/${B}`;
  await w("campaign create", Promise.resolve(camp), [201]);
  await w("campaign update", call(owner.token, "PATCH", `${B_}/campaigns/${ids.campaignId}`, { name: "Diwali 2026 (edited)", revision: camp.body?.revision ?? 0 }), [200]);
  await w("save human version", call(owner.token, "POST", `${B_}/content/${item.id}/versions`, { baseVersion: 1, doc: { ...doc, blocks: [{ ...doc.blocks[0], text: "Gift boxes your whole team will love." }, doc.blocks[1]] } }), [201]);
  await w("banned word blocked by validation", call(owner.token, "POST", `${B_}/content/${item.id}/versions`, { baseVersion: 2, doc: { ...doc, blocks: [{ ...doc.blocks[0], text: "Cheap gift boxes" }, doc.blocks[1]] } }), [201]);
  const validation = (await call(owner.token, "GET", `${B_}/content/${item.id}`)).body?.version?.validation_report;
  writes.push({ name: "validator reports the banned word", status: 200, ok: !!validation && validation.passed === false && JSON.stringify(validation.issues).includes("cheap"), detail: validation?.issues });
  await w("submitting a draft with a banned word is refused by the validator", call(owner.token, "POST", `${B_}/content/${item.id}/submit`, {}), [422]);
  await w("save a clean version", call(owner.token, "POST", `${B_}/content/${item.id}/versions`, { baseVersion: 3, doc }), [201]);
  await w("submit a clean draft for approval", call(owner.token, "POST", `${B_}/content/${item.id}/submit`, {}), [200, 201]);
  const ap = (await call(owner.token, "GET", `${B_}/approvals`)).body?.data?.[0];
  await w("approval is listed", Promise.resolve({ status: ap ? 200 : 404, body: null }), [200]);
  await w("changes requested needs a comment", ap ? call(owner.token, "POST", `${B_}/approvals/${ap.id}/decide`, { decision: "changes_requested" }) : Promise.resolve({ status: 0, body: null }), [422]);
  await w("viewer can't create content", call(viewer.token, "POST", `${B_}/campaigns`, { name: "x", goal: "y" }), [403]);
  await w("collection create", call(owner.token, "POST", `/v1/workspaces/${ws}/media/collections`, { name: "Diwali assets", brandId: B }), [201]);
  await w("api key create + list", call(owner.token, "POST", `/v1/workspaces/${ws}/api-keys`, { name: "ci", scopes: ["content.read"] }), [201]);
  await w("invite beyond the plan's seats is refused (402)", call(owner.token, "POST", `/v1/workspaces/${ws}/invites`, { email: `invitee+${RUN}@example.test`, role: "editor" }), [402]);   // trial plan: 2 seats, both used (owner + viewer) → plan limit enforced
  await w("credits estimate", call(owner.token, "POST", `/v1/workspaces/${ws}/credits/estimate`, { kind: "generate.blog", modelTier: "standard" }), [200]);
  await w("billing page data", call(owner.token, "GET", `/v1/workspaces/${ws}/billing`), [200]);
  await w("ads accounts (read)", call(owner.token, "GET", `/v1/workspaces/${ws}/ads/accounts`), [200]);
  await w("service offerings", call(owner.token, "GET", `/v1/workspaces/${ws}/services/offerings`), [200]);

  const writeBad = writes.filter((x) => !x.ok);
  const result = { target: TARGET, run: RUN, reads: { total: rows.length, ownerOk: ok, serverErrors: bad.length }, writes: { total: writes.length, failed: writeBad.length }, routes: rows, writes_detail: writes };
  writeFileSync(join(OUT, "routes.json"), JSON.stringify(result, null, 2));
  const byStatus = (k: "owner" | "viewer") => rows.reduce<Record<string, number>>((a, r) => { const s = String(r[k]); a[s] = (a[s] ?? 0) + 1; return a; }, {});
  writeFileSync(join(OUT, "summary.md"), `# API sweep ${TARGET} ${RUN}\n\nReads: ${rows.length} endpoints × 2 roles. Owner statuses ${JSON.stringify(byStatus("owner"))}; viewer ${JSON.stringify(byStatus("viewer"))}.\nServer errors (5xx): ${bad.length}\n${bad.map((b) => `- ${b.method} ${b.path}: ${b.note}`).join("\n")}\n\nWrites: ${writes.length - writeBad.length}/${writes.length} as expected.\n${writeBad.map((x) => `- ${x.name}: ${x.status} ${JSON.stringify(x.detail).slice(0, 200)}`).join("\n")}\n`);
  console.log(`reads ${rows.length} (owner 200: ${ok}) · 5xx ${bad.length} · writes ${writes.length - writeBad.length}/${writes.length}`);
  for (const b of bad) console.log(`5xx ${b.path}: ${b.note}`);
  for (const x of writeBad) console.log(`WRITE ${x.name}: ${x.status} ${JSON.stringify(x.detail)?.slice(0, 200)}`);
  process.exit(bad.length || writeBad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
