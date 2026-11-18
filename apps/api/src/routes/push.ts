import { AppError, fromDbError } from "@arcatic/core";
import { RECEIPT_EVENTS, verifyReceipt } from "@arcatic/database";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { ApiDeps, AppEnv } from "../types.js";

/**
 * Push receipts. The service worker (no session) reports that it displayed / was clicked, using the
 * signed token that came inside the push. This is what separates "the push service accepted it
 * (HTTP 201)" from "the browser actually showed it" and "the person tapped it".
 */
export const pushRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  r.use("*", cors({ origin: deps.corsOrigins, allowMethods: ["POST", "OPTIONS"], allowHeaders: ["content-type"], credentials: false }));
  r.post("/receipt", async (c) => {
    const secret = deps.receiptSecret;
    if (!secret) throw new AppError("not_found", "Route not found.");
    const parsed = z.object({ receipt: z.string().max(200), event: z.enum(RECEIPT_EVENTS) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("validation_failed", "Invalid receipt.");
    const id = verifyReceipt(secret, parsed.data.receipt);
    if (!id) throw new AppError("forbidden", "Invalid receipt.");
    const db = deps.serviceDb();
    const cur = await db.from("notifications").select("receipts").eq("id", id).maybeSingle();
    if (cur.error) throw fromDbError(cur.error);
    if (!cur.data) throw new AppError("not_found", "Notification not found.");
    const receipts = { ...((cur.data as { receipts: Record<string, string> }).receipts ?? {}) };
    receipts[parsed.data.event] ??= new Date().toISOString();   // first report wins; repeats are harmless
    const up = await db.from("notifications").update({ receipts }).eq("id", id);
    if (up.error) throw fromDbError(up.error);
    return c.body(null, 204);
  });
  return r;
};
