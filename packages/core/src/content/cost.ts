import { estimateCredits, type Estimate, type ModelTier } from "../credits.js";
import { CONTENT_TYPE_DEFS, type ContentType } from "./types.js";

/** Credit estimate for one generation request (preview and reservation use the same numbers). */
export function contentCost(type: ContentType, opts: { modelTier?: ModelTier; count?: number; mode?: "create" | "regenerate" | "transform" | "translate" } = {}): Estimate {
  const def = CONTENT_TYPE_DEFS[type];
  if (opts.mode === "transform") return estimateCredits({ kind: "generate.transform", modelTier: opts.modelTier });
  if (opts.mode === "translate") return estimateCredits({ kind: "generate.translation", modelTier: opts.modelTier });
  if (def.category === "image") return estimateCredits({ kind: "generate.image", quantity: opts.count ?? 1, modelTier: "standard" });
  return estimateCredits({ kind: def.costKind, modelTier: opts.modelTier });
}

export function sumEstimates(xs: Estimate[]): Estimate {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { estimate: r(xs.reduce((s, x) => s + x.estimate, 0)), max: r(xs.reduce((s, x) => s + x.max, 0)) };
}
