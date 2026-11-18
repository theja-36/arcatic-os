import { describe, expect, it } from "vitest";
import { apikeyOnlyFetch, dbConfigFromEnv } from "../src/clients.js";

const jwt = (role: string) => `h.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.s`;
const base = { SUPABASE_URL: "https://x.supabase.co" };

describe("dbConfigFromEnv", () => {
  it("accepts the new publishable/secret keys", () => {
    const c = dbConfigFromEnv({ ...base, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_a", SUPABASE_SECRET_KEY: "sb_secret_b" });
    expect(c).toEqual({ url: "https://x.supabase.co", anonKey: "sb_publishable_a", serviceRoleKey: "sb_secret_b" });
  });
  it("accepts the legacy anon / service_role keys", () => {
    expect(dbConfigFromEnv({ ...base, SUPABASE_ANON_KEY: jwt("anon"), SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") }).serviceRoleKey).toBe(jwt("service_role"));
  });
  it("prefers the new names when both generations are set", () => {
    const c = dbConfigFromEnv({ ...base, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_a", SUPABASE_ANON_KEY: jwt("anon"), SUPABASE_SECRET_KEY: "sb_secret_b", SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") });
    expect([c.anonKey, c.serviceRoleKey]).toEqual(["sb_publishable_a", "sb_secret_b"]);
  });
  it("refuses a privileged key in the public slot and the reverse", () => {
    expect(() => dbConfigFromEnv({ ...base, SUPABASE_PUBLISHABLE_KEY: "sb_secret_b", SUPABASE_SECRET_KEY: "sb_secret_c" })).toThrow(/privileged/);
    expect(() => dbConfigFromEnv({ ...base, SUPABASE_ANON_KEY: jwt("service_role"), SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") })).toThrow();
    expect(() => dbConfigFromEnv({ ...base, SUPABASE_ANON_KEY: jwt("service_role"), SUPABASE_SERVICE_ROLE_KEY: jwt("anon") })).toThrow(/privileged|public/);
    expect(() => dbConfigFromEnv({ ...base, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_a", SUPABASE_SECRET_KEY: "sb_publishable_b" })).toThrow(/public/);
  });
  it("fails when a key is missing", () => {
    expect(() => dbConfigFromEnv({ ...base, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_a" })).toThrow(/SUPABASE_SECRET_KEY/);
  });
});

describe("apikeyOnlyFetch", () => {
  it("drops Authorization: Bearer <the sb_ key> but keeps every other header, and user tokens", async () => {
    const seen: Headers[] = [];
    const base = (async (_u: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return new Response("{}"); }) as typeof fetch;
    const f = apikeyOnlyFetch("sb_secret_x", base);
    await f("https://x/rest/v1/t", { headers: { apikey: "sb_secret_x", authorization: "Bearer sb_secret_x", "x-keep": "1" } });
    expect([seen[0]!.get("authorization"), seen[0]!.get("apikey"), seen[0]!.get("x-keep")]).toEqual([null, "sb_secret_x", "1"]);
    await f("https://x/rest/v1/t", { headers: { apikey: "sb_secret_x", authorization: "Bearer eyJuser.token.sig" } });
    expect(seen[1]!.get("authorization")).toBe("Bearer eyJuser.token.sig");
  });
});
