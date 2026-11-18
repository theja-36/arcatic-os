import { AppError, fromDbError } from "@arcatic/core";
import type { Context } from "hono";
import type { z } from "zod";

export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("validation_failed", "Request body must be JSON.");
  }
  return parse(schema, raw);
}

export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError("validation_failed", "Invalid request.", {
      details: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

export function idempotencyKey(c: Context): string {
  const key = c.req.header("idempotency-key");
  if (!key || key.length < 8 || key.length > 200) {
    throw new AppError("validation_failed", "Idempotency-Key header (8–200 chars) is required.");
  }
  return key;
}

/** Unwrap a supabase-js result: DB errors → AppError, missing row → not_found. */
export function check<T>(res: { data: T; error: { message: string; code?: string } | null }): NonNullable<T> {
  if (res.error) throw fromDbError(res.error);
  if (res.data == null) throw new AppError("not_found", "Not found.");
  return res.data as NonNullable<T>;
}

export function ok(res: { error: { message: string; code?: string } | null }): void {
  if (res.error) throw fromDbError(res.error);
}
