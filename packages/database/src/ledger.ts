import { AppError, fromDbError } from "@arcatic/core";
import type { Db } from "./clients.js";

/** Typed wrappers over the SQL ledger functions (service role only). */
export interface Reservation {
  id: string;
  workspace_id: string;
  amount: number;
  settled_amount: number | null;
  status: "held" | "settled" | "released" | "expired";
  job_id: string | null;
  expires_at: string;
}

async function rpc<T>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw fromDbError(error);
  if (data == null) throw new AppError("internal", `${fn} returned nothing`);
  return data as T;
}

export const ledger = {
  reserve: (db: Db, a: { workspaceId: string; amount: number; idempotencyKey: string; jobId?: string; reason?: string; ttlSeconds?: number }) =>
    rpc<Reservation>(db, "reserve_credits", {
      p_workspace: a.workspaceId,
      p_amount: a.amount,
      p_idempotency_key: a.idempotencyKey,
      p_job: a.jobId ?? null,
      p_reason: a.reason ?? null,
      p_ttl: `${a.ttlSeconds ?? 7200} seconds`,
    }),
  settle: (db: Db, reservationId: string, actual: number) =>
    rpc<Reservation>(db, "settle_reservation", { p_reservation: reservationId, p_actual: actual, p_allow_overrun: false }),
  release: (db: Db, reservationId: string, reason?: string) =>
    rpc<Reservation>(db, "release_reservation", { p_reservation: reservationId, p_reason: reason ?? null }),
  grant: (db: Db, a: { workspaceId: string; amount: number; kind: "grant" | "topup" | "refund" | "adjustment"; reference: string; actorId?: string }) =>
    rpc(db, "grant_credits", { p_workspace: a.workspaceId, p_amount: a.amount, p_kind: a.kind, p_reference: a.reference, p_actor: a.actorId ?? null }),
};
