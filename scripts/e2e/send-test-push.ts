/**
 * Send one real test notification (in-app + Web Push + email when allowlisted) to a person, through
 * the same notifier the API uses. For checking a real browser / phone after it subscribed via
 * "Get push notifications on this device".
 *
 *   E2E_TARGET=local-staging npx tsx --env-file=<env> scripts/e2e/send-test-push.ts owner@example.test [requestId] [label]
 *
 * With a request id the notice is about that real request, so tapping it exercises the real
 * deep link (/m/<workspace>?tab=inbox&service=<request>&brand=<brand>).
 */
import { customerNotice } from "../../packages/core/src/index.ts";
import { getServiceClient } from "../../packages/database/src/index.ts";
import { mailerFromEnv, pushFromEnv } from "../../packages/integrations/src/index.ts";
import { createNotifier } from "../../packages/jobs/src/notifier.ts";

const env = process.env;
if (env.E2E_TARGET !== "local-staging" && env.E2E_TARGET !== "staging") throw new Error("Set E2E_TARGET=local-staging or staging.");
const email = process.argv[2];
const requestId = process.argv[3];
const label = process.argv[4] ?? "Push test from Arcatic";
if (!email?.endsWith("@example.test")) throw new Error("Pass a test address ending in @example.test.");

async function main() {
  const db = getServiceClient({ url: env.SUPABASE_URL!, anonKey: (env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY)!, serviceRoleKey: (env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY)! });
  const push = pushFromEnv();
  if (!push) throw new Error("VAPID keys are not configured.");
  const u = await db.from("users").select("id").eq("email", email).single();
  if (u.error) throw new Error(`no such user: ${email}`);
  const devices = await db.from("user_devices").select("endpoint").eq("user_id", u.data.id).eq("kind", "webpush");
  console.log(`devices: ${(devices.data ?? []).map((d) => new URL(d.endpoint).host).join(", ") || "none — subscribe in the app first"}`);
  let ids = { requestId: "test", workspaceId: "test", brandId: "test" };
  if (requestId) {
    const r = await db.from("service_requests").select("id, workspace_id, brand_id").eq("id", requestId).single();
    if (r.error) throw new Error(`no such request: ${requestId}`);
    ids = { requestId: r.data.id, workspaceId: r.data.workspace_id, brandId: r.data.brand_id };
  }
  const notice = customerNotice("delivered", { ...ids, title: label, offeringName: "Test", customerNote: `Sent ${new Date().toISOString()}` }, env.APP_URL);
  const [report] = await createNotifier({ db, push, mailer: mailerFromEnv(), appUrl: env.APP_URL, receiptSecret: env.PUSH_RECEIPT_SECRET || env.VAPID_PRIVATE_KEY, receiptUrl: env.API_PUBLIC_URL ? `${env.API_PUBLIC_URL}/push/receipt` : undefined }).send([{ to: { userId: u.data.id, audience: "customer" }, notice: requestId ? notice : { ...notice, pushLink: "/m" } }]);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
