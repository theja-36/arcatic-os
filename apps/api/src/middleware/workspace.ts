import { AppError, apiKeyCan, roleCan, type Permission } from "@arcatic/core";
import { createMiddleware } from "hono/factory";
import type { ApiDeps, AppEnv } from "../types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loads the caller's role in :workspaceId. Non-members get 404 so workspace ids don't leak. */
export const workspaceContext = (deps: ApiDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const ws = c.req.param("workspaceId");
    if (!ws || !UUID.test(ws)) throw new AppError("not_found", "Workspace not found.");
    const p = c.get("principal");
    if (p.kind === "api_key") {
      if (p.workspaceId !== ws) throw new AppError("not_found", "Workspace not found.");
      c.set("role", p.role);
    } else {
      const m = await deps.resolveMembership(ws, p.userId);
      if (!m) throw new AppError("not_found", "Workspace not found.");
      c.set("role", m.role);
    }
    c.set("workspaceId", ws);
    await next();
  });

export const requirePermission = (permission: Permission) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const p = c.get("principal");
    const role = c.get("role");
    const ok = p.kind === "api_key" ? apiKeyCan(role, p.scopes, permission) : roleCan(role, permission);
    if (!ok) throw new AppError("forbidden", `Missing permission ${permission}.`);
    await next();
  });
