"use client";
import type { PublishChannel } from "@arcatic/core";
import { Input } from "@arcatic/ui";

type Field =
  | { key: string; label: string; type: "select"; options: Array<[string, string]> }
  | { key: string; label: string; type: "text" | "url" | "date" | "time" | "email"; placeholder?: string }
  | { key: string; label: string; type: "checkbox" }
  | { key: string; label: string; type: "tags"; placeholder?: string };

/** Per-channel options; keys and values mirror the Postiz settings DTOs (see core/publishing/channels.ts). */
export const CHANNEL_FIELDS: Record<PublishChannel, Field[]> = {
  instagram: [
    { key: "post_type", label: "Post as", type: "select", options: [["post", "Feed post / Reel"], ["story", "Story"]] },
    { key: "is_trial_reel", label: "Trial Reel (shown to non-followers first)", type: "checkbox" },
  ],
  facebook: [
    { key: "post_type", label: "Post as", type: "select", options: [["post", "Post"], ["story", "Story"]] },
    { key: "url", label: "Link to attach", type: "url", placeholder: "https://…" },
  ],
  linkedin: [{ key: "post_as_images_carousel", label: "Post images as a carousel (PDF slides)", type: "checkbox" }],
  x: [{ key: "who_can_reply_post", label: "Who can reply", type: "select", options: [["everyone", "Everyone"], ["following", "People you follow"], ["mentionedUsers", "Only people mentioned"], ["subscribers", "Subscribers"], ["verified", "Verified accounts"]] }],
  tiktok: [
    { key: "title", label: "Title (up to 90 characters)", type: "text" },
    { key: "privacy_level", label: "Who can watch", type: "select", options: [["PUBLIC_TO_EVERYONE", "Everyone"], ["MUTUAL_FOLLOW_FRIENDS", "Friends"], ["FOLLOWER_OF_CREATOR", "Followers"], ["SELF_ONLY", "Only me"]] },
    { key: "content_posting_method", label: "How", type: "select", options: [["DIRECT_POST", "Post directly"], ["UPLOAD", "Send to TikTok inbox to finish in the app"]] },
    { key: "comment", label: "Allow comments", type: "checkbox" },
    { key: "duet", label: "Allow duets", type: "checkbox" },
    { key: "stitch", label: "Allow stitches", type: "checkbox" },
    { key: "brand_organic_toggle", label: "Promotes our own brand", type: "checkbox" },
    { key: "brand_content_toggle", label: "Paid partnership (branded content)", type: "checkbox" },
    { key: "video_made_with_ai", label: "Made with AI", type: "checkbox" },
  ],
  youtube: [
    { key: "title", label: "Title (up to 100 characters)", type: "text" },
    { key: "type", label: "Visibility", type: "select", options: [["public", "Public"], ["unlisted", "Unlisted"], ["private", "Private"]] },
    { key: "selfDeclaredMadeForKids", label: "Made for kids", type: "select", options: [["no", "No"], ["yes", "Yes"]] },
    { key: "tags", label: "Tags", type: "tags", placeholder: "hyderabad, cafe, offer" },
    { key: "made_with_ai", label: "Contains realistic AI-generated content", type: "checkbox" },
  ],
  threads: [{ key: "made_with_ai", label: "Label as AI-generated", type: "checkbox" }],
  gbp: [
    { key: "topicType", label: "Post type", type: "select", options: [["STANDARD", "Update"], ["EVENT", "Event"], ["OFFER", "Offer"]] },
    { key: "callToActionType", label: "Button", type: "select", options: [["NONE", "None"], ["BOOK", "Book"], ["ORDER", "Order"], ["SHOP", "Shop"], ["LEARN_MORE", "Learn more"], ["SIGN_UP", "Sign up"], ["GET_OFFER", "Get offer"], ["CALL", "Call"]] },
    { key: "callToActionUrl", label: "Button link", type: "url", placeholder: "https://…" },
    { key: "eventTitle", label: "Event title", type: "text" },
    { key: "eventStartDate", label: "Event starts", type: "date" },
    { key: "eventEndDate", label: "Event ends", type: "date" },
  ],
  wordpress: [
    { key: "title", label: "Post title", type: "text" },
    { key: "status", label: "Status on the site", type: "select", options: [["publish", "Published"], ["draft", "Draft"], ["pending", "Pending review"], ["private", "Private"]] },
  ],
  email: [
    { key: "subject", label: "Subject", type: "text" },
    { key: "preheader", label: "Preview text", type: "text" },
    { key: "fromName", label: "From name", type: "text" },
    { key: "fromAddress", label: "From address", type: "email" },
  ],
};

export function ChannelSettings({ channel, value, onChange, disabled }: { channel: PublishChannel; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; disabled?: boolean }) {
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v === "" ? undefined : v });
  const fields = CHANNEL_FIELDS[channel];
  if (!fields.length) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {fields.map((f) => {
        if (channel === "gbp" && f.key.startsWith("event") && value.topicType !== "EVENT") return null;
        if (channel === "gbp" && f.key === "callToActionUrl" && (!value.callToActionType || value.callToActionType === "NONE" || value.callToActionType === "CALL")) return null;
        if (f.type === "checkbox") {
          return <label key={f.key} className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={disabled} checked={!!value[f.key]} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}</label>;
        }
        return (
          <label key={f.key} className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--text-muted)]">{f.label}</span>
            {f.type === "select" ? (
              <select disabled={disabled} className="h-8 rounded border border-[var(--border)] bg-[var(--surface)] px-1" value={String(value[f.key] ?? f.options[0]![0])} onChange={(e) => set(f.key, e.target.value)}>
                {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ) : f.type === "tags" ? (
              <Input disabled={disabled} className="h-8" placeholder={f.placeholder} value={((value[f.key] as Array<{ label: string }> | undefined) ?? []).map((t) => t.label).join(", ")}
                onChange={(e) => set(f.key, e.target.value.split(",").map((t) => t.trim()).filter(Boolean).map((t) => ({ value: t, label: t })))} />
            ) : (
              <Input disabled={disabled} className="h-8" type={f.type} placeholder={"placeholder" in f ? f.placeholder : undefined} value={String(value[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />
            )}
          </label>
        );
      })}
    </div>
  );
}
