/**
 * Phase 12 end-to-end verification: human-finished services, notifications, holds, security.
 *
 * Drives the real API and the real Supabase (Auth, PostgREST, Storage) over HTTP as five test
 * people, then checks database state through the service role. Writes an evidence file.
 * Safe by construction: every address is @example.test (plus one deliberately non-allowlisted
 * .test address), nothing is sent outside the target, and it refuses to run against anything
 * that isn't explicitly marked local-staging / staging.
 *
 *   E2E_TARGET=local-staging npx tsx --env-file=<env> scripts/e2e/services-staging.ts
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_API_URL,
 * ADMIN_API_TOKEN, MAILPIT_URL (optional), PUSH_MOCK_CERT / PUSH_MOCK_KEY (optional, local only).
 */
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceActivities } from "../../packages/jobs/src/service-activities.ts";
import { createNotifier } from "../../packages/jobs/src/notifier.ts";
import { getServiceClient } from "../../packages/database/src/index.ts";

const env = process.env;
const TARGET = env.E2E_TARGET;
if (TARGET !== "local-staging" && TARGET !== "staging") throw new Error("Set E2E_TARGET=local-staging or staging. Refusing to run against an unmarked environment.");
if (/prod/i.test(env.SUPABASE_URL ?? "") || /prod/i.test(env.NEXT_PUBLIC_API_URL ?? "")) throw new Error("Refusing: this looks like production.");
const SB = env.SUPABASE_URL!, ANON = env.SUPABASE_ANON_KEY!, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY!, API = env.NEXT_PUBLIC_API_URL!, ADMIN = env.ADMIN_API_TOKEN!;
const RUN = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../../docs/evidence/phase12", `${TARGET}-${RUN}`);
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ evidence + assertions
type Step = { n: number; name: string; ok: boolean; detail?: unknown };
const steps: Step[] = [];
const evidence: Record<string, unknown> = {};
let n = 0;
function must(name: string, ok: boolean, detail?: unknown) {
  check(name, ok, detail);
  if (!ok) throw new Error(`setup step failed: ${name}`);
}
function check(name: string, ok: boolean, detail?: unknown) {
  steps.push({ n: ++n, name, ok, ...(detail !== undefined && { detail }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${String(n).padStart(3)} ${name}${ok ? "" : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`);
}
const scrub = (x: string) => x.replace(/token=[A-Za-z0-9._-]+/g, "token=[redacted]").replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/g, "[redacted-jwt]");
const redact = (v: unknown) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (/token|signedUrl|uploadUrl|access|secret|keys/i.test(k) && typeof x === "string" ? "[redacted]" : typeof x === "string" ? scrub(x) : x)));

// ------------------------------------------------------------------ HTTP helpers
async function call(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const admin = (method: string, path: string, body?: unknown) => call(ADMIN, method, path, body);
async function rest(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { apikey: token === SERVICE ? SERVICE : ANON, authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "return=representation", ...(init.headers as object) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const svcGet = async (path: string) => (await rest(SERVICE, path)).body;
async function newUser(label: string, email: string) {
  const password = randomBytes(18).toString("base64url");
  const c = await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: label } }) });
  const created = await c.json();
  if (!c.ok) throw new Error(`create ${label}: ${JSON.stringify(created)}`);
  const s = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const sess = await s.json();
  if (!s.ok) throw new Error(`sign in ${label}: ${JSON.stringify(sess)}`);
  return { id: created.id as string, email, token: sess.access_token as string, label };
}
/** Order-independent comparison (jsonb stores object keys in its own order). */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const days = (iso: string) => (Date.parse(iso) - Date.now()) / 86_400_000;

// ------------------------------------------------------------------ mock push service (local only)
type PushHit = { path: string; auth: string; encoding: string; ttl: string; payload: unknown };
const pushHits: PushHit[] = [];
const browser = createECDH("prime256v1"); browser.generateKeys();
const pushAuth = randomBytes(16);
function decrypt(body: Buffer): string {
  const salt = body.subarray(0, 16), idlen = body[20]!, asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const secret = browser.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync("sha256", secret, pushAuth, Buffer.concat([Buffer.from("WebPush: info\0"), browser.getPublicKey(), asPub]), 32));
  const d = createDecipheriv("aes-128-gcm", Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)), Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
}
let pushPort = 0;
async function startPushMock() {
  if (!env.PUSH_MOCK_CERT || !env.PUSH_MOCK_KEY) return;
  const srv = createServer({ cert: readFileSync(env.PUSH_MOCK_CERT), key: readFileSync(env.PUSH_MOCK_KEY) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let payload: unknown = null;
      try { payload = JSON.parse(decrypt(Buffer.concat(chunks))); } catch (e) { payload = { decryptError: String(e) }; }
      pushHits.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? "").slice(0, 12), encoding: String(req.headers["content-encoding"]), ttl: String(req.headers.ttl), payload });
      res.writeHead(req.url?.includes("gone") ? 410 : 201).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  pushPort = (srv.address() as { port: number }).port;
  return srv;
}

// ------------------------------------------------------------------ the run
async function main() {
  const pushSrv = await startPushMock();
  const PNG = readFileSync(join(here, "../../apps/web/public/icons/icon-192.png"));
  const mail = (who: string) => `${who}+${RUN}@example.test`;

  // people
  const owner = await newUser("Owner", mail("owner"));
  const contrib = await newUser("Contributor", mail("contrib"));
  const manager = await newUser("Manager", mail("manager"));
  const spec = await newUser("Specialist", mail("spec"));
  const spec2 = await newUser("Other specialist", mail("spec2"));
  const outsider = await newUser("Outsider", mail("outsider"));
  const blocked = await newUser("Not allowlisted", `blocked+${RUN}@not-allowlisted.test`);
  evidence.people = [owner, contrib, manager, spec, spec2, outsider, blocked].map((p) => ({ label: p.label, id: p.id, email: p.email }));

  // workspace, brand, approved kit, credits
  const org = await call(owner.token, "POST", "/v1/organizations", { organizationName: `E2E ${RUN}`, workspaceName: "E2E workspace", workspaceSlug: `e2e-${RUN}` });
  must("owner creates a workspace", org.status === 201, org.body);
  const ws = org.body.workspaceId as string;
  const outOrg = await call(outsider.token, "POST", "/v1/organizations", { organizationName: `Other ${RUN}`, workspaceName: "Other", workspaceSlug: `other-${RUN}` });
  const brand = await call(owner.token, "POST", `/v1/workspaces/${ws}/brands`, { name: "Annapurna Tiffins", websiteUrl: "https://annapurna.example.test", languages: ["en"] });
  must("owner creates a brand", brand.status === 201, brand.body);
  const B = brand.body.id as string;
  const kit = await call(owner.token, "GET", `/v1/workspaces/${ws}/brands/${B}/kit`);
  const ops = await call(owner.token, "POST", `/v1/workspaces/${ws}/brands/${B}/kit/ops`, { baseVersion: kit.body.version, ops: [{ op: "set", path: "vocabulary.banned", value: ["cheap"] }, { op: "set_meta", claimsPolicy: "strict" }] });
  const appr = await call(owner.token, "POST", `/v1/workspaces/${ws}/brands/${B}/kit/versions/${ops.body.version}/approve`);
  must("owner approves a Brand Kit", appr.status === 200, appr.body);
  for (const [u, role] of [[contrib, "contributor"], [blocked, "admin"]] as const) {
    const r = await rest(SERVICE, "workspace_members", { method: "POST", body: JSON.stringify({ workspace_id: ws, user_id: u.id, role }) });
    check(`seed member: ${u.label} as ${role}`, r.status === 201, r.body);
  }
  const adj = await admin("POST", `/admin/workspaces/${ws}/credits/adjust`, { amount: 1000, reference: `e2e-${RUN}`, reason: "E2E test credits" });
  must("admin grants 1000 test credits", adj.status === 201, adj.body);
  const wallet0 = (await svcGet(`credits?workspace_id=eq.${ws}&select=balance,held`))[0];
  evidence.wallet_start = wallet0;

  // a draft to finish (seeded: generation needs the AI worker, which isn't part of this test)
  const item = (await rest(SERVICE, "content_items", { method: "POST", body: JSON.stringify({ workspace_id: ws, brand_id: B, type: "blog", channel: "blog", title: "Why office lunch matters", status: "draft", created_by: owner.id }) })).body[0];
  const srcDoc = { format: 1, blocks: [{ id: "b1", kind: "title", text: "Why office lunch matters", origin: "ai" }, { id: "b2", kind: "paragraph", text: "Lunch is important. Lunch is very important for teams.", origin: "ai" }] };
  const ver = (await rest(SERVICE, "content_versions", { method: "POST", body: JSON.stringify({ workspace_id: ws, brand_id: B, content_item_id: item.id, version: 1, origin: "human", body: { format: 1, doc: srcDoc } }) })).body[0];
  must("seed a draft content item (v1) to be finished", !!item?.id && !!ver?.id, { item, ver });
  await rest(SERVICE, `content_items?id=eq.${item.id}`, { method: "PATCH", body: JSON.stringify({ current_version_id: ver.id }) });

  // a reference image through the real upload path (Storage)
  const up = await call(owner.token, "POST", `/v1/workspaces/${ws}/media/upload-url`, { filename: "reference.png", mimeType: "image/png", bytes: PNG.length, brandId: B });
  const put = await fetch(up.body.uploadUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: PNG });
  const fin = await call(owner.token, "POST", `/v1/workspaces/${ws}/media/finalize`, { assetId: up.body.assetId });
  must("reference image uploaded to Storage and finalised", put.ok && fin.status === 200 && fin.body.status === "ready", { put: put.status, fin: redact(fin.body) });
  const refAsset = up.body.assetId as string, refPath = up.body.path as string;

  // service team (admin API only)
  for (const [u, role, name] of [[manager, "manager", "Mira (manager)"], [spec, "specialist", "Sam (specialist)"], [spec2, "specialist", "Sol (specialist)"]] as const) {
    const r = await admin("PUT", "/admin/service-staff", { email: u.email, role, displayName: name, skills: ["writing", "ads"] });
    check(`admin adds ${name}`, r.status === 200, r.body);
  }

  // devices: owner + specialist get (mock) push subscriptions; one dead endpoint to test pruning
  if (pushPort) {
    for (const [u, path] of [[owner, "owner"], [spec, "spec"], [owner, "gone"]] as const) {
      const r = await call(u.token, "POST", "/v1/me/devices", { kind: "webpush", endpoint: `https://localhost:${pushPort}/push/${path}`, keys: { p256dh: browser.getPublicKey().toString("base64url"), auth: pushAuth.toString("base64url") }, label: `e2e ${path}` });
      check(`register push device (${path})`, r.status === 201, r.body);
    }
  }
  const pk = await call(owner.token, "GET", "/v1/me/push-key");
  check("VAPID public key served to browsers", pk.status === 200 && typeof pk.body.publicKey === "string" && pk.body.publicKey.length > 80, pk.body);

  const S = (p: string) => `/v1/workspaces/${ws}/brands/${B}${p}`;
  const reqState = async (id: string) => (await svcGet(`service_requests?id=eq.${id}&select=*`))[0];
  const holds = async (ids: Array<string | null>) => svcGet(`credit_reservations?id=in.(${ids.filter(Boolean).join(",")})&select=id,amount,status,settled_amount,expires_at`);
  const wallet = async () => (await svcGet(`credits?workspace_id=eq.${ws}&select=balance,held`))[0];

  // ============================================================ Flow A: polish a draft, full path
  const draftA = await call(owner.token, "POST", S("/services"), { offeringKey: "polish_draft", title: "Polish: office lunch article", intake: { focus: "Tighten the intro, keep it friendly" }, sourceContentItemId: item.id, referenceAssetIds: [refAsset] });
  check("A1 customer creates a request (draft)", draftA.status === 201 && draftA.body.status === "draft", draftA.body);
  const A = draftA.body.id as string;
  const walletBefore = await wallet();
  const subA = await call(owner.token, "POST", S(`/services/${A}/submit`));
  const rA = await reqState(A);
  const [hA] = await holds([rA.reservation_id]);
  check("A2 submit: brief frozen with brand essentials + source draft", subA.status === 200 && rA.brief?.brand?.name === "Annapurna Tiffins" && rA.brief?.brand?.bannedWords?.includes("cheap") && rA.brief?.source?.text?.includes("Lunch is important"), { status: subA.status, brief: rA.brief && { brand: rA.brief.brand.name, banned: rA.brief.brand.bannedWords, criteria: rA.brief.acceptanceCriteria } });
  check("A3 submit: 25 credits held for ~60 days", hA?.status === "held" && Number(hA.amount) === 25 && days(hA.expires_at) > 59.9 && days(hA.expires_at) < 60.1, hA);
  const wA = await wallet();
  check("A4 wallet: held +25, balance unchanged", Number(wA.held) - Number(walletBefore.held) === 25 && Number(wA.balance) === Number(walletBefore.balance), { before: walletBefore, after: wA });
  evidence.flowA_submit = { response: redact(subA.body), hold: hA, wallet: wA };

  // escalation / IDOR on the real stack
  check("A5 contributor cannot approve", (await call(contrib.token, "POST", S(`/services/${A}/approve`), {})).status === 403);
  check("A6 outsider cannot see the request (404)", (await call(outsider.token, "GET", S(`/services/${A}`))).status === 404);
  check("A7 outsider's own workspace path doesn't reach it either", (await call(outsider.token, "GET", `/v1/workspaces/${outOrg.body.workspaceId}/brands/${B}/services/${A}`)).status === 404);
  check("A8 customer has no service desk (404)", (await call(owner.token, "GET", "/v1/desk/requests")).status === 404);

  const queue = await call(manager.token, "GET", "/v1/desk/requests?scope=queue");
  check("A9 manager sees it in the triage queue", queue.status === 200 && queue.body.data.some((x: { id: string }) => x.id === A), queue.body);
  const team = await call(manager.token, "GET", `/v1/desk/staff?requestId=${A}`);
  check("A10 manager gets specialist suggestions", team.status === 200 && team.body.suggested.includes(spec.id), team.body.suggested);
  const asg = await call(manager.token, "POST", `/v1/desk/requests/${A}/assign`, { userId: spec.id });
  check("A11 manager assigns the specialist", asg.status === 200 && asg.body.status === "assigned", asg.body.status);
  check("A12 another specialist can't open it (404)", (await call(spec2.token, "GET", `/v1/desk/requests/${A}`)).status === 404);
  check("A13 specialist can't assign (403)", (await call(spec.token, "POST", `/v1/desk/requests/${A}/assign`, { userId: spec2.id })).status === 403);
  const descA = await call(spec.token, "GET", `/v1/desk/requests/${A}`);
  check("A14 specialist sees brief, customer draft and a working link to the reference file", descA.status === 200 && !!descA.body.brief && descA.body.sourceDoc?.blocks?.length === 2 && descA.body.references?.[0]?.url, { refs: descA.body.references?.length });
  const refFetch = descA.body.references?.[0]?.url ? await fetch(descA.body.references[0].url) : null;
  check("A15 reference link serves the uploaded bytes", !!refFetch && refFetch.ok && Buffer.from(await refFetch.arrayBuffer()).equals(PNG));

  const startA = await call(spec.token, "POST", `/v1/desk/requests/${A}/start`);
  const dA1 = (await svcGet(`service_deliverables?request_id=eq.${A}&round=eq.1&select=*`))[0];
  check("A16 start: round 1 begins from the customer's draft", startA.status === 200 && canon(dA1?.doc) === canon(srcDoc), { status: startA.status });
  const polished = { format: 1, blocks: [{ id: "b1", kind: "title", text: "Why office lunch matters", origin: "human" }, { id: "b2", kind: "paragraph", text: "A good lunch keeps teams sharp through the afternoon.", origin: "human" }] };
  await call(spec.token, "PUT", `/v1/desk/requests/${A}/deliverable`, { doc: polished, note: "Here is the polished version, with a cover image." });
  const fileReq = await call(spec.token, "POST", `/v1/desk/requests/${A}/files`, { name: "cover.png", mime: "image/png", size: PNG.length });
  const fileUp = await fetch(fileReq.body.signedUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: PNG });
  const conf = await call(spec.token, "POST", `/v1/desk/requests/${A}/files/confirm`, { path: fileReq.body.path, name: "cover.png", mime: "image/png", size: PNG.length });
  check("A17 specialist uploads a file to private Storage and attaches it", fileReq.status === 201 && fileUp.ok && conf.status === 200, { req: fileReq.status, put: fileUp.status, confirm: conf.status });
  const fakeConf = await call(spec.token, "POST", `/v1/desk/requests/${A}/files/confirm`, { path: `${A}/r1/never-uploaded.png`, name: "x.png", mime: "image/png", size: 10 });
  check("A18 attaching a file that was never uploaded is refused", fakeConf.status === 422, fakeConf.body);
  const hand1 = await call(spec.token, "POST", `/v1/desk/requests/${A}/submit`);
  check("A19 hand-in goes to QA", hand1.status === 200 && hand1.body.status === "in_review", hand1.body.status);

  // what the customer can read *directly* (bypassing the API) while work is in QA
  const ownerView = await call(owner.token, "GET", S(`/services/${A}`));
  check("A20 customer view: 'Being worked on', no deliverable yet, no QA step, no hold id, no assignee", ownerView.body.stage === "Being worked on" && ownerView.body.deliverables.length === 0 && !ownerView.body.events.some((e: { to_status: string }) => e.to_status === "in_review") && !("reservation_id" in ownerView.body) && !("assignee_id" in ownerView.body), { stage: ownerView.body.stage, events: ownerView.body.events.map((e: { kind: string; to_status: string }) => `${e.kind}:${e.to_status ?? ""}`) });
  const leak1 = await rest(owner.token, `service_requests?id=eq.${A}&select=reservation_id,assignee_id`);
  check("A21 REST: customer can't read hold ids or assignee (column privileges)", leak1.status >= 400, leak1);
  const leak2 = await rest(owner.token, `service_deliverables?request_id=eq.${A}&select=id,status`);
  check("A22 REST: customer can't see work in progress", leak2.status === 200 && leak2.body.length === 0, leak2.body);
  const leak3 = await rest(owner.token, `service_events?request_id=eq.${A}&select=kind,to_status,visibility`);
  check("A23 REST: customer timeline has no internal entries", leak3.status === 200 && leak3.body.every((e: { visibility: string }) => e.visibility === "all") && !leak3.body.some((e: { to_status: string }) => e.to_status === "in_review"), leak3.body);
  const leak4 = await rest(owner.token, "service_ops?select=id");
  check("A24 REST: customer can't read the ops view", leak4.status >= 400, leak4.status);
  const sfDl = await fetch(`${SB}/storage/v1/object/authenticated/service-files/${fileReq.body.path}`, { headers: { apikey: ANON, authorization: `Bearer ${owner.token}` } });
  check("A25 Storage: customer can't download work-in-progress files", !sfDl.ok, sfDl.status);
  const sfDl2 = await fetch(`${SB}/storage/v1/object/authenticated/service-files/${fileReq.body.path}`, { headers: { apikey: ANON, authorization: `Bearer ${spec.token}` } });
  check("A26 Storage: even the specialist reads service files only through API links", !sfDl2.ok, sfDl2.status);
  const mediaDl = await fetch(`${SB}/storage/v1/object/authenticated/media/${refPath}`, { headers: { apikey: ANON, authorization: `Bearer ${spec.token}` } });
  check("A27 Storage: specialist can't read the customer's media library", !mediaDl.ok, mediaDl.status);
  for (const t of ["brands", "content_items", "media_assets", "credit_reservations", "workspace_members", "audit_logs"]) {
    const r = await rest(spec.token, `${t}?select=*&limit=5`);
    check(`A28 REST: specialist reads nothing from ${t}`, r.status === 200 && r.body.length === 0, { status: r.status, rows: r.body?.length });
  }
  const specReqs = await rest(spec2.token, "service_requests?select=id");
  check("A29 REST: unassigned specialist sees no requests", specReqs.status === 200 && specReqs.body.length === 0, specReqs.body);
  const forge = await rest(owner.token, `service_requests?id=eq.${A}`, { method: "PATCH", body: JSON.stringify({ status: "approved" }) });
  check("A30 REST: customer can't change service state directly", forge.status >= 400 || (Array.isArray(forge.body) && forge.body.length === 0), forge);
  const promote = await rest(spec.token, `service_staff?user_id=eq.${spec.id}`, { method: "PATCH", body: JSON.stringify({ role: "manager" }) });
  check("A31 REST: specialist can't promote themselves", promote.status >= 400 || (Array.isArray(promote.body) && promote.body.length === 0), promote);

  // QA returns it (internal), then approves
  await call(manager.token, "POST", `/v1/desk/requests/${A}/messages`, { body: "INTERNAL-ONLY: customer prefers short paragraphs", internal: true });
  const ret = await call(manager.token, "POST", `/v1/desk/requests/${A}/qa`, { decision: "return", note: "QA-INTERNAL: intro still wordy" });
  check("A32 QA returns the work with an internal note", ret.status === 200 && ret.body.status === "in_progress", ret.body.status);
  await call(spec.token, "PUT", `/v1/desk/requests/${A}/deliverable`, { doc: polished, note: "Here is the polished version, with a cover image." });
  await call(spec.token, "POST", `/v1/desk/requests/${A}/submit`);
  const qaOk = await call(manager.token, "POST", `/v1/desk/requests/${A}/qa`, { decision: "approve" });
  check("A33 QA approves → delivered to the customer", qaOk.status === 200 && qaOk.body.status === "delivered", qaOk.body.status);
  const delView = await call(owner.token, "GET", S(`/services/${A}`));
  const fileUrl = delView.body.deliverables?.[0]?.files?.[0]?.url;
  const fileDl = fileUrl ? await fetch(fileUrl) : null;
  check("A34 customer sees the delivery and can download the file via its signed link", delView.body.stage === "Ready for your review" && !!fileDl?.ok && Buffer.from(await fileDl!.arrayBuffer()).equals(PNG));
  check("A35 the delivery carries no QA note", !JSON.stringify(delView.body).includes("QA-INTERNAL") && !JSON.stringify(delView.body).includes("INTERNAL-ONLY"));

  // revision 1 (included), revision 2 (paid)
  const rev1 = await call(owner.token, "POST", S(`/services/${A}/revise`), { note: "Please make the title punchier" });
  check("A36 first revision is included (no extra hold)", rev1.status === 200 && rev1.body.charged === 0 && (await reqState(A)).extra_reservation_ids.length === 0, rev1.body);
  await call(spec.token, "POST", `/v1/desk/requests/${A}/start`);
  const r2doc = { ...polished, blocks: [{ ...polished.blocks[0], text: "Office lunch: the afternoon advantage" }, polished.blocks[1]] };
  await call(spec.token, "PUT", `/v1/desk/requests/${A}/deliverable`, { doc: r2doc, note: "New title as requested." });
  await call(spec.token, "POST", `/v1/desk/requests/${A}/submit`);
  await call(manager.token, "POST", `/v1/desk/requests/${A}/qa`, { decision: "approve" });
  const rev2 = await call(owner.token, "POST", S(`/services/${A}/revise`), { note: "One more: add a call to action" });
  const rA2 = await reqState(A);
  const [hx] = await holds(rA2.extra_reservation_ids);
  check("A37 second revision is paid: an extra 5-credit hold", rev2.status === 200 && rev2.body.charged === 5 && hx?.status === "held" && Number(hx.amount) === 5, { body: rev2.body, hold: hx });
  await call(spec.token, "POST", `/v1/desk/requests/${A}/start`);
  const finalDoc = { ...r2doc, blocks: [...r2doc.blocks, { id: "b3", kind: "cta", text: "Book a free tasting week.", origin: "human" }] };
  await call(spec.token, "PUT", `/v1/desk/requests/${A}/deliverable`, { doc: finalDoc, note: "Added a call to action." });
  await call(spec.token, "POST", `/v1/desk/requests/${A}/submit`);
  await call(manager.token, "POST", `/v1/desk/requests/${A}/qa`, { decision: "approve" });

  // approval → content version + media asset + charge
  const wBeforeApprove = await wallet();
  const apA = await call(owner.token, "POST", S(`/services/${A}/approve`), { rating: 5, feedback: "Great work" });
  check("A38 customer approves", apA.status === 200 && apA.body.status === "approved", apA.body);
  const itemAfter = (await svcGet(`content_items?id=eq.${item.id}&select=current_version_id`))[0];
  const newVer = (await svcGet(`content_versions?id=eq.${itemAfter.current_version_id}&select=version,origin,transform,body,base_version`))[0];
  check("A39 approved text is a new version of the original draft (v2, human, transform=service)", newVer.version === 2 && newVer.origin === "human" && newVer.transform === "service" && canon(newVer.body.doc) === canon(finalDoc), { version: newVer.version, origin: newVer.origin, transform: newVer.transform });
  const assets = await svcGet(`media_assets?workspace_id=eq.${ws}&source=eq.service&select=id,storage_path,status,mime_type,title`);
  const assetObj = assets[0] ? await fetch(`${SB}/storage/v1/object/authenticated/media/${assets[0].storage_path}`, { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } }) : null;
  check("A40 approved file is in the media library (source=service) and stored in the media bucket", assets.length === 1 && assets[0].status === "ready" && !!assetObj?.ok && Buffer.from(await assetObj!.arrayBuffer()).equals(PNG), assets);
  const settled = await holds([rA2.reservation_id, ...rA2.extra_reservation_ids]);
  check("A41 both holds settled (25 + 5)", settled.every((h: { status: string }) => h.status === "settled") && settled.reduce((t: number, h: { settled_amount: number }) => t + Number(h.settled_amount), 0) === 30, settled);
  const wAfter = await wallet();
  check("A42 wallet: balance −30, held −30", Number(wBeforeApprove.balance) - Number(wAfter.balance) === 30 && Number(wBeforeApprove.held) - Number(wAfter.held) === 30, { before: wBeforeApprove, after: wAfter });
  evidence.flowA_final = { request: await reqState(A), holds: settled, wallet: wAfter, version: { version: newVer.version, transform: newVer.transform }, asset: assets[0] };

  // ============================================================ Flow B: cancel before work starts
  const draftB = await call(owner.token, "POST", S("/services"), { offeringKey: "expert_article", title: "Article: tiffin plans explained", intake: { topic: "How our tiffin plans work" } });
  const B_ = draftB.body.id as string;
  const wB0 = await wallet();
  await call(owner.token, "POST", S(`/services/${B_}/submit`));
  const rB = await reqState(B_);
  await call(manager.token, "POST", `/v1/desk/requests/${B_}/assign`, { userId: spec.id });
  const can = await call(owner.token, "POST", S(`/services/${B_}/cancel`));
  const [hB] = await holds([rB.reservation_id]);
  const wB1 = await wallet();
  check("B1 cancel after assignment (before work) is allowed", can.status === 200 && can.body.status === "cancelled", can.body);
  check("B2 the full 120-credit hold is released; wallet back to where it was", hB.status === "released" && Number(wB1.held) === Number(wB0.held) && Number(wB1.balance) === Number(wB0.balance), { hold: hB, before: wB0, after: wB1 });
  const B2 = await call(owner.token, "POST", S("/services"), { offeringKey: "expert_article", title: "Article started", intake: { topic: "x" } });
  await call(owner.token, "POST", S(`/services/${B2.body.id}/submit`));
  await call(manager.token, "POST", `/v1/desk/requests/${B2.body.id}/assign`, { userId: spec.id });
  await call(spec.token, "POST", `/v1/desk/requests/${B2.body.id}/start`);
  check("B3 cancel is refused once work has started", (await call(owner.token, "POST", S(`/services/${B2.body.id}/cancel`))).status === 409);

  // ============================================================ Flow C: holds extended, then lost and re-held; overdue
  const db = getServiceClient({ url: SB, anonKey: ANON, serviceRoleKey: SERVICE });
  const notifier = createNotifier({ db, appUrl: env.APP_URL });
  const upkeep = createServiceActivities({ db, notifier, appUrl: env.APP_URL });
  const C = (await call(owner.token, "POST", S("/services"), { offeringKey: "ad_review", title: "Review: Diwali ad", intake: { campaign: "Diwali search ads" } })).body.id as string;
  await call(owner.token, "POST", S(`/services/${C}/submit`));
  await call(manager.token, "POST", `/v1/desk/requests/${C}/assign`, { userId: spec.id });
  const rC = await reqState(C);
  await rest(SERVICE, `credit_reservations?id=eq.${rC.reservation_id}`, { method: "PATCH", body: JSON.stringify({ expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString() }) });
  const m1 = await upkeep.serviceMaintenance();
  const [hC1] = await holds([rC.reservation_id]);
  check("C1 upkeep extends a hold about to expire (to ~30 days)", m1.extended >= 1 && days(hC1.expires_at) > 29.9, { result: m1, hold: hC1 });
  await rest(SERVICE, `credit_reservations?id=eq.${rC.reservation_id}`, { method: "PATCH", body: JSON.stringify({ expires_at: new Date(Date.now() - 60_000).toISOString() }) });
  const exp = await rest(SERVICE, "rpc/expire_stale_reservations", { method: "POST", body: "{}" });
  const [hC2] = await holds([rC.reservation_id]);
  check("C2 the platform's expiry job expires an overdue hold", exp.status === 200 && hC2.status === "expired", { exp: exp.body, hold: hC2 });
  await rest(SERVICE, `service_requests?id=eq.${C}`, { method: "PATCH", body: JSON.stringify({ due_at: new Date(Date.now() - 3600_000).toISOString() }) });
  const m2 = await upkeep.serviceMaintenance();
  check("C3 upkeep reports the lost hold and the overdue request", m2.lost >= 1 && m2.overdue >= 1, m2);
  const mgrNotes = await svcGet(`notifications?user_id=eq.${manager.id}&kind=in.(staff.hold_lost,staff.overdue)&select=kind,title`);
  check("C4 manager notified: hold lost + overdue", mgrNotes.some((x: { kind: string }) => x.kind === "staff.hold_lost") && mgrNotes.some((x: { kind: string }) => x.kind === "staff.overdue"), mgrNotes);
  const m3 = await upkeep.serviceMaintenance();
  const mgrNotes2 = await svcGet(`notifications?user_id=eq.${manager.id}&kind=in.(staff.hold_lost,staff.overdue)&select=kind`);
  check("C5 running upkeep again sends no duplicates", mgrNotes2.length === mgrNotes.length, { first: mgrNotes.length, second: mgrNotes2.length, m3 });
  await call(spec.token, "POST", `/v1/desk/requests/${C}/start`);
  await call(spec.token, "PUT", `/v1/desk/requests/${C}/deliverable`, { doc: { format: 1, blocks: [{ id: "b1", kind: "paragraph", text: "Headline 3 uses a superlative; add proof or drop it.", origin: "human" }] }, note: "Review attached." });
  const handC = await call(spec.token, "POST", `/v1/desk/requests/${C}/submit`);
  check("C6 an offering without QA delivers straight to the customer", handC.body.status === "delivered", handC.body.status);
  const wC0 = await wallet();
  const apC = await call(owner.token, "POST", S(`/services/${C}/approve`), {});
  const rC2 = await reqState(C);
  const recharge = await svcGet(`credit_reservations?workspace_id=eq.${ws}&idempotency_key=eq.service:${C}:recharge:base&select=id,amount,status,settled_amount`);
  const wC1 = await wallet();
  check("C7 approval re-holds the expired credits, then charges them (30)", apC.status === 200 && rC2.status === "approved" && recharge[0]?.status === "settled" && Number(recharge[0].settled_amount) === 30 && Number(wC0.balance) - Number(wC1.balance) === 30, { approve: apC.status, recharge, before: wC0, after: wC1 });

  // ============================================================ Flow D: 3-day "waiting for your review" reminders (real DB, real notifier)
  const D = (await call(owner.token, "POST", S("/services"), { offeringKey: "ad_review", title: "Review: Navratri ad", intake: { campaign: "Navratri display ads" } })).body.id as string;
  await call(owner.token, "POST", S(`/services/${D}/submit`));
  await call(manager.token, "POST", `/v1/desk/requests/${D}/assign`, { userId: spec.id });
  await call(spec.token, "POST", `/v1/desk/requests/${D}/start`);
  await call(spec.token, "PUT", `/v1/desk/requests/${D}/deliverable`, { doc: { format: 1, blocks: [{ id: "b1", kind: "paragraph", text: "Swap the stock photo for a product shot.", origin: "human" }] }, note: "Done." });
  const handD = await call(spec.token, "POST", `/v1/desk/requests/${D}/submit`);
  const awaiting = async () => (await svcGet(`notifications?user_id=eq.${owner.id}&kind=eq.customer.awaiting_approval&select=id,title,body,link,data,dedupe_key`)).filter((n: { dedupe_key: string | null }) => n.dedupe_key?.startsWith(`awaiting:${D}:`));
  const ago = (d: number) => new Date(Date.now() - d * 86_400_000 - 3600_000).toISOString();
  await rest(SERVICE, `service_requests?id=eq.${D}`, { method: "PATCH", body: JSON.stringify({ delivered_at: ago(1) }) });
  await upkeep.serviceMaintenance();
  check("D1 delivered 1 day ago → no reminder yet", handD.body.status === "delivered" && (await awaiting()).length === 0, handD.body.status);
  await rest(SERVICE, `service_requests?id=eq.${D}`, { method: "PATCH", body: JSON.stringify({ delivered_at: ago(4) }) });
  const d2 = await upkeep.serviceMaintenance();
  const aw1 = await awaiting();
  check("D2 waiting 4 days → one reminder to the customer", d2.reminded >= 1 && aw1.length === 1 && /Waiting for your review/.test(aw1[0].title), { result: d2, notes: aw1.map((n: { title: string }) => n.title) });
  await upkeep.serviceMaintenance(); await upkeep.serviceMaintenance();
  check("D3 running upkeep again (idempotent) sends no duplicate", (await awaiting()).length === 1, (await awaiting()).length);
  await rest(SERVICE, `service_requests?id=eq.${D}`, { method: "PATCH", body: JSON.stringify({ delivered_at: ago(7) }) });
  await upkeep.serviceMaintenance();
  check("D4 still waiting at 7 days → a second reminder (every 3 days)", (await awaiting()).length === 2, (await awaiting()).map((n: { body: string }) => n.body));
  check("D5 reminder deep-links into the request and leaks nothing internal", (await awaiting()).every((n: { link: string; title: string; body: string }) => n.link.includes(D) && !/INTERNAL|QA-|hold/i.test(n.title + n.body)), (await awaiting())[0]?.link);
  evidence.flowD_reminders = await awaiting();

  // ============================================================ mobile-ready endpoints on the real stack
  const inbox = await call(owner.token, "GET", `/v1/workspaces/${ws}/inbox`);
  check("M1 inbox responds with per-kind counts", inbox.status === 200 && typeof inbox.body.counts?.serviceDeliveries === "number", inbox.body?.counts ?? inbox.body);
  const agenda = await call(owner.token, "GET", `/v1/workspaces/${ws}/agenda?limit=10`);
  check("M2 agenda responds (cursor paging)", agenda.status === 200 && Array.isArray(agenda.body.data) && "next_cursor" in agenda.body, agenda.body);
  const pstat = await call(owner.token, "GET", `/v1/workspaces/${ws}/publishing/status?status=failed`);
  check("M3 publishing status responds", pstat.status === 200 && Array.isArray(pstat.body.data), pstat.body);
  const qc = await call(contrib.token, "GET", `/v1/workspaces/${ws}/quick-create/options`);
  check("M4 quick-create options: brand ready, prices listed", qc.status === 200 && qc.body.brands[0]?.ready === true && qc.body.types.length > 0, qc.body?.brands);
  const feed = await call(owner.token, "GET", "/v1/me/notifications?limit=50");
  check("M5 notification feed with unread count", feed.status === 200 && feed.body.unread > 0, { unread: feed.body?.unread });
  const read = await call(owner.token, "POST", "/v1/me/notifications/read", { all: true });
  const feed2 = await call(owner.token, "GET", "/v1/me/notifications?unread=1");
  check("M6 mark all read", read.status === 200 && feed2.body.unread === 0, { updated: read.body, unread: feed2.body?.unread });
  const deskList = await call(manager.token, "GET", "/v1/desk/requests?scope=all");
  check("M7 desk list (all) responds with brand names", deskList.status === 200 && deskList.body.data.every((x: { brandName: string }) => x.brandName === "Annapurna Tiffins"), deskList.body.data?.length);

  // ============================================================ ops view + audit trail
  const opsMgr = await call(manager.token, "GET", "/v1/desk/ops");
  check("O1 manager ops view: workload, SLA and holds", opsMgr.status === 200 && Array.isArray(opsMgr.body.workload) && "creditsHeld" in opsMgr.body.totals, opsMgr.body.totals);
  check("O2 specialist can't open ops (403)", (await call(spec.token, "GET", "/v1/desk/ops")).status === 403);
  check("O3 admin ops endpoint works with the admin token only", (await admin("GET", "/admin/service-ops")).status === 200 && (await call(owner.token, "GET", "/admin/service-ops")).status === 404);
  evidence.ops = opsMgr.body.totals;
  const audit = await svcGet(`audit_logs?entity_type=eq.service_requests&entity_id=eq.${A}&select=action,actor_id,actor_type,created_at&order=id.asc`);
  const statusActions = audit.filter((x: { action: string }) => x.action.startsWith("service.status:")).map((x: { action: string }) => x.action.replace("service.status:", ""));
  check("AU1 every Flow A transition is in the audit log", ["submitted", "assigned", "in_progress", "in_review", "delivered", "revision_requested", "approved"].every((s) => statusActions.includes(s)), statusActions);
  const actorOf = (s: string) => audit.find((x: { action: string }) => x.action === `service.status:${s}`)?.actor_id;
  check("AU2 each transition is attributed to the person who made it", actorOf("submitted") === owner.id && actorOf("assigned") === manager.id && actorOf("in_progress") === spec.id && actorOf("delivered") === manager.id && actorOf("approved") === owner.id, { submitted: actorOf("submitted"), assigned: actorOf("assigned"), started: actorOf("in_progress"), delivered: actorOf("delivered"), approved: actorOf("approved") });
  check("AU3 holds, charges, files and assignments are audited too", ["service.hold", "service.charge", "service.file_added", "service.assigned"].every((a) => audit.some((x: { action: string }) => x.action === a)), audit.map((x: { action: string }) => x.action));
  const auditC = await svcGet(`audit_logs?entity_id=eq.${C}&select=action&order=id.asc`);
  check("AU4 hold extension and loss are audited (system actor)", auditC.some((x: { action: string }) => x.action === "service.hold_extended") && auditC.some((x: { action: string }) => x.action === "service.hold_lost"), auditC.map((x: { action: string }) => x.action));
  evidence.audit_flowA = audit;

  // ============================================================ notifications: in-app, push, email; no leakage
  await new Promise((r) => setTimeout(r, 1500));
  const ownerNotes = await svcGet(`notifications?user_id=eq.${owner.id}&select=kind,title,body,audience,delivery&order=created_at.asc`);
  const kinds = new Set(ownerNotes.map((x: { kind: string }) => x.kind));
  check("N1 customer got: received, assigned, delivered, approved, cancelled", ["customer.received", "customer.assigned", "customer.delivered", "customer.approved", "customer.cancelled"].every((k) => kinds.has(k)), [...kinds]);
  const specNotes = await svcGet(`notifications?user_id=eq.${spec.id}&select=kind&order=created_at.asc`);
  const sk = new Set(specNotes.map((x: { kind: string }) => x.kind));
  check("N2 specialist got: assigned, QA returned, revision requested, approved, cancelled, overdue", ["staff.assigned", "staff.qa_returned", "staff.revision_requested", "staff.approved", "staff.cancelled", "staff.overdue"].every((k) => sk.has(k)), [...sk]);
  const allCustomerText = JSON.stringify(await svcGet(`notifications?audience=eq.customer&workspace_id=eq.${ws}&select=title,body,data`));
  const secrets = ["QA-INTERNAL", "INTERNAL-ONLY", "Sam (specialist)", rA.reservation_id, rA2.extra_reservation_ids[0]];
  check("N3 no customer notification contains QA notes, internal notes, staff names or hold ids", secrets.every((s) => !allCustomerText.includes(s)), secrets.filter((s) => allCustomerText.includes(s)));
  if (pushPort) {
    const ownerPush = pushHits.filter((h) => h.path.endsWith("/owner"));
    check("P1 push: the customer's device received encrypted, VAPID-signed pushes that decrypt", ownerPush.length >= 5 && ownerPush.every((h) => h.encoding === "aes128gcm" && h.auth.startsWith("vapid t=") && typeof (h.payload as { title?: string }).title === "string"), ownerPush.map((h) => (h.payload as { title?: string }).title));
    check("P2 push payloads carry no internal text either", !JSON.stringify(ownerPush).match(/QA-INTERNAL|INTERNAL-ONLY|Sam \(specialist\)/));
    const gone = await svcGet(`user_devices?user_id=eq.${owner.id}&select=endpoint`);
    check("P3 a dead push endpoint (410) is removed automatically", !gone.some((d: { endpoint: string }) => d.endpoint.endsWith("/gone")) && gone.some((d: { endpoint: string }) => d.endpoint.endsWith("/owner")), gone);
    check("P4 delivery outcome recorded on the notification", ownerNotes.some((x: { delivery: { push?: Array<{ ok: boolean }> } }) => x.delivery?.push?.some((p) => p.ok)), ownerNotes.map((x: { delivery: unknown }) => x.delivery).slice(0, 2));
    evidence.push = pushHits.map((h) => ({ device: h.path.split("/").pop(), encoding: h.encoding, ttl: h.ttl, title: (h.payload as { title?: string }).title }));
  }
  if (env.MAILPIT_URL) {
    const list = await (await fetch(`${env.MAILPIT_URL}/api/v1/messages?limit=200`)).json();
    const msgs = (list.messages ?? []).filter((m: { To: Array<{ Address: string }> }) => m.To.some((t) => t.Address.includes(RUN)));
    const to = (addr: string) => msgs.filter((m: { To: Array<{ Address: string }> }) => m.To.some((t) => t.Address === addr)).map((m: { Subject: string }) => m.Subject);
    check("E1 customer emails: received, delivered, approved, cancelled", ["We've got your request", "Ready for your review", "Approved:", "Cancelled:"].every((p) => to(owner.email).some((s: string) => s.startsWith(p))), to(owner.email));
    check("E2 staff emails: new request (manager), assigned + revision (specialist)", to(manager.email).some((s: string) => s.startsWith("New request")) && to(spec.email).some((s: string) => s.startsWith("Assigned to you")) && to(spec.email).some((s: string) => s.startsWith("Revision requested")), { manager: to(manager.email), spec: to(spec.email) });
    check("E3 nothing was emailed to a non-allowlisted address", to(blocked.email).length === 0 && msgs.every((m: { To: Array<{ Address: string }> }) => m.To.every((t) => t.Address.endsWith("@example.test"))), to(blocked.email));
    const blockedNote = (await svcGet(`notifications?user_id=eq.${blocked.id}&kind=eq.customer.delivered&select=delivery`))[0];
    check("E4 the blocked email is recorded as refused, not sent", blockedNote?.delivery?.email?.sent === false && /allowlist/.test(blockedNote.delivery.email.reason), blockedNote?.delivery);
    let bodies = "";
    for (const m of msgs.filter((x: { To: Array<{ Address: string }> }) => x.To.some((t) => t.Address === owner.email))) bodies += JSON.stringify(await (await fetch(`${env.MAILPIT_URL}/api/v1/message/${m.ID}`)).json());
    check("E5 customer email bodies contain no internal notes, staff names or hold ids", secrets.every((s) => !bodies.includes(s)));
    evidence.email = { customer: to(owner.email), manager: to(manager.email), specialist: to(spec.email), blocked: to(blocked.email) };
  }

  pushSrv?.close();
  const failed = steps.filter((s) => !s.ok);
  writeFileSync(join(OUT, "steps.json"), JSON.stringify({ target: TARGET, run: RUN, api: API, supabase: SB, passed: steps.length - failed.length, failed: failed.length, steps: redact(steps) }, null, 2));
  writeFileSync(join(OUT, "evidence.json"), JSON.stringify(redact(evidence), null, 2));
  writeFileSync(join(OUT, "run.env.json"), JSON.stringify({ workspaceId: ws, brandId: B, requests: { A, B: B_, C }, people: evidence.people }, null, 2));
  console.log(`\n${steps.length - failed.length}/${steps.length} passed · evidence in ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
