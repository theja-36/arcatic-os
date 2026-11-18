import { LANGUAGES, type ContentType } from "./types.js";
import { SIZE_PRESETS, VISUAL_TEMPLATES } from "./visual.js";

/**
 * Guided creation wizards. Declarative: the web renders the steps, `toRequest` turns the answers
 * into the normal generation request (POST /brands/:id/content), and tests check every wizard's
 * request against its template's input schema. Repurposing has its own flow (repurpose.ts).
 */
export type FieldKind = "text" | "textarea" | "number" | "select" | "multiselect" | "language" | "sources" | "image" | "toggle";

export interface WizardField {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: Array<[string, string]>;
  min?: number;
  max?: number;
  maxLength?: number;
  default?: string | number | boolean | string[];
}

export interface WizardStep { title: string; fields: WizardField[] }

export type WizardGroup = "Ideas" | "Social" | "Long-form" | "Sales & web" | "Visual" | "Video" | "Repurpose" | "Documents";

export interface Wizard {
  id: string;
  label: string;
  description: string;
  group: WizardGroup;
  /** the content type created (for repurpose wizards: undefined, handled by /repurpose) */
  type?: ContentType;
  /** let the person choose between closely related types */
  typeChoice?: Array<[ContentType, string]>;
  steps: WizardStep[];
  /** link instead of a form (e.g. video editor, repurpose page) */
  href?: "repurpose" | "videos";
}

export type WizardValues = Record<string, unknown>;
export interface GenerationRequest {
  type: ContentType;
  input: Record<string, unknown>;
  referenceSourceIds?: string[];
  referenceMediaIds?: string[];
  visual?: { preset: string; template: string; imageAssetId?: string | null };
  image?: { prompt: string; preset: string; count: number; productAssetId?: string };
  projectId?: string;
}

const LANG_FIELD: WizardField = { key: "language", label: "Language", kind: "language", default: "en", options: Object.entries(LANGUAGES) };
const SOURCES_FIELD: WizardField = { key: "__sources", label: "Use facts from (optional)", kind: "sources", help: "Pick Knowledge sources to draw facts and citations from. Leave empty to search the whole library." };
const AUDIENCE: WizardField = { key: "audience", label: "Who is it for?", kind: "text", maxLength: 300, placeholder: "e.g. office managers in Hyderabad" };
const GOAL: WizardField = { key: "goal", label: "What should it achieve?", kind: "text", maxLength: 300, placeholder: "e.g. book a table for Diwali" };
const CTA: WizardField = { key: "cta", label: "Call to action", kind: "text", maxLength: 300, placeholder: "e.g. Order on our website" };
const FOCUS: WizardField = { key: "focus", label: "Anything else the writer should know?", kind: "textarea", maxLength: 1000 };
const SOCIAL_CH: Array<[string, string]> = [["instagram", "Instagram"], ["facebook", "Facebook"], ["linkedin", "LinkedIn"], ["x", "X"], ["threads", "Threads"], ["tiktok", "TikTok"], ["youtube", "YouTube"], ["gbp", "Business Profile"]];
const finishing: WizardStep = { title: "Finishing touches", fields: [LANG_FIELD, FOCUS, SOURCES_FIELD] };

export const WIZARDS: Wizard[] = [
  {
    id: "brainstorm", label: "Brainstorm ideas", group: "Ideas", type: "brainstorm",
    description: "A list of content ideas with angle, format and channel. Turn the ones you like into drafts.",
    steps: [
      { title: "What do you need ideas for?", fields: [{ key: "topic", label: "Theme, product, season or goal", kind: "textarea", required: true, maxLength: 2000, placeholder: "e.g. Diwali sweets boxes for corporate gifting" }, AUDIENCE, GOAL] },
      { title: "Shape the list", fields: [
        { key: "count", label: "How many ideas", kind: "number", min: 5, max: 30, default: 10 },
        { key: "formats", label: "Formats to include", kind: "multiselect", default: ["social_post", "carousel", "short_video", "blog", "email"], options: [["social_post", "Social post"], ["carousel", "Carousel"], ["short_video", "Short video"], ["blog", "Blog article"], ["email", "Email"], ["x_thread", "X thread"], ["newsletter", "Newsletter"], ["case_study", "Case study"]] },
        { key: "channels", label: "Channels", kind: "multiselect", default: ["instagram", "linkedin"], options: SOCIAL_CH },
      ] },
      finishing,
    ],
  },
  {
    id: "social", label: "Social post", group: "Social", type: "social_post",
    typeChoice: [["social_post", "Post"], ["carousel", "Carousel"], ["story", "Story"]],
    description: "Step by step: channel, message, audience and call to action.",
    steps: [
      { title: "Where and what", fields: [{ key: "channel", label: "Channel", kind: "select", options: SOCIAL_CH, default: "instagram", required: true }, { key: "topic", label: "What is the post about?", kind: "textarea", required: true, maxLength: 2000 }] },
      { title: "Who and why", fields: [AUDIENCE, GOAL, CTA, { key: "variants", label: "Versions to compare", kind: "number", min: 1, max: 3, default: 1 }] },
      finishing,
    ],
  },
  {
    id: "visual", label: "Branded graphic", group: "Visual", type: "static_visual",
    description: "Headline, sub-headline and button text laid out on your brand colours, editable on the canvas.",
    steps: [
      { title: "The message", fields: [{ key: "topic", label: "What should the graphic say?", kind: "textarea", required: true, maxLength: 2000 }, CTA] },
      { title: "Size and layout", fields: [
        { key: "__preset", label: "Size", kind: "select", required: true, default: "instagram-square", options: ["instagram-square", "instagram-portrait", "story", "facebook-post", "linkedin-post", "x-post"].map((k) => [k, SIZE_PRESETS[k as keyof typeof SIZE_PRESETS].label]) },
        { key: "__template", label: "Layout", kind: "select", required: true, default: "bold-headline", options: ["bold-headline", "photo-overlay", "split-offer", "quote-card"].map((k) => [k, VISUAL_TEMPLATES[k as keyof typeof VISUAL_TEMPLATES]]) },
        { key: "__image", label: "Background photo (optional)", kind: "image" },
      ] },
      finishing,
    ],
  },
  {
    id: "newsletter", label: "Newsletter", group: "Long-form", type: "newsletter",
    description: "An email newsletter issue: subject options, preheader, sections and one clear call to action.",
    steps: [
      { title: "This issue", fields: [{ key: "topic", label: "What's in this issue?", kind: "textarea", required: true, maxLength: 2000, placeholder: "News, offers, tips…" }, { key: "sections", label: "Sections", kind: "number", min: 2, max: 6, default: 3 }] },
      { title: "Readers", fields: [AUDIENCE, CTA] },
      finishing,
    ],
  },
  {
    id: "press_release", label: "Press release", group: "Long-form", type: "press_release",
    description: "Headline, dateline, lead, body, a quote you supply, boilerplate and media contact.",
    steps: [
      { title: "The news", fields: [{ key: "topic", label: "What is being announced? Include the facts.", kind: "textarea", required: true, maxLength: 2000 }, { key: "location", label: "City for the dateline", kind: "text", maxLength: 80, placeholder: "Hyderabad" }, { key: "release_date", label: "Release date", kind: "text", maxLength: 40, placeholder: "17 November 2026" }] },
      { title: "Quote and contact", fields: [
        { key: "quote_text", label: "Quote (exact words)", kind: "textarea", maxLength: 600, help: "Arcatic won't invent quotes. Leave empty to get a marked placeholder." },
        { key: "quote_person", label: "Quoted person", kind: "text", maxLength: 120 }, { key: "quote_role", label: "Their role", kind: "text", maxLength: 120 },
        { key: "contact", label: "Media contact", kind: "text", maxLength: 300, placeholder: "Name, email, phone" },
      ] },
      finishing,
    ],
  },
  {
    id: "case_study", label: "Case study", group: "Long-form", type: "case_study",
    description: "Customer story: challenge, solution and results, using only the facts you give.",
    steps: [
      { title: "The customer", fields: [{ key: "customer", label: "Customer name", kind: "text", required: true, maxLength: 120 }, { key: "industry", label: "Industry", kind: "text", maxLength: 120 }] },
      { title: "The story", fields: [
        { key: "challenge", label: "Their challenge", kind: "textarea", required: true, maxLength: 1500 },
        { key: "solution", label: "What you did", kind: "textarea", required: true, maxLength: 1500 },
        { key: "results", label: "Results (numbers only if they're real)", kind: "textarea", required: true, maxLength: 1500 },
        { key: "quote_text", label: "Customer quote (exact words, optional)", kind: "textarea", maxLength: 600 }, { key: "quote_person", label: "Quoted person", kind: "text", maxLength: 120 },
      ] },
      finishing,
    ],
  },
  {
    id: "brief", label: "Creative brief", group: "Documents", type: "brief",
    description: "A one-page brief for a campaign or asset: objective, audience, message, deliverables, mandatories.",
    steps: [
      { title: "Objective", fields: [{ key: "topic", label: "What's the brief for?", kind: "textarea", required: true, maxLength: 2000 }, AUDIENCE, GOAL] },
      { title: "Scope", fields: [{ key: "deliverables", label: "Deliverables", kind: "textarea", maxLength: 500, placeholder: "3 reels, 1 landing page, 2 emails" }, { key: "timeline", label: "Timeline", kind: "text", maxLength: 200 }, { key: "budget", label: "Budget (optional)", kind: "text", maxLength: 100 }, { key: "mandatories", label: "Must include / avoid", kind: "textarea", maxLength: 800 }] },
      finishing,
    ],
  },
  {
    id: "landing_page", label: "Landing-page copy", group: "Sales & web", type: "landing_page",
    description: "Hero, benefits, how it works, proof, FAQ and call to action, with SEO title and description.",
    steps: [
      { title: "The offer", fields: [{ key: "topic", label: "What is the page selling or asking for?", kind: "textarea", required: true, maxLength: 2000 }, { key: "offer", label: "The offer, in one line", kind: "text", maxLength: 500 }, CTA] },
      { title: "Page", fields: [AUDIENCE, { key: "sections", label: "Sections", kind: "number", min: 3, max: 8, default: 5 }, { key: "keyword", label: "Search keyword (optional)", kind: "text", maxLength: 120 }] },
      finishing,
    ],
  },
  {
    id: "sales_sheet", label: "Sales sheet", group: "Sales & web", type: "sales_sheet",
    description: "A one-page sell sheet: headline, problem, benefits, differentiators, proof and contact.",
    steps: [
      { title: "Product", fields: [{ key: "product", label: "Product or service", kind: "text", required: true, maxLength: 200 }, { key: "topic", label: "What makes it worth buying?", kind: "textarea", required: true, maxLength: 2000 }, { key: "differentiators", label: "Why you vs alternatives", kind: "textarea", maxLength: 1500 }] },
      { title: "Buyer", fields: [AUDIENCE, { key: "pricing", label: "Pricing to show (optional)", kind: "text", maxLength: 200 }, CTA] },
      finishing,
    ],
  },
  {
    id: "product_copy", label: "Product copy", group: "Sales & web", type: "product_copy",
    description: "Product title, short description, feature bullets, long description and SEO meta.",
    steps: [
      { title: "Product", fields: [{ key: "product", label: "Product name", kind: "text", required: true, maxLength: 200 }, { key: "topic", label: "Features, materials, sizes, use (facts only)", kind: "textarea", required: true, maxLength: 2000 }] },
      { title: "Where it sells", fields: [{ key: "channel", label: "For", kind: "select", default: "website", options: [["website", "Our website"], ["marketplace", "A marketplace listing"]] }, { key: "bullets", label: "Bullets", kind: "number", min: 3, max: 8, default: 5 }, { key: "keyword", label: "Search keyword (optional)", kind: "text", maxLength: 120 }, AUDIENCE] },
      finishing,
    ],
  },
  { id: "product_photo", label: "Product photo", group: "Visual", type: "product_photo", description: "Restyle a product photo into a new scene (AI image).", steps: [] },
  { id: "profile_asset", label: "Profile assets", group: "Visual", type: "profile_asset", description: "Profile picture, cover, banner, YouTube thumbnail or sticker in exact platform sizes.", steps: [] },
  {
    id: "facebook_ad", label: "Facebook / Instagram ad", group: "Sales & web", type: "ad",
    description: "Three primary texts, headlines and descriptions within Meta's limits and ad standards.",
    steps: [
      { title: "Campaign", fields: [{ key: "objective", label: "Objective", kind: "select", default: "traffic", options: [["awareness", "Awareness"], ["traffic", "Traffic"], ["leads", "Leads"], ["sales", "Sales"]] }, { key: "topic", label: "What are you advertising?", kind: "textarea", required: true, maxLength: 2000 }, { key: "offer", label: "Offer", kind: "text", maxLength: 300 }] },
      { title: "Audience", fields: [{ key: "channel", label: "Placement", kind: "select", default: "facebook", options: [["facebook", "Facebook"], ["instagram", "Instagram"]] }, AUDIENCE, CTA] },
      finishing,
    ],
  },
  {
    id: "youtube_script", label: "YouTube or short-video script", group: "Video", type: "yt_script",
    typeChoice: [["yt_script", "YouTube video"], ["short_video", "Short (Reel / TikTok / Short)"]],
    description: "Hook, scenes with visuals and voiceover, on-screen text, chapters and description.",
    steps: [
      { title: "Video", fields: [{ key: "topic", label: "What is the video about?", kind: "textarea", required: true, maxLength: 2000 }, { key: "seconds", label: "Length (seconds)", kind: "number", min: 15, max: 1800, default: 480 }] },
      { title: "Viewers", fields: [AUDIENCE, CTA] },
      finishing,
    ],
  },
  {
    id: "x_thread", label: "X thread", group: "Social", type: "x_thread",
    description: "A thread with a stand-alone hook and a call to action at the end.",
    steps: [
      { title: "Thread", fields: [{ key: "topic", label: "What is the thread about?", kind: "textarea", required: true, maxLength: 2000 }, { key: "posts", label: "Posts", kind: "number", min: 3, max: 15, default: 6 }] },
      { title: "Readers", fields: [AUDIENCE, CTA] },
      finishing,
    ],
  },
  {
    id: "document", label: "AI document", group: "Documents", type: "document",
    description: "One-pager, proposal, guide, FAQ or policy. Then edit it with AI: shorten, simplify, change tone or give your own instruction.",
    steps: [
      { title: "Document", fields: [
        { key: "kind", label: "Kind", kind: "select", default: "one_pager", options: [["one_pager", "One-pager"], ["proposal", "Proposal"], ["guide", "How-to guide"], ["faq", "FAQ"], ["article", "Article"], ["policy", "Policy / terms (draft)"], ["other", "Other"]] },
        { key: "topic", label: "What should it cover?", kind: "textarea", required: true, maxLength: 2000 },
        { key: "outline", label: "Outline or notes (optional)", kind: "textarea", maxLength: 3000 },
        { key: "words", label: "Length (words)", kind: "number", min: 200, max: 3000, default: 700 },
      ] },
      { title: "Readers", fields: [AUDIENCE, GOAL] },
      finishing,
    ],
  },
  { id: "repurpose_video", label: "Video → content", group: "Repurpose", href: "repurpose", description: "Turn a transcribed video into posts, a blog, an email and more, each citing the transcript.", steps: [] },
  { id: "repurpose_source", label: "Website, document or blog → content", group: "Repurpose", href: "repurpose", description: "One URL, PDF or article becomes many channel-specific pieces with source attribution.", steps: [] },
];

export const wizardById = (id: string) => WIZARDS.find((w) => w.id === id);

/** Default answers for a wizard. */
export function wizardDefaults(w: Wizard): WizardValues {
  const v: WizardValues = {};
  for (const s of w.steps) for (const f of s.fields) if (f.default !== undefined) v[f.key] = f.default;
  if (w.type) v.__type = w.type;
  return v;
}

/** Missing required answers in one step (keys). */
export function missingFields(step: WizardStep, v: WizardValues): string[] {
  return step.fields.filter((f) => f.required && (v[f.key] === undefined || v[f.key] === null || String(v[f.key]).trim() === "" || (Array.isArray(v[f.key]) && !(v[f.key] as unknown[]).length))).map((f) => f.key);
}

/** Wizard answers → the normal generation request. Keys starting with "__" are request-level, not template input. */
export function wizardToRequest(w: Wizard, v: WizardValues): GenerationRequest {
  const type = (v.__type as ContentType | undefined) ?? w.type;
  if (!type) throw new Error(`Wizard ${w.id} has no generation type`);
  const input: Record<string, unknown> = {};
  for (const s of w.steps) for (const f of s.fields) {
    if (f.key.startsWith("__")) continue;
    const val = v[f.key];
    if (val === undefined || val === null || val === "" || (Array.isArray(val) && !val.length)) continue;
    input[f.key] = f.kind === "number" ? Number(val) : typeof val === "string" ? val.trim() : val;
  }
  if (w.id === "case_study" && !input.topic) input.topic = `Customer story: ${String(input.customer ?? "")}`.trim();
  if (w.id === "sales_sheet" && !input.topic) input.topic = String(input.product ?? "");
  if (type === "short_video") { input.format = "short"; input.seconds = Math.min(Number(input.seconds ?? 60), 180); }
  const req: GenerationRequest = { type, input };
  const sources = v.__sources as string[] | undefined;
  if (sources?.length) req.referenceSourceIds = sources;
  if (type === "static_visual") req.visual = { preset: String(v.__preset ?? "instagram-square"), template: String(v.__template ?? "bold-headline"), imageAssetId: (v.__image as string | undefined) ?? null };
  if (typeof v.__project === "string" && v.__project) req.projectId = v.__project;
  return req;
}
