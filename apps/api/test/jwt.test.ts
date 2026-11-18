import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type KeyLike } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createJwtVerifier } from "../src/jwt.js";

const URL_ = "https://abc.supabase.co";
const ISS = `${URL_}/auth/v1`;
let es: Awaited<ReturnType<typeof generateKeyPair>>, other: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: ReturnType<typeof createJwtVerifier>;

const sign = (claims: Record<string, unknown>, key: KeyLike | Uint8Array, alg = "ES256", kid = "k1", exp: string | number = "10m") =>
  new SignJWT({ role: "authenticated", ...claims }).setProtectedHeader({ alg, kid }).setSubject("user-1").setIssuer(ISS).setAudience("authenticated").setIssuedAt().setExpirationTime(exp).sign(key);

beforeAll(async () => {
  es = await generateKeyPair("ES256");
  other = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(es.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  verify = createJwtVerifier({ supabaseUrl: URL_, getKey: createLocalJWKSet({ keys: [jwk] }) });
});

describe("Supabase access-token verification", () => {
  it("accepts a valid ES256 user token", async () => {
    expect(await verify(await sign({}, es.privateKey))).toEqual({ sub: "user-1" });
  });
  it("refuses a token signed by another key", async () => {
    expect(await verify(await sign({}, other.privateKey))).toBeNull();
  });
  it("refuses an expired token", async () => {
    expect(await verify(await sign({}, es.privateKey, "ES256", "k1", Math.floor(Date.now() / 1000) - 60))).toBeNull();
  });
  it("refuses the wrong issuer and the wrong audience", async () => {
    const bad = (f: (j: SignJWT) => SignJWT) => f(new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject("u").setIssuedAt().setExpirationTime("10m")).sign(es.privateKey);
    expect(await verify(await bad((j) => j.setIssuer("https://evil.supabase.co/auth/v1").setAudience("authenticated")))).toBeNull();
    expect(await verify(await bad((j) => j.setIssuer(ISS).setAudience("anon")))).toBeNull();
  });
  it("refuses anon / service_role tokens even if correctly signed (role must be authenticated)", async () => {
    expect(await verify(await sign({ role: "anon" }, es.privateKey))).toBeNull();
    expect(await verify(await sign({ role: "service_role" }, es.privateKey))).toBeNull();
  });
  it("refuses anonymous sign-in sessions", async () => {
    expect(await verify(await sign({ is_anonymous: true }, es.privateKey))).toBeNull();
  });
  it("refuses a missing subject", async () => {
    const t = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(ISS).setAudience("authenticated").setExpirationTime("10m").sign(es.privateKey);
    expect(await verify(t)).toBeNull();
  });
  it("refuses an HS256 token in asymmetric mode (algorithm confusion)", async () => {
    const spki = JSON.stringify(await exportJWK(es.publicKey));
    expect(await verify(await sign({}, new TextEncoder().encode(spki), "HS256"))).toBeNull();
  });
  it("refuses the unsigned 'none' algorithm and garbage", async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "u", role: "authenticated", iss: ISS, aud: "authenticated", exp: 9999999999 })).toString("base64url")}.`;
    expect(await verify(none)).toBeNull();
    expect(await verify("sb_secret_notajwt")).toBeNull();
    expect(await verify("")).toBeNull();
  });
  it("legacy mode: HS256 secret accepted, ES256 refused", async () => {
    const secret = new TextEncoder().encode("legacy-shared-secret-legacy-shared-secret");
    const legacy = createJwtVerifier({ supabaseUrl: URL_, hs256Secret: "legacy-shared-secret-legacy-shared-secret" });
    expect(await legacy(await sign({}, secret, "HS256"))).toEqual({ sub: "user-1" });
    expect(await legacy(await sign({}, es.privateKey))).toBeNull();
    expect(await legacy(await sign({}, new TextEncoder().encode("another-secret-another-secret-another"), "HS256"))).toBeNull();
  });
  it("a custom auth-domain issuer can be configured", async () => {
    const jwk = { ...(await exportJWK(es.publicKey)), kid: "k1", alg: "ES256" };
    const v = createJwtVerifier({ supabaseUrl: URL_, issuer: "https://auth.example.com/auth/v1", getKey: createLocalJWKSet({ keys: [jwk] }) });
    expect(await v(await sign({}, es.privateKey))).toBeNull();
  });
});
