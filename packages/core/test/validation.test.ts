import { describe, expect, it } from "vitest";
import { findTerm, graphemeLength, validateContent, xWeightedLength } from "../src/validation/index.js";

describe("findTerm", () => {
  it("matches whole words case-insensitively", () => {
    expect(findTerm("Our CHEAP deals", "cheap")).toHaveLength(1);
    expect(findTerm("cheapest deals", "cheap")).toHaveLength(0);
  });
  it("respects Telugu word boundaries (combining marks are part of the word)", () => {
    // "ఉచితం" = free; must not match inside a longer word
    expect(findTerm("ఇది ఉచితం!", "ఉచితం")).toHaveLength(1);
    expect(findTerm("ఉచితంగా", "ఉచితం")).toHaveLength(0);
  });
});

describe("lengths", () => {
  it("counts graphemes, not code units", () => {
    expect(graphemeLength("👍🏽")).toBe(1);
    expect(graphemeLength("తెలుగు")).toBe(3);
  });
  it("weights URLs as 23 on X", () => {
    expect(xWeightedLength("see https://example.com/a/very/long/path/that/is/long")).toBe(4 + 23);
  });
});

describe("validateContent", () => {
  it("blocks banned words and over-length X posts", () => {
    const r = validateContent("Guaranteed results! " + "a".repeat(300), { channel: "x", bannedWords: ["guaranteed"] });
    expect(r.passed).toBe(false);
    expect(r.issues.map((i) => i.code).sort()).toEqual(["banned_word", "too_long"]);
  });
  it("flags too many Instagram hashtags and non-clickable links", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    const r = validateContent(`Hello https://x.y ${tags}`, { channel: "instagram" });
    expect(r.issues.map((i) => i.code)).toContain("too_many_hashtags");
    expect(r.issues.map((i) => i.code)).toContain("link_not_clickable");
  });
  it("requires citations for numeric claims under strict policy", () => {
    const r = validateContent("Save 40% today, only ₹999", { claimsPolicy: "strict", citedClaims: ["₹999"] });
    expect(r.issues.filter((i) => i.code === "uncited_claim").map((i) => i.message)).toEqual(['"40%" needs a source.']);
  });
  it("passes clean content", () => {
    const r = validateContent("Fresh dosa batter every morning. Order now!", {
      channel: "instagram", requiredCta: true, ctaPhrases: ["order now"], bannedWords: ["cheap"],
    });
    expect(r.passed).toBe(true);
    expect(r.issues).toEqual([]);
  });
});
