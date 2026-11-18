import { z } from "zod";
import { ROLES } from "./rbac.js";
import { BASE_COSTS, MODEL_TIER_MULTIPLIER } from "./credits.js";

export const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/, "3–48 chars: lowercase letters, numbers, hyphens");

export const CreateOrganizationSchema = z.object({
  organizationName: z.string().trim().min(1).max(120),
  workspaceName: z.string().trim().min(1).max(120),
  workspaceSlug: SlugSchema,
  country: z.string().length(2).default("IN"),
  currency: z.string().length(3).default("INR"),
});

export const UpdateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  defaultLanguage: z.string().min(2).max(10).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const CreateBrandSchema = z.object({
  name: z.string().trim().min(1).max(120),
  websiteUrl: z.url().optional(),
  industry: z.string().max(80).optional(),
  languages: z.array(z.string().min(2).max(10)).min(1).default(["en"]),
});
export const UpdateBrandSchema = CreateBrandSchema.partial().extend({ status: z.enum(["active", "archived"]).optional() });

export const InviteSchema = z.object({
  email: z.email(),
  role: z.enum(ROLES).refine((r) => r !== "owner", "Invite as admin, then transfer ownership"),
  brandIds: z.array(z.uuid()).optional(),
});

export const UpdateMemberSchema = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  brandRestricted: z.boolean().optional(),
});

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(ROLES).refine((r) => r !== "owner", "API keys cannot be owners").default("editor"),
  scopes: z.array(z.string().regex(/^[a-z]+\.(\*|[a-z]+)$/)).default([]),
  expiresAt: z.iso.datetime().optional(),
});

export const UploadUrlSchema = z.object({
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(3).max(120),
  bytes: z.number().int().positive().max(500 * 1024 * 1024),
  brandId: z.uuid().optional(),
  collectionId: z.uuid().optional(),
});

export const EstimateSchema = z.object({
  kind: z.enum(Object.keys(BASE_COSTS) as [keyof typeof BASE_COSTS, ...(keyof typeof BASE_COSTS)[]]),
  quantity: z.number().nonnegative().default(1),
  modelTier: z.enum(Object.keys(MODEL_TIER_MULTIPLIER) as ["economy", "standard", "premium"]).default("standard"),
});

export const PaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
