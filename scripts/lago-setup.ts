/**
 * Create Arcatic's catalogue in Lago from the database (plans, credit packs) so prices live in one place.
 * Safe to re-run: "already exists" answers are reported and skipped.
 *   LAGO_API_URL=… LAGO_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm lago:setup
 * Then in Lago: connect the payment provider (Cashfree / Stripe …) and add a webhook endpoint
 * https://<api>/webhooks/lago with signature algorithm "hmac"; put its key in LAGO_WEBHOOK_SECRET.
 */
import { AppError } from "../packages/core/src/index.js";
import { dbConfigFromEnv, getServiceClient } from "../packages/database/src/index.js";
import { LagoClient } from "../packages/integrations/src/index.js";
import { USAGE_METRIC_CODE } from "../packages/jobs/src/billing.js";

async function step(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`✓ ${label}`);
  } catch (e) {
    const status = e instanceof AppError ? (e.details as { status?: number } | undefined)?.status : undefined;
    if (status === 422) console.log(`= ${label} (already exists)`);
    else throw e;
  }
}

async function main() {
  if (!process.env.LAGO_API_URL || !process.env.LAGO_API_KEY) throw new Error("Set LAGO_API_URL and LAGO_API_KEY.");
  const lago = new LagoClient({ baseUrl: process.env.LAGO_API_URL, apiKey: process.env.LAGO_API_KEY });
  const db = getServiceClient(dbConfigFromEnv());
  await step(`billable metric ${USAGE_METRIC_CODE}`, () => lago.createBillableMetric({ name: "Arcatic credits used", code: USAGE_METRIC_CODE, field_name: "credits" }));
  const plans = await db.from("plans").select("key, name, price_minor, currency, lago_plan_code").not("lago_plan_code", "is", null).gt("price_minor", 0);
  if (plans.error) throw plans.error;
  for (const p of plans.data ?? []) await step(`plan ${p.lago_plan_code}`, () => lago.createPlan({ name: `Arcatic ${p.name}`, code: p.lago_plan_code!, amount_cents: Number(p.price_minor), amount_currency: p.currency }));
  const packs = await db.from("credit_packs").select("name, price_minor, currency, lago_add_on_code").eq("active", true);
  if (packs.error) throw packs.error;
  for (const k of packs.data ?? []) await step(`add-on ${k.lago_add_on_code}`, () => lago.createAddOn({ name: `Arcatic ${k.name}`, code: k.lago_add_on_code, amount_cents: Number(k.price_minor), amount_currency: k.currency }));
}

main().catch((e) => { console.error(e); process.exit(1); });
