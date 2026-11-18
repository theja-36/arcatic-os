import type { ModelTier } from "@arcatic/core";

/**
 * Model registry. Every tier defaults to Claude Opus 5.5; routing cheaper work to
 * claude-sonnet-5-5 / claude-haiku-5-5 is a product/cost decision made per template
 * after running the eval suite (docs/04, docs/07) — override with env vars.
 */
export const DEFAULT_MODEL = "claude-opus-5-5";

export interface ModelChoice {
  provider: "anthropic";
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  tier: ModelTier;
}

export function resolveModel(tier: ModelTier, env: Record<string, string | undefined> = process.env): ModelChoice {
  const byTier: Record<ModelTier, { model?: string; effort: ModelChoice["effort"] }> = {
    economy: { model: env.ARCATIC_MODEL_ECONOMY, effort: "low" },
    standard: { model: env.ARCATIC_MODEL_STANDARD, effort: "medium" },
    premium: { model: env.ARCATIC_MODEL_PREMIUM, effort: "high" },
  };
  const t = byTier[tier];
  return { provider: "anthropic", model: t.model || DEFAULT_MODEL, effort: t.effort, tier };
}
