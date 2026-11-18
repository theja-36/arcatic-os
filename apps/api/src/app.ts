import { randomUUID } from "node:crypto";
import { AppError, isAppError } from "@arcatic/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { authenticate } from "./middleware/auth.js";
import { accountRoutes } from "./routes/account.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { adminRoutes, webhookRoutes } from "./routes/billing.js";
import { deskRoutes } from "./routes/desk.js";
import { meRoutes } from "./routes/mobile.js";
import type { ApiDeps, AppEnv } from "./types.js";

export function buildApp(deps: ApiDeps) {
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    const id = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  });
  app.use(secureHeaders());
  app.use("/v1/*", cors({ origin: deps.corsOrigins, allowHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id"], credentials: false }));

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    if (isAppError(err)) {
      if (err.status >= 500) console.error(JSON.stringify({ level: "error", requestId, code: err.code, msg: err.message, cause: String(err.cause ?? "") }));
      return c.json(err.toJSON(requestId), err.status as 400);
    }
    console.error(JSON.stringify({ level: "error", requestId, msg: err.message, stack: err.stack }));
    return c.json(new AppError("internal", "Something went wrong.").toJSON(requestId), 500);
  });
  app.notFound((c) => c.json(new AppError("not_found", "Route not found.").toJSON(c.get("requestId")), 404));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    const db = await deps.serviceDb().from("plans").select("key").limit(1);
    let temporal = true;
    try {
      await deps.jobs();
    } catch {
      temporal = false;
    }
    const ready = !db.error && temporal;
    return c.json({ db: !db.error, temporal }, ready ? 200 : 503);
  });

  // unauthenticated by user tokens: signed webhooks and staff tooling
  app.route("/webhooks", webhookRoutes(deps));
  app.route("/admin", adminRoutes(deps));

  const v1 = new Hono<AppEnv>();
  v1.use(authenticate(deps));
  v1.route("/", accountRoutes());
  v1.route("/me", meRoutes(deps));
  v1.route("/desk", deskRoutes(deps));
  v1.route("/workspaces", workspaceRoutes(deps));
  app.route("/v1", v1);

  return app;
}
