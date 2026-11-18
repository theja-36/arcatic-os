import { createHash } from "node:crypto";
import { isRole } from "@arcatic/core";
import { createUserClient, dbConfigFromEnv, getServiceClient } from "@arcatic/database";
import { AdsSyncClient, LagoClient, embedderFromEnv, mailerFromEnv, pushFromEnv } from "@arcatic/integrations";
import { JobStarter, connectTemporal, temporalConfigFromEnv } from "@arcatic/jobs";
import { createJwtVerifier } from "./jwt.js";
import type { ApiDeps } from "./types.js";

export function realDeps(env: NodeJS.ProcessEnv = process.env): ApiDeps {
  const db = dbConfigFromEnv(env);
  const service = () => getServiceClient(db);

  // Supabase Auth access tokens: asymmetric signing keys by default; HS256 only if SUPABASE_JWT_SECRET is set (legacy projects).
  const verifyJwt = createJwtVerifier({ supabaseUrl: db.url, issuer: env.SUPABASE_JWT_ISSUER || undefined, hs256Secret: env.SUPABASE_JWT_SECRET || undefined });

  let starter: Promise<JobStarter> | undefined;

  return {
    embedder: embedderFromEnv(env),
    encryptionKey: env.ENCRYPTION_KEY,
    postizUrl: env.POSTIZ_URL || undefined,
    lago: env.LAGO_API_URL && env.LAGO_API_KEY ? new LagoClient({ baseUrl: env.LAGO_API_URL, apiKey: env.LAGO_API_KEY }) : null,
    lagoWebhookKey: env.LAGO_WEBHOOK_SECRET || undefined,
    lagoPaymentProvider: env.LAGO_PAYMENT_PROVIDER || undefined,
    lagoPaymentProviderCode: env.LAGO_PAYMENT_PROVIDER_CODE || undefined,
    adminToken: env.ADMIN_API_TOKEN || undefined,
    ads: env.ADS_SYNC_URL && env.ADS_SYNC_SECRET ? new AdsSyncClient({ baseUrl: env.ADS_SYNC_URL, secret: env.ADS_SYNC_SECRET }) : null,
    push: pushFromEnv(env),
    mailer: mailerFromEnv(env),
    apiPublicUrl: env.API_PUBLIC_URL || undefined,
    receiptSecret: env.PUSH_RECEIPT_SECRET || env.VAPID_PRIVATE_KEY || undefined,
    appUrl: env.APP_URL || (env.API_CORS_ORIGINS ?? "http://localhost:3000").split(",")[0]!.trim(),
    corsOrigins: (env.API_CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim()),
    verifyJwt,
    async resolveApiKey(raw) {
      const hash = createHash("sha256").update(raw).digest("hex");
      const { data } = await service().from("api_keys").select("id, workspace_id, role, scopes, expires_at, revoked_at").eq("secret_hash", hash).maybeSingle();
      if (!data || data.revoked_at || (data.expires_at && new Date(data.expires_at) < new Date()) || !isRole(data.role)) return null;
      void service().from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => undefined);
      return { kind: "api_key", keyId: data.id, workspaceId: data.workspace_id, role: data.role, scopes: data.scopes ?? [] };
    },
    async resolveMembership(workspaceId, userId) {
      const { data } = await service().from("workspace_members").select("role, brand_restricted, status")
        .eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
      if (!data || data.status !== "active" || !isRole(data.role)) return null;
      return { role: data.role, brandRestricted: data.brand_restricted };
    },
    userDb: (token) => createUserClient(db, token),
    serviceDb: service,
    jobs() {
      starter ??= connectTemporal(temporalConfigFromEnv(env)).then((c) => new JobStarter(c)).catch((e) => {
        starter = undefined;
        throw e;
      });
      return starter;
    },
  };
}
