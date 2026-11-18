import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Validates a Supabase Auth access token for the API (the API never trusts the browser's word).
 *
 * Two modes, chosen by configuration and never mixed (so one algorithm family can't be used to
 * forge the other):
 *  - asymmetric (default, Supabase "JWT signing keys"): the public keys come from the project's
 *    JWKS endpoint; only ES256 / RS256 / EdDSA are accepted;
 *  - legacy shared secret: set SUPABASE_JWT_SECRET → only HS256 is accepted. Use this only for a
 *    project that has not migrated to signing keys.
 * Either way the token must have: the project's issuer, audience "authenticated", Postgres role
 * "authenticated" (so the anon/service-role keys, which are JWTs too, are refused), a subject,
 * an expiry, and must not be an anonymous-sign-in session. The new `sb_publishable_` /
 * `sb_secret_` API keys are not JWTs and are refused here by construction.
 * Tokens are verified locally, so a revoked session stays valid until it expires (access tokens
 * are short-lived; set the project's JWT expiry to 1 hour or less).
 */
export interface JwtVerifierOptions {
  supabaseUrl: string;
  /** Override only for a custom auth domain; defaults to `<supabaseUrl>/auth/v1`. */
  issuer?: string;
  hs256Secret?: string;
  /** Tests inject a key resolver instead of fetching the JWKS. */
  getKey?: JWTVerifyGetKey;
}

export const ASYMMETRIC_ALGS = ["ES256", "RS256", "EdDSA"];

export function createJwtVerifier(o: JwtVerifierOptions): (token: string) => Promise<{ sub: string } | null> {
  const base = o.supabaseUrl.replace(/\/+$/, "");
  const issuer = (o.issuer ?? `${base}/auth/v1`).replace(/\/+$/, "");
  const secret = o.hs256Secret ? new TextEncoder().encode(o.hs256Secret) : undefined;
  // Supabase caches the JWKS for 10 minutes at the edge; do not keep keys longer than that.
  const jwks = secret || o.getKey ? undefined : createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`), { cacheMaxAge: 5 * 60_000, cooldownDuration: 30_000 });
  const opts = { issuer, audience: "authenticated", algorithms: secret ? ["HS256"] : ASYMMETRIC_ALGS, requiredClaims: ["sub", "exp", "iss", "aud"], clockTolerance: 5 };

  return async (token) => {
    try {
      const { payload } = secret ? await jwtVerify(token, secret, opts) : await jwtVerify(token, (o.getKey ?? jwks)!, opts);
      if (typeof payload.sub !== "string" || !payload.sub) return null;
      if (payload.role !== "authenticated") return null;
      if (payload.is_anonymous === true) return null;
      return { sub: payload.sub };
    } catch {
      return null;
    }
  };
}
