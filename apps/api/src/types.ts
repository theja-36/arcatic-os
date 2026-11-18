import type { Permission, Role } from "@arcatic/core";
import type { Db } from "@arcatic/database";
import type { Embedder } from "@arcatic/integrations";
import type { JobStarter } from "@arcatic/jobs";

export type Principal =
  | { kind: "user"; userId: string; token: string }
  | { kind: "api_key"; keyId: string; workspaceId: string; role: Role; scopes: string[] };

export interface Membership {
  role: Role;
  brandRestricted: boolean;
}

/** Everything external the API touches, injectable for tests. */
export interface ApiDeps {
  verifyJwt(token: string): Promise<{ sub: string } | null>;
  resolveApiKey(rawKey: string): Promise<Extract<Principal, { kind: "api_key" }> | null>;
  resolveMembership(workspaceId: string, userId: string): Promise<Membership | null>;
  /** RLS-scoped client for a user token. */
  userDb(token: string): Db;
  /** Service-role client — callers must filter by workspace_id. */
  serviceDb(): Db;
  jobs(): Promise<JobStarter>;
  /** DNS lookup for SSRF checks (injectable for tests). */
  resolveHost?(hostname: string): Promise<string[]>;
  /** query embeddings for knowledge search; null → keyword search only */
  embedder?: Embedder | null;
  /** outbound fetch for URL imports (injectable for tests) */
  fetchImpl?: typeof fetch;
  encryptionKey?: string;
  corsOrigins: string[];
  /** Postiz backend base URL (POSTIZ_URL); the public API lives under /public/v1 */
  postizUrl?: string;
  /** web app origin, used for redirects back from connect flows (APP_URL) */
  appUrl?: string;
  /** Lago (billing); null → paid plans unavailable */
  lago?: import("@arcatic/integrations").LagoClient | null;
  /** HMAC key of the Lago webhook endpoint (signature algorithm `hmac`) */
  lagoWebhookKey?: string;
  /** payment provider Lago charges through ("cashfree" | "stripe" | …) and its connection code */
  lagoPaymentProvider?: string;
  lagoPaymentProviderCode?: string;
  /** staff tooling (/admin): refunds and adjustments */
  adminToken?: string;
  /** ads-sync sidecar (official Google Ads / Meta SDKs); null when not deployed */
  ads?: import("@arcatic/integrations").AdsSyncClient | null;
  /** Web Push sender (VAPID) and transactional mailer; null → in-app notifications only */
  push?: import("@arcatic/integrations").WebPushSender | null;
  mailer?: import("@arcatic/integrations").Mailer | null;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    principal: Principal;
    workspaceId: string;
    role: Role;
    /** RLS client for users, service client (+ explicit filters) for API keys. */
    db: Db;
  };
};

export type { Permission };
