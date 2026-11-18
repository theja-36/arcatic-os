import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import webpush from "web-push";
import { describe, expect, it } from "vitest";
import { Mailer, WebPushSender, mailerFromEnv, pushFromEnv } from "../src/index.js";

const b64u = (b: Buffer) => b.toString("base64url");

/** Browser side of RFC 8291 (aes128gcm): decrypt what the server sent. */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20]!, asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  expect(rs).toBeGreaterThan(0);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");   // 0x02 delimiter, then padding
}

describe("Web Push", () => {
  const vapid = webpush.generateVAPIDKeys();
  const browser = createECDH("prime256v1");
  browser.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", keys: { p256dh: b64u(browser.getPublicKey()), auth: b64u(auth) } };

  it("encrypts the payload so only the subscribed browser can read it (RFC 8291) and signs with VAPID (RFC 8292)", () => {
    const payload = { title: "Ready for your review: Tiffin guide", body: "Here is your article.", link: "/w/w1/b/b1/services/r1" };
    const req = webpush.generateRequestDetails(sub, JSON.stringify(payload), { vapidDetails: { subject: "mailto:ops@example.test", publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 60, contentEncoding: "aes128gcm" });
    expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(JSON.parse(decrypt(req.body as Buffer, browser.getPrivateKey(), browser.getPublicKey(), auth))).toEqual(payload);

    const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(req.headers.Authorization))!;
    expect(m[2]).toBe(vapid.publicKey);
    const [h, p, sig] = m[1]!.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:ops@example.test" });
    expect(claims.exp * 1000).toBeGreaterThan(Date.now());
    const pub = Buffer.from(vapid.publicKey, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);
    // a different browser can't read it
    const other = createECDH("prime256v1"); other.generateKeys();
    expect(() => decrypt(req.body as Buffer, other.getPrivateKey(), other.getPublicKey(), auth)).toThrow();
  });

  it("refuses subscriptions without keys and reads keys from the environment", async () => {
    const s = new WebPushSender({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: "mailto:ops@example.test" });
    expect(await s.send({ endpoint: sub.endpoint, keys: {} }, { title: "x" })).toMatchObject({ ok: false, expired: true });
    expect(pushFromEnv({})).toBeNull();
    expect(pushFromEnv({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey })?.publicKey).toBe(vapid.publicKey);
    expect(() => new WebPushSender({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: "ops@example.test" })).toThrow(/mailto/);
  });
});

describe("Mailer staging guard", () => {
  const make = (mode: "off" | "allowlist" | "all") => new Mailer({ host: "127.0.0.1", port: 1, from: "a@example.test", mode, allowlist: ["example.test"] });
  it("never emails real people outside production", async () => {
    expect(make("allowlist").allowed("owner@example.test")).toBe(true);
    expect(make("allowlist").allowed("qa@sub.example.test")).toBe(true);
    expect(make("allowlist").allowed("someone@gmail.com")).toBe(false);
    expect(make("allowlist").allowed("x@example.test.evil.com")).toBe(false);
    expect(make("off").allowed("owner@example.test")).toBe(false);
    expect(await make("allowlist").send({ to: "someone@gmail.com", subject: "s", text: "t" })).toEqual({ sent: false, reason: "recipient not on the staging allowlist" });
  });
  it("an exact address in the allowlist admits only that address, not its whole domain", () => {
    const m = new Mailer({ host: "127.0.0.1", port: 1, from: "a@example.test", mode: "allowlist", allowlist: ["tester+arcatic@gmail.com", "example.test"] });
    expect(m.allowed("Tester+Arcatic@Gmail.com")).toBe(true);
    expect(m.allowed("someone.else@gmail.com")).toBe(false);
    expect(m.allowed("tester+arcatic@gmail.com.evil.com")).toBe(false);
    expect(m.allowed("x@example.test")).toBe(true);
  });
  it("defaults to the allowlist with example.test", () => {
    const m = mailerFromEnv({ SMTP_HOST: "127.0.0.1", SMTP_PORT: "54325" })!;
    expect(m.allowed("a@example.test")).toBe(true);
    expect(m.allowed("a@company.com")).toBe(false);
    expect(mailerFromEnv({})).toBeNull();
    expect(() => mailerFromEnv({ SMTP_HOST: "x", EMAIL_MODE: "yes" })).toThrow();
  });
});
