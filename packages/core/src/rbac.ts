/**
 * Role/permission catalogue. MUST match supabase/migrations (bootstrap + later grants) —
 * test/rbac.test.ts parses the migration and fails on drift.
 */
export const ROLES = ["owner", "admin", "editor", "contributor", "reviewer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = {
  owner: 100,
  admin: 80,
  editor: 60,
  contributor: 40,
  reviewer: 30,
  viewer: 10,
};

export const PERMISSIONS = [
  "workspace.read", "workspace.update", "workspace.delete",
  "member.read", "member.invite", "member.update", "member.remove",
  "brand.read", "brand.create", "brand.update", "brand.delete",
  "knowledge.read", "knowledge.create", "knowledge.update", "knowledge.delete",
  "media.read", "media.create", "media.update", "media.delete",
  "campaign.read", "campaign.create", "campaign.update", "campaign.delete",
  "content.read", "content.create", "content.update", "content.delete",
  "approval.read", "approval.decide",
  "publish.read", "publish.execute",
  "channel.read", "channel.manage",
  "analytics.read",
  "billing.read", "billing.manage",
  "apikey.manage",
  "audit.read",
  "job.read", "job.cancel",
  "ads.read", "ads.manage", "ads.approve",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const all = new Set<Permission>(PERMISSIONS);
const only = (...p: Permission[]) => new Set<Permission>(p);

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: all,
  admin: new Set(PERMISSIONS.filter((p) => p !== "workspace.delete" && p !== "billing.manage")),
  editor: only(
    "workspace.read", "member.read",
    "brand.read", "brand.create", "brand.update",
    "knowledge.read", "knowledge.create", "knowledge.update", "knowledge.delete",
    "media.read", "media.create", "media.update", "media.delete",
    "campaign.read", "campaign.create", "campaign.update", "campaign.delete",
    "content.read", "content.create", "content.update", "content.delete",
    "approval.read", "approval.decide", "publish.read", "publish.execute",
    "channel.read", "analytics.read", "billing.read", "job.read", "job.cancel",
    "ads.read", "ads.manage",
  ),
  contributor: only(
    "workspace.read", "member.read", "brand.read",
    "knowledge.read", "knowledge.create", "knowledge.update",
    "media.read", "media.create", "media.update",
    "campaign.read", "content.read", "content.create", "content.update",
    "approval.read", "publish.read", "channel.read", "analytics.read", "job.read", "job.cancel",
  ),
  reviewer: only(
    "workspace.read", "member.read", "brand.read", "knowledge.read", "media.read",
    "campaign.read", "content.read", "approval.read", "approval.decide",
    "publish.read", "analytics.read", "job.read", "ads.read",
  ),
  viewer: only(
    "workspace.read", "member.read", "brand.read", "knowledge.read", "media.read",
    "campaign.read", "content.read", "approval.read", "publish.read",
    "channel.read", "analytics.read", "job.read",
  ),
};

export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

export function roleCan(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Actors may only grant roles at or below their own rank (mirrors app.guard_member_role). */
export function canAssignRole(actor: Role, target: Role): boolean {
  return ROLE_RANK[target] <= ROLE_RANK[actor];
}

/** API-key scopes narrow a key's role; an empty scope list means "everything the role allows". */
export function apiKeyCan(role: Role, scopes: readonly string[], permission: Permission): boolean {
  if (!roleCan(role, permission)) return false;
  if (scopes.length === 0) return true;
  const resource = permission.split(".")[0];
  return scopes.includes(permission) || scopes.includes(`${resource}.*`);
}
