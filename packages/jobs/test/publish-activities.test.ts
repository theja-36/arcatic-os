import { describe, expect, it } from "vitest";
import { createPublishActivities } from "../src/publish-activities.js";
import { memDb } from "./mem-db.js";

const WS = "w1";
function seed(extra: Record<string, unknown> = {}) {
  return memDb({
    schedules: [{ id: "s1", workspace_id: WS, brand_id: "b1", content_item_id: "ci", connected_account_id: "acc", content_version_id: "v1", publish_at: "2026-12-01T10:00:00Z",
      status: "publishing", revision: 1, attempts: 1, text_override: null, media_asset_ids: null, channel_settings: {}, ...extra }],
    connected_accounts: [{ id: "acc", workspace_id: WS, brand_id: null, channel: "instagram", transport: "postiz", provider: "postiz:instagram", external_id: "pz-int-1",
      display_name: "@brand", status: "active", enabled: true, min_role: "editor", secret_id: null, settings: { identifier: "instagram" } }],
    content_items: [{ id: "ci", type: "video", title: "Diwali reel", workspace_id: WS, brand_id: "b1", status: "approved" }],
    content_versions: [{ id: "v1", body: { format: 1, doc: { format: 1, blocks: [{ id: "b1", kind: "caption", text: "Happy Diwali! #hyd", origin: "human" }] }, video: { assetId: "m1", projectId: "p", revision: 3 } }, media_asset_ids: ["m1"] }],
    media_assets: [{ id: "m1", workspace_id: WS, kind: "video", status: "ready", storage_path: `${WS}/b1/m1/video.mp4`, mime_type: "video/mp4", width: 1080, height: 1920, duration_ms: 15000 }],
    publishing_jobs: [],
  });
}
function fakePostiz(existing: Array<{ id: string; group: string; state: string }> = []) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    listPosts: async () => ({ posts: existing.map((p) => ({ ...p, releaseURL: null, error: null })) }),
    deletePost: async (id: string) => { calls.push(["delete", id]); },
    uploadFromUrl: async (url: string) => { calls.push(["upload", url]); return { id: "media-1", path: "https://postiz.test/uploads/video.mp4" }; },
    createPost: async (body: unknown) => { calls.push(["create", body]); return [{ postId: "post-1", integration: "pz-int-1" }]; },
  };
  return { client, calls };
}

describe("publish activities", () => {
  it("uploads media to Postiz and creates one post with the provider settings and our job id as group", async () => {
    const m = seed();
    const pz = fakePostiz();
    const acts = createPublishActivities({ db: m.db, postiz: async () => pz.client as never });
    const out = await acts.publishTarget({ scheduleId: "s1" });
    expect(out).toEqual({ outcome: "submitted", externalId: "post-1" });
    expect(pz.calls[0]).toEqual(["upload", `https://storage.test/${WS}/b1/m1/video.mp4?token=t`]);
    const body = pz.calls[1]![1] as { type: string; posts: Array<{ group: string; integration: { id: string }; value: Array<{ content: string; image: unknown[] }>; settings: Record<string, unknown> }> };
    const job = m.tables.publishing_jobs![0]!;
    expect(body.type).toBe("now");
    expect(body.posts[0]!.group).toBe(job.id);
    expect(body.posts[0]!.integration.id).toBe("pz-int-1");
    expect(body.posts[0]!.value[0]!.content).toBe("Happy Diwali! #hyd");
    expect(body.posts[0]!.value[0]!.image).toEqual([{ id: "media-1", path: "https://postiz.test/uploads/video.mp4" }]);
    expect(body.posts[0]!.settings).toMatchObject({ __type: "instagram", post_type: "post" });
    expect(job).toMatchObject({ idempotency_key: "schedule:s1:1", external_post_id: "post-1" });
  });

  it("tags links with utm_* (channel, campaign slug, target id) so website visits can be attributed", async () => {
    const m = seed();
    m.tables.content_items![0]!.campaign = { name: "Diwali Offer 2026" };
    (m.tables.content_versions![0]!.body as { doc: { blocks: Array<{ text: string }> } }).doc.blocks[0]!.text = "Order now: https://cafe.example/menu";
    const pz = fakePostiz();
    await createPublishActivities({ db: m.db, postiz: async () => pz.client as never }).publishTarget({ scheduleId: "s1" });
    const body = pz.calls.find((c) => c[0] === "create")![1] as { posts: Array<{ value: Array<{ content: string }> }> };
    expect(body.posts[0]!.value[0]!.content).toBe("Order now: https://cafe.example/menu?utm_source=instagram&utm_medium=social&utm_campaign=diwali-offer-2026&utm_content=s1");
  });

  it("reuses a post from an earlier try instead of posting twice", async () => {
    const m = seed();
    m.tables.publishing_jobs!.push({ id: "job-1", workspace_id: WS, idempotency_key: "schedule:s1:1", external_post_id: null, external_ref: {} });
    const pz = fakePostiz([{ id: "post-old", group: "job-1", state: "QUEUE" }]);
    const acts = createPublishActivities({ db: m.db, postiz: async () => pz.client as never });
    expect(await acts.publishTarget({ scheduleId: "s1" })).toEqual({ outcome: "submitted", externalId: "post-old" });
    expect(pz.calls).toEqual([]);
  });

  it("refuses to publish when the target fails validation (non-retryable)", async () => {
    const m = seed({ media_asset_ids: [] });   // Instagram without media
    const acts = createPublishActivities({ db: m.db, postiz: async () => fakePostiz().client as never });
    await expect(acts.publishTarget({ scheduleId: "s1" })).rejects.toMatchObject({ type: "publish_rejected", nonRetryable: true });
  });

  it("finishing marks the post published, the content published, and an expired login asks to reconnect", async () => {
    const m = seed();
    m.tables.publishing_jobs!.push({ id: "job-1", workspace_id: WS, idempotency_key: "schedule:s1:1", status: "publishing" });
    const acts = createPublishActivities({ db: m.db });
    await acts.finishTarget({ scheduleId: "s1", status: "published", externalId: "post-1", url: "https://instagram.test/p/1" });
    expect(m.tables.schedules![0]).toMatchObject({ status: "published", external_url: "https://instagram.test/p/1" });
    expect(m.tables.content_items![0]!.status).toBe("published");
    expect(m.tables.publishing_jobs![0]!.status).toBe("published");

    const m2 = seed();
    await createPublishActivities({ db: m2.db }).finishTarget({ scheduleId: "s1", status: "failed", error: { kind: "reconnect_needed", message: "Please re-authenticate" } });
    expect(m2.tables.schedules![0]).toMatchObject({ status: "failed" });
    expect(m2.tables.connected_accounts![0]).toMatchObject({ status: "refresh_needed", last_error: "Please re-authenticate" });
  });
});
