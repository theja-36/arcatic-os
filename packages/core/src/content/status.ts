/** Content lifecycle (DB: content_items.status; transitions enforced in SQL functions/triggers). */
export const CONTENT_STATUSES = ["draft", "generating", "in_review", "changes_requested", "approved", "scheduled", "published", "failed", "archived"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const canEditContent = (s: ContentStatus) => !["generating", "published", "scheduled"].includes(s);
export const canSubmitContent = (s: ContentStatus) => ["draft", "changes_requested", "failed"].includes(s);
export const canArchiveContent = (s: ContentStatus) => s !== "generating";
