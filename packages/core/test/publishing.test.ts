import { describe, expect, it } from "vitest";
import {
  CHANNEL_RULES, buildCalendar, channelForIdentifier, classifyFailure, docFrom, docToHtml, emailParts, postText, validateTarget, type MediaFacts,
} from "../src/index.js";

const img = (w = 1080, h = 1350, ext = "jpg"): MediaFacts => ({ assetId: "i", kind: "image", ext, width: w, height: h });
const vid = (w = 1080, h = 1920, ext = "mp4", durationMs = 30_000): MediaFacts => ({ assetId: "v", kind: "video", ext, width: w, height: h, durationMs });

describe("channel registry", () => {
  it("maps Postiz identifiers to channels", () => {
    expect(channelForIdentifier("instagram-standalone")).toBe("instagram");
    expect(channelForIdentifier("linkedin-page")).toBe("linkedin");
    expect(channelForIdentifier("gmb")).toBe("gbp");
    expect(channelForIdentifier("tiktok-business")).toBe("tiktok");
    expect(channelForIdentifier("mastodon")).toBeNull();
  });
  it("uses the limits Postiz enforces", () => {
    expect(CHANNEL_RULES.tiktok.maxChars).toBe(2000);
    expect(CHANNEL_RULES.gbp.maxChars).toBe(1500);
    expect(CHANNEL_RULES.threads.maxChars).toBe(500);
  });
});

describe("validateTarget", () => {
  it("Instagram needs media; YouTube needs exactly one video and a title", () => {
    expect(validateTarget({ channel: "instagram", text: "hi", media: [], settings: {} }).passed).toBe(false);
    expect(validateTarget({ channel: "instagram", text: "hi", media: [img()], settings: {} }).passed).toBe(true);
    const yt = validateTarget({ channel: "youtube", text: "desc", media: [img()], settings: {} });
    expect(yt.issues.map((i) => i.message).join(" ")).toMatch(/title/);
    expect(yt.issues.map((i) => i.message).join(" ")).toMatch(/exactly one video/);
    expect(validateTarget({ channel: "youtube", text: "d", media: [vid()], settings: { title: "Launch" } }).passed).toBe(true);
  });
  it("applies defaults from the Postiz settings DTOs", () => {
    const r = validateTarget({ channel: "tiktok", text: "x", media: [vid()], settings: {} });
    expect(r.settings).toMatchObject({ privacy_level: "PUBLIC_TO_EVERYONE", content_posting_method: "DIRECT_POST", duet: false });
    expect(validateTarget({ channel: "x", text: "x", media: [], settings: {} }).settings).toMatchObject({ who_can_reply_post: "everyone" });
  });
  it("refuses media formats Postiz won't take", () => {
    const r = validateTarget({ channel: "facebook", text: "x", media: [vid(1920, 1080, "mov")], settings: {} });
    expect(r.passed).toBe(false);
    expect(r.issues[0]!.message).toMatch(/\.mov/);
  });
  it("TikTok: no mixing, photos ≤ 1080 short side, horizontal video warns", () => {
    expect(validateTarget({ channel: "tiktok", text: "x", media: [vid(), img()], settings: {} }).passed).toBe(false);
    expect(validateTarget({ channel: "tiktok", text: "x", media: [img(1440, 1800)], settings: {} }).passed).toBe(false);
    const h = validateTarget({ channel: "tiktok", text: "x", media: [vid(1920, 1080)], settings: {} });
    expect(h.passed).toBe(true);
    expect(h.issues.some((i) => i.severity === "warning")).toBe(true);
  });
  it("X thread: every post within 280 (weighted)", () => {
    const r = validateTarget({ channel: "x", text: "a", thread: ["a", "b".repeat(281)], media: [], settings: {} });
    expect(r.passed).toBe(false);
    expect(r.issues[0]!.message).toMatch(/Post 2/);
  });
  it("Business Profile: one image, no video, event needs a title, CTA needs a link", () => {
    expect(validateTarget({ channel: "gbp", text: "x", media: [img(), img()], settings: {} }).passed).toBe(false);
    expect(validateTarget({ channel: "gbp", text: "x", media: [vid()], settings: {} }).passed).toBe(false);
    expect(validateTarget({ channel: "gbp", text: "x", media: [], settings: { topicType: "EVENT" } }).passed).toBe(false);
    expect(validateTarget({ channel: "gbp", text: "x", media: [], settings: { callToActionType: "BOOK" } }).passed).toBe(false);
    expect(validateTarget({ channel: "gbp", text: "x", media: [img()], settings: { callToActionType: "BOOK", callToActionUrl: "https://example.com/book" } }).passed).toBe(true);
  });
  it("WordPress needs a title and body; email a subject", () => {
    expect(validateTarget({ channel: "wordpress", text: "", html: "<p>x</p>", media: [], settings: {} }).passed).toBe(false);
    expect(validateTarget({ channel: "wordpress", text: "", html: "<p>x</p>", media: [], settings: { title: "Hello" } }).passed).toBe(true);
    expect(validateTarget({ channel: "email", text: "", html: "<p>x</p>", media: [], settings: { subject: "Offer" } }).passed).toBe(true);
  });
  it("counts Telugu by graphemes", () => {
    const te = "తెలుగు ".repeat(70);   // 7 graphemes per repeat → 490
    expect(validateTarget({ channel: "threads", text: te, media: [], settings: {} }).passed).toBe(true);
  });
});

describe("text builders", () => {
  it("social text skips alt text and image prompts; X threads split by tweet", () => {
    const doc = docFrom([["hook", "Big news"], ["body", "We open Monday."], ["alt_text", "A shop"], ["hashtags", "#hyd"]]);
    expect(postText("social_post", doc).text).not.toMatch(/A shop/);
    expect(postText("social_post", doc).text).toMatch(/#hyd/);
    const t = postText("x_thread", docFrom([["tweet", "1/ one"], ["tweet", "2/ two"]]));
    expect(t.thread).toEqual(["1/ one", "2/ two"]);
  });
  it("HTML escapes text and groups list items", () => {
    const html = docToHtml(docFrom([["title", "T"], ["heading", "A <b>"], ["list_item", "one"], ["list_item", "two"], ["paragraph", "see https://x.test"]]));
    expect(html).toContain("<h2>A &lt;b&gt;</h2>");
    expect(html).toContain("<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
    expect(html).toContain('<a href="https://x.test">');
    expect(html).not.toContain("<h1>");
  });
  it("email has subject, preheader and Mautic's unsubscribe token", () => {
    const e = emailParts(docFrom([["subject", "Diwali sale"], ["preheader", "Up to 30% off"], ["paragraph", "Hello"]]));
    expect(e.subject).toBe("Diwali sale");
    expect(e.html).toContain("{unsubscribe_text}");
  });
});

describe("failure classification", () => {
  it("separates reconnect, retry and content errors", () => {
    expect(classifyFailure("Please re-authenticate your Facebook account")).toMatchObject({ kind: "auth", reconnect: true, retryable: false });
    expect(classifyFailure("postiz POST /posts → 503", 503)).toMatchObject({ kind: "transient", retryable: true });
    expect(classifyFailure("Instagram carousel only supports up to 20 media attachments")).toMatchObject({ kind: "content", retryable: false });
  });
});

describe("calendar", () => {
  it("shows posts, planned topics and drafts once, and lists undated drafts separately", () => {
    const r = buildCalendar({
      topics: [
        { id: "t1", title: "Idea", planned_for: "2026-12-01", status: "idea", channel: "instagram", campaign_id: "c", content_item_id: null },
        { id: "t2", title: "Draft topic", planned_for: "2026-12-02", status: "in_production", channel: "x", campaign_id: "c", content_item_id: "i2" },
        { id: "t3", title: "Posted topic", planned_for: "2026-12-03", status: "done", channel: "x", campaign_id: "c", content_item_id: "i3" },
      ],
      items: [
        { id: "i2", title: "Draft", status: "in_review", channel: "x", type: "social_post", updated_at: "2026-11-20T00:00:00Z" },
        { id: "i3", title: "Posted", status: "published", channel: "x", type: "social_post", updated_at: "2026-11-20T00:00:00Z" },
        { id: "i4", title: "Loose draft", status: "draft", channel: null, type: "email", updated_at: "2026-11-21T00:00:00Z" },
      ],
      schedules: [{ id: "s1", group_id: "g", content_item_id: "i3", publish_at: "2026-12-03T10:00:00Z", status: "published", external_url: "https://x.test/1", last_error: null, account: { display_name: "@brand", channel: "x" } }],
      metrics: { s1: { impressions: 120 } },
    });
    expect(r.entries.map((e) => `${e.kind}:${e.state}`)).toEqual(["topic:idea", "content:in_review", "post:published"]);
    expect(r.entries[2]!.metrics?.impressions).toBe(120);
    expect(r.unscheduled.map((e) => e.title)).toEqual(["Loose draft"]);
  });
});
