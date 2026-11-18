import type { ContentDoc, DocIssue, Scene, SceneIssue } from "@arcatic/core";

export type Version = {
  id: string; version: number; origin: string; transform: string | null; base_version: number | null; model: string | null; prompt_template: string | null;
  credits_cost: number | null; created_at: string; regenerated_block_ids: string[];
  validation_report: { passed: boolean; issues: DocIssue[]; stats?: { length: number; limit?: number }; scene?: { passed: boolean; issues: SceneIssue[] } } | null;
  body?: { doc: ContentDoc; scene?: Scene; variants?: ContentDoc[]; images?: string[]; video?: { assetId: string; projectId: string; revision: number } };
  prompt?: string; source_chunk_ids?: string[]; depends_on_facts?: string[]; brand_context_version?: number;
};
export type Item = {
  id: string; type: string; channel: string | null; language: string; title: string | null; status: string; current_version_id: string | null; source_item_id: string | null;
  project_id?: string | null; repurpose_run_id?: string | null; source_ref?: { kind: string; id: string; title: string; url?: string | null; sourceType?: string | null } | null;
  version: Version | null; editable: boolean;
  approvals: Array<{ id: string; status: string; comment: string | null; requested_by: string | null; decided_at: string | null; created_at: string; content_version_id: string }>;
  translations: Array<{ id: string; language: string; status: string }>;
};

export const KIND_LABEL: Record<string, string> = {
  title: "Title", hook: "Hook", body: "Body", cta: "Call to action", hashtags: "Hashtags", alt_text: "Image description (alt text)", caption: "Caption",
  subject: "Subject line", preheader: "Preheader", heading: "Heading", paragraph: "Paragraph", list_item: "List item", quote: "Quote", meta_description: "Meta description",
  tweet: "Post", scene: "Scene (what to show)", voiceover: "Voiceover", on_screen_text: "On-screen text", description: "Description", chapter: "Chapter",
  headline: "Headline", primary_text: "Primary text", link_description: "Link description", slide_headline: "Slide headline", slide_body: "Slide text", subhead: "Subhead", image_prompt: "Image idea",
};
