import { z } from "zod";
import { CONTENT_TYPES, templateForContentType } from "./plan.js";
import { CONTENT_TYPE_DEFS, type ContentTypeDef } from "../content/types.js";

export const CAMPAIGN_STATUSES = ["draft", "planned", "active", "paused", "completed", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Mirrors app.guard_campaign_transition (migration 0009). */
const ALLOWED: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ["planned", "active", "cancelled"],
  planned: ["draft", "active", "cancelled"],
  active: ["paused", "completed", "cancelled"],
  paused: ["active", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};
export const canTransition = (from: CampaignStatus, to: CampaignStatus) => ALLOWED[from].includes(to);

export const CampaignBriefSchema = z.object({
  theme: z.string().max(2000).default(""),
  keyMessage: z.string().max(2000).default(""),
  offer: z.string().max(300).default(""),
  cta: z.string().max(300).default(""),
  audience: z.string().max(300).default(""),
  kpis: z.array(z.string().max(300)).max(6).default([]),
});

export const GenerationScheduleSchema = z.object({
  /** immediate: generate approved topics as soon as the campaign runs; scheduled: N days before each topic's date */
  mode: z.enum(["immediate", "scheduled", "manual"]).default("scheduled"),
  leadDays: z.number().int().min(0).max(30).default(3),
  maxPerDay: z.number().int().min(1).max(50).default(10),
});
export type GenerationSchedule = z.infer<typeof GenerationScheduleSchema>;

const dateStr = z.iso.date();
export const CreateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  goal: z.string().max(300).optional(),
  startsOn: dateStr.optional(),
  endsOn: dateStr.optional(),
  channels: z.array(z.string().max(40)).max(13).default([]),
  contentTypes: z.array(z.enum(CONTENT_TYPES)).max(8).default(["social_post"]),
  frequency: z.record(z.string(), z.object({ perWeek: z.number().int().min(0).max(50) })).default({}),
  volumeTarget: z.number().int().min(0).max(1000).optional(),
  reviewWindowHours: z.number().int().min(0).max(24 * 14).default(24),
  generationSchedule: GenerationScheduleSchema.default({ mode: "scheduled", leadDays: 3, maxPerDay: 10 }),
  brief: CampaignBriefSchema.default({ theme: "", keyMessage: "", offer: "", cta: "", audience: "", kpis: [] }),
  pillar: z.string().max(300).optional(),
  context: z.string().max(4000).optional(),
  referenceSourceIds: z.array(z.uuid()).max(20).default([]),
}).refine((c) => !c.startsOn || !c.endsOn || c.endsOn >= c.startsOn, { message: "End date must be after the start date", path: ["endsOn"] });

export const UpdateCampaignSchema = z.object({
  revision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(160).optional(),
  goal: z.string().max(300).nullable().optional(),
  startsOn: dateStr.nullable().optional(),
  endsOn: dateStr.nullable().optional(),
  channels: z.array(z.string().max(40)).max(13).optional(),
  contentTypes: z.array(z.enum(CONTENT_TYPES)).max(8).optional(),
  frequency: z.record(z.string(), z.object({ perWeek: z.number().int().min(0).max(50) })).optional(),
  volumeTarget: z.number().int().min(0).max(1000).nullable().optional(),
  reviewWindowHours: z.number().int().min(0).max(24 * 14).optional(),
  generationSchedule: GenerationScheduleSchema.optional(),
  brief: CampaignBriefSchema.optional(),
  pillar: z.string().max(300).nullable().optional(),
  context: z.string().max(4000).nullable().optional(),
  referenceSourceIds: z.array(z.uuid()).max(20).optional(),
});

export const TOPIC_STATUSES = ["idea", "approved", "in_production", "done", "failed", "blocked", "dropped"] as const;
export const CreateTopicSchema = z.object({
  title: z.string().trim().min(1).max(300),
  angle: z.string().max(2000).optional(),
  pillar: z.string().max(300).optional(),
  channel: z.string().max(40),
  contentType: z.enum(CONTENT_TYPES).default("social_post"),
  plannedFor: dateStr,
  cta: z.string().max(300).optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(["idea", "approved"]).default("idea"),
});
export const UpdateTopicSchema = CreateTopicSchema.partial().extend({ status: z.enum(["idea", "approved", "dropped"]).optional() });

export const GenerateStrategySchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  startsOn: dateStr.optional(),
  weeks: z.number().int().min(4).max(26).default(13),
  channels: z.array(z.string().max(40)).min(1).max(13).optional(),
  goals: z.array(z.string().max(200)).max(5).optional(),
  constraints: z.string().max(2000).optional(),
  focus: z.string().max(2000).optional(),
});

export const SaveStrategySchema = z.object({ revision: z.number().int().nonnegative(), plan: z.unknown(), title: z.string().trim().min(1).max(160).optional() });

export const WeeklyPlanRequestSchema = z.object({
  weekStart: dateStr,
  weeks: z.number().int().min(1).max(4).default(1),
  autoApprove: z.boolean().default(false),
  campaignId: z.uuid().optional(),
});

export const SeasonalEventSchema = z.object({
  name: z.string().trim().min(1).max(120),
  onDate: dateStr,
  region: z.string().max(10).default("IN"),
  kind: z.enum(["festival", "national", "commercial", "awareness", "business"]).default("business"),
  note: z.string().max(300).optional(),
});

/** Topic → generation request, or the reason Arcatic can't generate it yet. */
export function topicGenerationInput(
  topic: { title: string; angle?: string | null; channel: string | null; content_type: string; cta?: string | null; notes?: string | null },
  campaign: { goal?: string | null; brief?: { cta?: string } | null },
  language: string,
): { templateKey: string; contentType: string; input: Record<string, unknown> } | { unsupported: string } {
  const def = (CONTENT_TYPE_DEFS as Record<string, ContentTypeDef>)[topic.content_type];
  const templateKey = templateForContentType(topic.content_type);
  if (!def || !templateKey) return { unsupported: `Generating ${topic.content_type.replace("_", " ")} content isn't available yet; write it by hand or change the format.` };
  if (def.category !== "text") return { unsupported: def.category === "video" ? "Make this video in the video editor, then send it to the campaign." : `${def.label} is created in the visual editor.` };
  if (def.channels && (!topic.channel || !def.channels.includes(topic.channel))) {
    return { unsupported: `${def.label} can't be generated for ${topic.channel ?? "an unknown channel"}; use ${def.channels.join(", ")}.` };
  }
  return {
    templateKey,
    contentType: topic.content_type,
    input: {
      ...(def.channels && { channel: topic.channel }),
      topic: topic.angle ? `${topic.title}. ${topic.angle}` : topic.title,
      ...(campaign.goal && { goal: campaign.goal }),
      ...((topic.cta || campaign.brief?.cta) && { cta: topic.cta || campaign.brief?.cta }),
      ...(topic.notes && { focus: topic.notes }),
      language,
    },
  };
}
