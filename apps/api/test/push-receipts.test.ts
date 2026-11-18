import { signReceipt } from "@arcatic/database";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiDeps } from "../src/types.js";
import { fakeDb } from "./fake-db.js";

const ID = "8d13fc85-de31-4547-b58d-73b818817fe0", SECRET = "receipt-secret";
function app(secret: string | null = SECRET) {
  const svc = fakeDb({ notifications: [{ id: ID, delivery: { push: [{ ok: true, status: 201 }] }, receipts: {} }] });
  const deps: ApiDeps = { corsOrigins: ["https://app.arcatic.test"], verifyJwt: async () => null, resolveApiKey: async () => null, resolveMembership: async () => null, userDb: () => svc.db, serviceDb: () => svc.db, jobs: (async () => ({})) as never, receiptSecret: secret ?? undefined };
  const post = (body: unknown, origin = "https://app.arcatic.test") => buildApp(deps).request("/push/receipt", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin } });
  return { post, svc };
}

describe("push receipts", () => {
  it("records 'displayed' and 'clicked' (no session needed) in their own column", async () => {
    const a = app();
    const r = await a.post({ receipt: signReceipt(SECRET, ID), event: "displayed" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://app.arcatic.test");
    const up = a.svc.ops.find((o) => o.table === "notifications" && o.op === "update")!.payload as { receipts: Record<string, string>; delivery?: unknown };
    expect(Object.keys(up.receipts)).toEqual(["displayed"]);
    expect(up.delivery).toBeUndefined();   // never touches the server-side delivery outcome (that overwrite was the original bug)
    expect((await a.post({ receipt: signReceipt(SECRET, ID), event: "clicked" })).status).toBe(204);
  });
  it("refuses forged tokens, unknown events, and other origins' CORS", async () => {
    const a = app();
    expect((await a.post({ receipt: signReceipt("wrong", ID), event: "displayed" })).status).toBe(403);
    expect((await a.post({ receipt: "junk", event: "displayed" })).status).toBe(403);
    expect((await a.post({ receipt: signReceipt(SECRET, ID), event: "deleted" })).status).toBe(422);
    expect(a.svc.ops.some((o) => o.op === "update")).toBe(false);
    // CORS is enforced by browsers: another origin is never granted access to read the reply
    expect((await app().post({ receipt: signReceipt(SECRET, ID), event: "displayed" }, "https://evil.example")).headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });
  it("doesn't exist when no secret is configured", async () => {
    expect((await app(null).post({ receipt: signReceipt(SECRET, ID), event: "displayed" })).status).toBe(404);
  });
});
