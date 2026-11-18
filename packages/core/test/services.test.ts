import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVICE_STATUSES, buildServiceBrief, canServiceTransition, compileBrandContext, customerStage, dueAt, emptyKit, isOverdue, rankSpecialists, revisionCost,
  revisionDueAt, totalCharge, transitionAllowed, validateIntake, type ServiceStatus,
} from "../src/index.js";

const sql = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261128000017_services_mobile.sql", import.meta.url)), "utf8");

describe("service lifecycle", () => {
  it("matches the database guard exactly", () => {
    const block = sql.match(/ok := case old\.status([\s\S]*?)else false end;/)![1]!;
    for (const from of SERVICE_STATUSES) {
      const m = block.match(new RegExp(`when '${from}'\\s+then new\\.status in \\(([^)]*)\\)`));
      const allowed = m ? [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
      for (const to of SERVICE_STATUSES) expect(canServiceTransition(from, to), `${from}→${to}`).toBe(allowed.includes(to));
    }
  });
  it("says who may move a request", () => {
    expect(transitionAllowed("draft", "submitted", "customer")).toBe(true);
    expect(transitionAllowed("submitted", "assigned", "customer")).toBe(false);
    expect(transitionAllowed("submitted", "assigned", "manager")).toBe(true);
    expect(transitionAllowed("delivered", "approved", "customer")).toBe(true);
    expect(transitionAllowed("delivered", "approved", "manager")).toBe(false);   // only the customer accepts work
    expect(transitionAllowed("in_progress", "delivered", "specialist")).toBe(true);
    expect(transitionAllowed("in_progress", "cancelled", "customer")).toBe(false);
    expect(transitionAllowed("in_review", "delivered", "specialist")).toBe(false);   // QA is the manager's
  });
  it("shows customers a simple stage", () => {
    expect(customerStage("in_review")).toBe("Being worked on");
    expect(customerStage("delivered")).toBe("Ready for your review");
  });
  it("computes due dates and overdue", () => {
    const t = new Date("2026-11-18T10:00:00Z");
    expect(dueAt(t, 48).toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(revisionDueAt(t, 120).toISOString()).toBe("2026-11-20T22:00:00.000Z");   // half of 120 h
    expect(revisionDueAt(t, 240).toISOString()).toBe("2026-11-21T10:00:00.000Z");   // capped at 72 h
    expect(revisionDueAt(t, 24).toISOString()).toBe("2026-11-19T10:00:00.000Z");    // at least 24 h
    expect(isOverdue({ status: "in_progress" as ServiceStatus, due_at: "2026-11-17T00:00:00Z" }, t)).toBe(true);
    expect(isOverdue({ status: "delivered" as ServiceStatus, due_at: "2026-11-17T00:00:00Z" }, t)).toBe(false);
  });
  it("prices revisions: included ones are free", () => {
    const o = { credits: 120, included_revisions: 2, extra_revision_credits: 20 };
    expect([0, 1, 2, 3].map((n) => revisionCost(o, n))).toEqual([0, 0, 20, 20]);
    expect(totalCharge(o, 2)).toBe(120);
    expect(totalCharge(o, 4)).toBe(160);
  });
  it("suggests specialists by skill and spare capacity", () => {
    const staff = [
      { user_id: "a", role: "specialist", skills: ["writing"], active: true, max_active: 4 },
      { user_id: "b", role: "specialist", skills: ["writing", "ads"], active: true, max_active: 2 },
      { user_id: "c", role: "specialist", skills: ["design"], active: true, max_active: 5 },
      { user_id: "d", role: "specialist", skills: ["writing"], active: false, max_active: 5 },
      { user_id: "m", role: "manager", skills: ["writing"], active: true, max_active: 5 },
    ];
    expect(rankSpecialists(staff, "writing", new Map([["a", 1], ["b", 2]])).map((s) => s.user_id)).toEqual(["a"]);   // b is full
    expect(rankSpecialists(staff, "writing", new Map([["a", 2], ["b", 0]])).map((s) => s.user_id)).toEqual(["b", "a"]);
  });
});

describe("intake and brief", () => {
  const fields = [
    { key: "topic", label: "Topic", type: "text" as const, required: true, max: 20 },
    { key: "length", label: "Length", type: "select" as const, required: true, options: ["15s", "30s"] },
    { key: "notes", label: "Notes", type: "textarea" as const, required: false },
  ];
  it("validates required, length and options; drops unknown keys", () => {
    expect(validateIntake(fields, { topic: "Diwali", length: "30s", extra: "x" })).toEqual({ ok: true, values: { topic: "Diwali", length: "30s" }, errors: {} });
    const bad = validateIntake(fields, { topic: "x".repeat(30), length: "90s" });
    expect(Object.keys(bad.errors)).toEqual(["topic", "length"]);
    expect(validateIntake(fields, {}, { partial: true }).ok).toBe(true);
    expect(validateIntake(fields, {}).ok).toBe(false);
  });
  it("freezes brand essentials, requirements and acceptance criteria into the brief", async () => {
    const ctx = await compileBrandContext({ ...emptyKit("b1", "Annapurna Tiffins"), facts: {
      "vocabulary.banned": { id: "vocabulary.banned", value: ["cheap"], status: "approved", origin: "human", sources: [] },
    } } as never);
    const b = buildServiceBrief({
      offering: { key: "polish_draft", name: "Human polish", deliverable_kind: "content", deliverable_type: null, category: "writing" },
      fields, values: { topic: "Diwali" }, title: "Polish Diwali post", brand: ctx.data, source: { title: "Diwali", type: "blog", text: "Draft text" }, dueAt: new Date("2026-11-20T10:00:00Z"),
    });
    expect(b.requirements).toEqual([{ label: "Topic", value: "Diwali" }]);
    expect(b.brand.bannedWords).toContain("cheap");
    expect(b.acceptanceCriteria.join(" ")).toMatch(/None of these words: cheap/);
    expect(b.acceptanceCriteria.join(" ")).toMatch(/Keeps the draft's meaning/);
    expect(b.source?.text).toBe("Draft text");
  });
});
