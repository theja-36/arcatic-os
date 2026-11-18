import { AppError } from "@arcatic/core";
import { createMiddleware } from "hono/factory";
import type { ApiDeps, AppEnv } from "../types.js";

/** Accepts a Supabase access token or a workspace API key (`ak_live_<id>.<secret>`). */
export const authenticate = (deps: ApiDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new AppError("unauthenticated", "Missing bearer token.");

    if (token.startsWith("ak_")) {
      const key = await deps.resolveApiKey(token);
      if (!key) throw new AppError("unauthenticated", "Invalid or revoked API key.");
      c.set("principal", key);
      c.set("db", deps.serviceDb());
    } else {
      const claims = await deps.verifyJwt(token);
      if (!claims?.sub) throw new AppError("unauthenticated", "Invalid or expired token.");
      c.set("principal", { kind: "user", userId: claims.sub, token });
      c.set("db", deps.userDb(token));
    }
    await next();
  });
