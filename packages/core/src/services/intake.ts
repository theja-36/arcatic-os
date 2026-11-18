import { z } from "zod";

export const IntakeFieldSchema = z.object({
  key: z.string().regex(/^[a-z_]{1,40}$/),
  label: z.string().min(1).max(200),
  type: z.enum(["text", "textarea", "select"]),
  required: z.boolean().default(false),
  max: z.number().int().positive().max(10_000).optional(),
  options: z.array(z.string().max(100)).max(20).optional(),
});
export type IntakeField = z.infer<typeof IntakeFieldSchema>;

/** Validate a customer's answers against an offering's intake form. Unknown keys are dropped. */
export function validateIntake(fields: readonly IntakeField[], answers: Record<string, unknown>, opts: { partial?: boolean } = {}): { ok: boolean; values: Record<string, string>; errors: Record<string, string> } {
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = answers[f.key];
    const v = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
    if (!v) {
      if (f.required && !opts.partial) errors[f.key] = `${f.label} is required.`;
      continue;
    }
    if (f.max && v.length > f.max) { errors[f.key] = `${f.label} is too long (max ${f.max} characters).`; continue; }
    if (f.type === "select" && f.options && !f.options.includes(v)) { errors[f.key] = `Choose one of: ${f.options.join(", ")}.`; continue; }
    values[f.key] = v;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}
