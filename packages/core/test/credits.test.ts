import { describe, expect, it } from "vitest";
import { estimateCredits } from "../src/credits.js";
import { assertWithinLimit } from "../src/entitlements.js";

describe("estimateCredits", () => {
  it("applies quantity and tier and reserves 1.5x headroom", () => {
    expect(estimateCredits({ kind: "generate.image", quantity: 2, modelTier: "premium" })).toEqual({ estimate: 24, max: 36 });
    expect(estimateCredits({ kind: "generate.transform", modelTier: "economy" })).toEqual({ estimate: 0.25, max: 0.375 });
  });
  it("rejects negative quantities", () => expect(() => estimateCredits({ kind: "generate.blog", quantity: -1 })).toThrow());
});

describe("entitlements", () => {
  it("enforces plan limits", () => {
    expect(() => assertWithinLimit({ max_brands: 1 }, "max_brands", 1)).toThrowError(/allows 1/);
    expect(() => assertWithinLimit({}, "max_brands", 100)).not.toThrow();
  });
});
