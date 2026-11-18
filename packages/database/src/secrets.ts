import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for short-lived secrets (ephemeral_secrets). Key: ENCRYPTION_KEY,
 * 32 bytes base64. Format: v1.<iv>.<tag>.<ciphertext> (base64url). AAD binds the
 * ciphertext to its workspace + purpose so a row can't be replayed elsewhere.
 */
function key(raw: string | undefined): Buffer {
  const k = Buffer.from(raw ?? "", "base64");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encryptSecret(plaintext: string, aad: string, rawKey = process.env.ENCRYPTION_KEY): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(rawKey), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(token: string, aad: string, rawKey = process.env.ENCRYPTION_KEY): string {
  const [v, iv, tag, ct] = token.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported secret format");
  const d = createDecipheriv("aes-256-gcm", key(rawKey), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
