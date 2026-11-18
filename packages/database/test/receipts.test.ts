import { describe, expect, it } from "vitest";
import { signReceipt, verifyReceipt } from "../src/receipts.js";

const ID = "8d13fc85-de31-4547-b58d-73b818817fe0";
describe("push receipt tokens", () => {
  it("round-trips for the notification they were issued for", () => expect(verifyReceipt("s3cret", signReceipt("s3cret", ID))).toBe(ID));
  it("rejects tampering, another secret, another id and junk", () => {
    const t = signReceipt("s3cret", ID);
    expect(verifyReceipt("other", t)).toBeNull();
    expect(verifyReceipt("s3cret", t.replace(ID, "9d13fc85-de31-4547-b58d-73b818817fe0"))).toBeNull();
    expect(verifyReceipt("s3cret", `${t}x`)).toBeNull();
    for (const bad of [null, undefined, 42, "", "nodot", ".sig", "not-a-uuid.sig"]) expect(verifyReceipt("s3cret", bad)).toBeNull();
  });
});
