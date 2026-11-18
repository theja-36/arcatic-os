import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Two client kinds, never mixed:
 *  - user client: carries the caller's JWT → every query is filtered by RLS.
 *  - service client: bypasses RLS → callers MUST filter by workspace_id explicitly.
 * Generated row types: `pnpm db:types` writes src/types.gen.ts (needs the Supabase CLI).
 */
export type Db = SupabaseClient;

export interface DbConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

/** Role claim of a legacy (JWT-format) Supabase key; null for the new `sb_…` keys, which are not JWTs. */
function legacyKeyRole(key: string): string | null {
  const part = key.split(".")[1];
  if (!part) return null;
  try { return (JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { role?: string }).role ?? null; } catch { return null; }
}

/**
 * Keys come from the environment only. Both key generations work:
 *  - new: SUPABASE_PUBLISHABLE_KEY (`sb_publishable_…`) and SUPABASE_SECRET_KEY (`sb_secret_…`);
 *  - legacy: SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (JWTs; Supabase is retiring them).
 * The new names win when both are set. Mixing the two up is a privilege bug, so it fails at start-up.
 */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const pick = (...names: string[]) => {
    for (const n of names) if (env[n]) return env[n]!;
    throw new Error(`Missing env ${names[0]}`);
  };
  const url = pick("SUPABASE_URL");
  const anonKey = pick("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY");
  const serviceRoleKey = pick("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
  if (anonKey === serviceRoleKey) throw new Error("The public and the privileged Supabase key are identical");
  if (anonKey.startsWith("sb_secret_") || legacyKeyRole(anonKey) === "service_role") throw new Error("A privileged Supabase key is configured as the public key");
  if (serviceRoleKey.startsWith("sb_publishable_") || legacyKeyRole(serviceRoleKey) === "anon") throw new Error("The public Supabase key is configured as the privileged key");
  return { url, anonKey, serviceRoleKey };
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

export function createUserClient(cfg: DbConfig, accessToken: string): Db {
  return createClient(cfg.url, cfg.anonKey, {
    ...noSession,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * New-format keys (`sb_secret_…`) are not JWTs and belong in the `apikey` header only. supabase-js still
 * falls back to `Authorization: Bearer <key>` when there is no user session; drop that so the platform
 * only ever sees the documented form (the legacy JWT service_role key is unaffected).
 */
export function apikeyOnlyFetch(key: string, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.get("authorization") === `Bearer ${key}`) headers.delete("authorization");
    return base(input, { ...init, headers });
  };
}

let service: Db | undefined;
export function getServiceClient(cfg: DbConfig): Db {
  service ??= createClient(cfg.url, cfg.serviceRoleKey, { ...noSession, ...(cfg.serviceRoleKey.startsWith("sb_") && { global: { fetch: apikeyOnlyFetch(cfg.serviceRoleKey) } }) });
  return service;
}
