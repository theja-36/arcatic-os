import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLE_RANK, ROLES, apiKeyCan, canAssignRole, roleCan } from "../src/rbac.js";

const migrationsDir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

const quoted = (s: string) => [...s.matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]!);

describe("RBAC catalogue matches the SQL migration", () => {
  // later migrations add permissions with the same patterns; the catalogue is the union
  const unnestBlocks = [...sql.matchAll(/from unnest\(array\[([\s\S]*?)\]\) as k/g)].map((m) => quoted(m[1]!));
  const grantsIn = (role: string) =>
    [...sql.matchAll(new RegExp(`select '${role}', key from public\\.permissions\\s*where key in \\(([\\s\\S]*?)\\);`, "g"))].flatMap((m) => quoted(m[1]!));

  it("has the same permission list", () => {
    expect(new Set(unnestBlocks.flat())).toEqual(new Set(PERMISSIONS));
  });

  it("has the same role ranks", () => {
    for (const role of ROLES) {
      const m = sql.match(new RegExp(`\\('${role}',\\s*(\\d+),`));
      expect(Number(m?.[1]), role).toBe(ROLE_RANK[role]);
    }
  });

  it("has the same grants per role", () => {
    expect(ROLE_PERMISSIONS.owner).toEqual(new Set(PERMISSIONS));
    // the bootstrap migration grants owners everything that existed then; later ones list grants
    expect(new Set([...unnestBlocks[0]!, ...grantsIn("owner")])).toEqual(new Set(PERMISSIONS));
    const adminExcluded = quoted(sql.match(/select 'admin', key from public\.permissions\s*where key not in \(([^)]*)\)/)?.[1] ?? "");
    const admin = new Set([...unnestBlocks[0]!.filter((p) => !adminExcluded.includes(p)), ...grantsIn("admin")]);
    expect(admin).toEqual(ROLE_PERMISSIONS.admin);
    for (const role of ["editor", "contributor", "reviewer", "viewer"] as const) {
      const granted = grantsIn(role);
      expect(granted.length, role).toBeGreaterThan(0);
      expect(new Set(granted), role).toEqual(ROLE_PERMISSIONS[role]);
    }
  });
});

describe("rbac helpers", () => {
  it("reviewers can approve but not publish", () => {
    expect(roleCan("reviewer", "approval.decide")).toBe(true);
    expect(roleCan("reviewer", "publish.execute")).toBe(false);
  });
  it("contributors cannot approve", () => expect(roleCan("contributor", "approval.decide")).toBe(false));
  it("no one assigns above their rank", () => {
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("admin", "admin")).toBe(true);
    expect(canAssignRole("editor", "admin")).toBe(false);
  });
  it("api key scopes narrow but never widen", () => {
    expect(apiKeyCan("editor", [], "content.create")).toBe(true);
    expect(apiKeyCan("editor", ["content.*"], "content.create")).toBe(true);
    expect(apiKeyCan("editor", ["content.read"], "content.create")).toBe(false);
    expect(apiKeyCan("viewer", ["content.*"], "content.create")).toBe(false);
  });
});
