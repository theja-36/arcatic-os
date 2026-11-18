import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/secrets.js";

const key = randomBytes(32).toString("base64");
describe("secrets", () => {
  it("round-trips and binds to its AAD", () => {
    const t = encryptSecret("ya29.token", "ws1:drive", key);
    expect(t.startsWith("v1.")).toBe(true);
    expect(decryptSecret(t, "ws1:drive", key)).toBe("ya29.token");
    expect(() => decryptSecret(t, "ws2:drive", key)).toThrow();
  });
  it("rejects tampering and bad keys", () => {
    const t = encryptSecret("secret", "a", key);
    const parts = t.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), "a", key)).toThrow();
    expect(() => encryptSecret("x", "a", "short")).toThrow(/32 bytes/);
  });
});
