import { AppError } from "./errors.js";

export interface PlanLimits {
  max_brands?: number;
  max_seats?: number;
  max_connected_accounts?: number;
  video?: boolean;
  client_reviewers?: boolean;
}

export type CountedLimit = "max_brands" | "max_seats" | "max_connected_accounts";

/** Throws plan_limit when adding `adding` more would exceed the plan. Missing limit = unlimited. */
export function assertWithinLimit(limits: PlanLimits, key: CountedLimit, current: number, adding = 1): void {
  const max = limits[key];
  if (max === undefined) return;
  if (current + adding > max) {
    throw new AppError("plan_limit", `Your plan allows ${max} ${key.replace("max_", "").replace("_", " ")}.`, {
      details: { limit: key, max, current },
    });
  }
}

export function assertFeature(limits: PlanLimits, feature: "video" | "client_reviewers"): void {
  if (!limits[feature]) throw new AppError("plan_limit", `Your plan does not include ${feature.replace("_", " ")}.`);
}
