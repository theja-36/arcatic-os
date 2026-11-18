export const ERROR_STATUS = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  insufficient_credits: 402,
  plan_limit: 402,
  rate_limited: 429,
  upstream_error: 502,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { details?: unknown; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.details = opts.details;
    this.retryable = opts.retryable ?? (code === "rate_limited" || code === "upstream_error");
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toJSON(requestId?: string) {
    return { error: { code: this.code, message: this.message, details: this.details, request_id: requestId } };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

/** Map the `code: message` convention used by the SQL functions to AppError. */
export function fromDbError(e: { message?: string; code?: string } | null | undefined): AppError {
  const msg = e?.message ?? "database error";
  const prefix = msg.split(":")[0]?.trim() as ErrorCode | undefined;
  if (prefix && prefix in ERROR_STATUS) return new AppError(prefix, msg.slice(prefix.length + 1).trim() || msg);
  if (e?.code === "42501") return new AppError("forbidden", msg);
  if (e?.code === "23505") return new AppError("conflict", msg);
  if (e?.code === "23514") return new AppError("conflict", msg);
  if (e?.code === "23503" || e?.code === "P0002") return new AppError("not_found", msg);
  if (e?.code === "22023" || e?.code === "22P02") return new AppError("validation_failed", msg);
  return new AppError("internal", msg, { cause: e });
}
