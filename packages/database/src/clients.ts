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

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing env ${k}`);
    return v;
  };
  return { url: need("SUPABASE_URL"), anonKey: need("SUPABASE_ANON_KEY"), serviceRoleKey: need("SUPABASE_SERVICE_ROLE_KEY") };
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

export function createUserClient(cfg: DbConfig, accessToken: string): Db {
  return createClient(cfg.url, cfg.anonKey, {
    ...noSession,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

let service: Db | undefined;
export function getServiceClient(cfg: DbConfig): Db {
  service ??= createClient(cfg.url, cfg.serviceRoleKey, noSession);
  return service;
}
