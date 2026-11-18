import { describe, expect, it } from "vitest";
import { assertSafeUrl, isPrivateAddress } from "../src/url-safety.js";

const resolveTo = (...ips: string[]) => async () => ips;

describe("assertSafeUrl", () => {
  it("accepts public https URLs", async () => {
    await expect(assertSafeUrl("https://example.com/logo.png", { resolve: resolveTo("93.184.216.34") })).resolves.toBeInstanceOf(URL);
  });
  it.each([
    ["file:///etc/passwd", "1.1.1.1"],
    ["http://169.254.169.254/latest/meta-data", "169.254.169.254"],
    ["http://internal.example.com", "10.0.0.5"],
    ["https://evil.example.com", "::ffff:127.0.0.1"],
    ["http://localhost/x", "127.0.0.1"],
    ["https://user:pw@example.com", "93.184.216.34"],
    ["https://example.com:8080/", "93.184.216.34"],
  ])("rejects %s", async (url, ip) => {
    await expect(assertSafeUrl(url, { resolve: resolveTo(ip) })).rejects.toMatchObject({ code: "validation_failed" });
  });
  it("rejects when any resolved address is private (DNS rebinding with mixed answers)", async () => {
    await expect(assertSafeUrl("https://x.example", { resolve: resolveTo("93.184.216.34", "192.168.1.1") })).rejects.toThrow();
  });
});

describe("isPrivateAddress", () => {
  it.each(["10.1.2.3", "172.16.0.1", "192.168.0.1", "127.0.0.1", "100.64.0.1", "::1", "fd00::1", "fe80::1"])("%s is private", (a) =>
    expect(isPrivateAddress(a)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700::1111"])("%s is public", (a) => expect(isPrivateAddress(a)).toBe(false));
});
