import { compileBrandContext, emptyKit, markHumanEdits, docFrom, type ContentDoc } from "@arcatic/core";
import type { LlmProvider } from "@arcatic/ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", () => ({ Context: { current: () => ({ heartbeat: () => undefined, cancelled: new Promise(() => undefined), cancellationSignal: new AbortController().signal }) } }));
const { generateContentActivity } = await import("../src/content-activity.js");
const { memDb } = await import("./mem-db.js");

const WS = "w1";
const BRAND = "b1";

async function setup(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  const ctx = await compileBrandContext({
    ...emptyKit(BRAND, "Annapurna"),
    facts: { "vocabulary.banned": { id: "vocabulary.banned", value: ["cheap"], status: "approved", origin: "human", sources: [] } },
  });
  return memDb({
    brands: [{ id: BRAND, workspace_id: WS, active_kit_version_id: "kv1" }],
    brand_contexts: [{ kit_version_id: "kv1", workspace_id: WS, context: ctx }],
    ...extra,
  }, { search_knowledge: () => [], search_knowledge_in: () => [] });
}
const llm = (output: unknown) => {
  const fn = vi.fn();
  const p: LlmProvider = {
    async generateStructured(req) {
      fn(req);
      return { output: req.schema.parse(output), model: "claude-opus-5-5", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end_turn", servedByFallback: false };
    },
  };
  return { p, fn };
};
const base = { workspaceId: WS, brandId: BRAND, chargeCredits: 1, reservationId: "r" };

describe("generateContentActivity", () => {
  it("creates an item and version with provenance, validation and topic link; retries are idempotent", async () => {
    const { db, tables } = await setup({ campaign_topics: [{ id: "t1", workspace_id: WS, status: "in_production" }] });
    const { p, fn } = llm({ variants: [{ hook: "Cheap idli", body: "Hot by 7am", cta: "Order", hashtags: ["#idli"], alt_text: "", cited_chunk_ids: [] }] });
    const input = { ...base, jobId: "j1", templateKey: "social.post@1", input: { channel: "instagram", topic: "Breakfast" }, topicId: "t1" };
    const r = await generateContentActivity(db, p, null, input);
    expect(r.validationPassed).toBe(false);   // banned word
    const v = tables.content_versions![0]!;
    expect(v).toMatchObject({ version: 1, origin: "ai", prompt_template: "social.post@1", model: "claude-opus-5-5", generation_job_id: "j1" });
    expect((v.body as { doc: ContentDoc }).doc.blocks[0]!.text).toBe("Cheap idli");
    expect((v.validation_report as { issues: Array<{ code: string; blockId: string }> }).issues[0]).toMatchObject({ code: "banned_word", blockId: "b1" });
    expect(tables.content_items![0]).toMatchObject({ type: "social_post", channel: "instagram", status: "draft", current_version_id: v.id, topic_id: "t1" });
    expect(tables.campaign_topics![0]).toMatchObject({ status: "done", content_item_id: tables.content_items![0]!.id });
    const again = await generateContentActivity(db, p, null, input);
    expect(again.contentVersionId).toBe(v.id);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("adds only accepted, matching learnings to the prompt and records which were used", async () => {
    const { db, tables } = await setup({ insights: [
      { id: "i1", workspace_id: WS, brand_id: BRAND, status: "accepted", guidance: "Keep Instagram text around 200 characters.", applies_to: { channel: "instagram" }, decided_at: "2026-11-10" },
      { id: "i2", workspace_id: WS, brand_id: BRAND, status: "accepted", guidance: "Use at most 3 hashtags on X.", applies_to: { channel: "x" }, decided_at: "2026-11-11" },
      { id: "i3", workspace_id: WS, brand_id: BRAND, status: "new", guidance: "Post more videos.", applies_to: { channel: "instagram" }, decided_at: null },
    ] });
    const { p, fn } = llm({ variants: [{ hook: "Idli", body: "Hot by 7am", cta: "Order", hashtags: ["#idli"], alt_text: "", cited_chunk_ids: [] }] });
    await generateContentActivity(db, p, null, { ...base, jobId: "j9", templateKey: "social.post@1", input: { channel: "instagram", topic: "Breakfast" } });
    const user = fn.mock.calls[0]![0].user as string;
    expect(user).toContain("<learnings>");
    expect(user).toContain("Keep Instagram text around 200 characters.");
    expect(user).not.toContain("hashtags on X");
    expect(user).not.toContain("Post more videos");
    expect(tables.content_versions!.at(-1)!.insight_ids).toEqual(["i1"]);
  });

  it("regenerate keeps human-edited blocks byte-for-byte and records what changed", async () => {
    const ai = docFrom([["hook", "Fresh idli"], ["body", "Soft and hot."], ["cta", "Order now"]]);
    const edited = markHumanEdits(ai, { format: 1, blocks: ai.blocks.map((b) => (b.id === "b2" ? { ...b, text: "Made with my grandmother's recipe." } : b)) }).doc;
    const { db, tables } = await setup({
      content_items: [{ id: "ci1", workspace_id: WS, brand_id: BRAND, type: "social_post", channel: "instagram", language: "en", current_version_id: "v1", status: "approved" }],
      content_versions: [{ id: "v1", workspace_id: WS, content_item_id: "ci1", version: 1, body: { format: 1, doc: edited } }],
    });
    const { p } = llm({ blocks: [{ id: "b1", text: "Breakfast, sorted" }, { id: "b2", text: "MODEL TRIED TO CHANGE THIS" }, { id: "b3", text: "Message us" }] });
    await generateContentActivity(db, p, null, { ...base, jobId: "j2", templateKey: "social.post@1", input: {}, mode: "regenerate", contentItemId: "ci1", focus: "festive" });
    const v2 = tables.content_versions!.find((v) => v.version === 2)!;
    const doc = (v2.body as { doc: ContentDoc }).doc;
    expect(doc.blocks.map((b) => [b.text, b.origin])).toEqual([["Breakfast, sorted", "ai"], ["Made with my grandmother's recipe.", "human"], ["Message us", "ai"]]);
    expect(v2).toMatchObject({ origin: "ai_edit", base_version: 1, transform: "regenerate", regenerated_block_ids: ["b1", "b3"] });
    expect(tables.learning_signals![0]).toMatchObject({ signal: "regenerate", details: { focus: "festive", blocks: ["b1", "b3"] } });
    expect(tables.content_items![0]!.current_version_id).toBe(v2.id);
  });

  it("translation creates a linked item in the target language", async () => {
    const { db, tables } = await setup({
      content_items: [{ id: "ci1", workspace_id: WS, brand_id: BRAND, type: "social_post", channel: "instagram", language: "en", current_version_id: "v1", status: "draft" }],
      content_versions: [{ id: "v1", workspace_id: WS, content_item_id: "ci1", version: 3, body: { format: 1, doc: docFrom([["hook", "Fresh idli"]]) } }],
    });
    const { p } = llm({ blocks: [{ id: "b1", text: "తాజా ఇడ్లీ" }] });
    const r = await generateContentActivity(db, p, null, { ...base, jobId: "j3", templateKey: "social.post@1", input: {}, mode: "translate", targetLanguage: "te", contentItemId: "ci1" });
    const item = tables.content_items!.find((i) => i.id === r.contentItemId)!;
    expect(item).toMatchObject({ language: "te", source_item_id: "ci1", type: "social_post" });
    expect(tables.content_versions!.find((v) => v.id === r.contentVersionId)).toMatchObject({ version: 1, origin: "ai", base_version: null });
  });

  it("captions require a reference image", async () => {
    const { db } = await setup();
    const { p } = llm({});
    await expect(generateContentActivity(db, p, null, { ...base, jobId: "j4", templateKey: "social.caption@1", input: { channel: "instagram" } })).rejects.toThrow(/Choose the image/);
  });
});
