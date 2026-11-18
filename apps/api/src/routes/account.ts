import { AppError, CreateOrganizationSchema } from "@arcatic/core";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { body, check } from "../http.js";
import type { AppEnv } from "../types.js";

const userOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("principal").kind !== "user") throw new AppError("forbidden", "This endpoint requires a user session.");
  await next();
});

/** Routes that are about the caller, not a single workspace. User tokens only. */
export const accountRoutes = () => {
  const r = new Hono<AppEnv>();

  // Mounted at "/" next to /workspaces/*, so the guard is per route, never r.use().
  r.get("/me", userOnly, async (c) => {
    const db = c.get("db");
    const p = c.get("principal");
    const userId = p.kind === "user" ? p.userId : "";
    const user = check(await db.from("users").select("id, email, full_name, avatar_url, locale, timezone").eq("id", userId).single());
    const memberships = check(
      await db.from("workspace_members").select("role, brand_restricted, workspace:workspaces(id, name, slug, organization_id)").eq("user_id", userId),
    );
    return c.json({ user, memberships });
  });

  r.post("/organizations", userOnly, async (c) => {
    const input = await body(c, CreateOrganizationSchema);
    const workspaceId = check(
      await c.get("db").rpc("create_organization", {
        p_org_name: input.organizationName,
        p_workspace_name: input.workspaceName,
        p_workspace_slug: input.workspaceSlug,
        p_country: input.country,
        p_currency: input.currency,
      }),
    );
    return c.json({ workspaceId }, 201);
  });

  r.get("/workspaces", userOnly, async (c) => {
    const rows = check(await c.get("db").from("workspaces").select("id, name, slug, organization_id, default_language, currency").is("deleted_at", null).order("name"));
    return c.json({ data: rows });
  });

  r.post("/invites/accept", userOnly, async (c) => {
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (!token) throw new AppError("validation_failed", "token is required.");
    const workspaceId = check(await c.get("db").rpc("accept_invite", { p_token: token }));
    return c.json({ workspaceId });
  });

  return r;
};
