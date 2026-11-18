"use client";
import { supabase } from "./supabase";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

/** Calls apps/api with the current Supabase session token. */
export async function api<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError("unauthenticated", "Please sign in again.", 401);
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.idempotencyKey && { "idempotency-key": init.idempotencyKey }),
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error?.code ?? "internal", body.error?.message ?? res.statusText, res.status, body.error?.details);
  return body as T;
}
