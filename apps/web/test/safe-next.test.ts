import { describe, expect, it } from "vitest";
import { safeNext } from "../lib/safe-next";

const B = "https://staging.example.com/auth/callback?code=x";
describe("safeNext", () => {
  it("keeps same-site paths with query", () => {
    expect(safeNext("/m/abc?tab=inbox&service=1", B)).toBe("/m/abc?tab=inbox&service=1");
    expect(safeNext("/", B)).toBe("/");
  });
  it("rejects other origins, protocol-relative and backslash tricks", () => {
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "/\\/evil.com", "\\\\evil.com", "javascript:alert(1)", "/%5Cevil.com/../..", "/\t/evil.com", "evil.com", "", null, undefined]) {
      const out = safeNext(bad as string, B);
      expect(out.startsWith("/") && !out.startsWith("//") && !out.includes("\\")).toBe(true);
      expect(new URL(out, B).origin).toBe("https://staging.example.com");
    }
    expect(safeNext("/\\evil.com", B)).toBe("/");
    expect(safeNext("//evil.com", B)).toBe("/");
  });
});
