/**
 * Minimal supabase-js stand-in: per-table row lists, `.single()/.maybeSingle()` return the
 * first row, every write is recorded for assertions. `.eq(col, v)` filters only rows that have
 * that column (rows without it pass), so tests can keep partial rows; other filters are ignored.
 */
export type Op = { table: string; op: "select" | "insert" | "update" | "delete" | "upsert" | "rpc"; payload?: unknown };

/** Every real workspace has a subscription; tests get an active Growth plan unless they say otherwise. */
export const ACTIVE_SUBSCRIPTION = { plan_key: "growth", status: "active", current_period_start: "2026-11-01T00:00:00Z", current_period_end: "2099-01-01T00:00:00Z", cancel_at_period_end: false, pending_plan_key: null, past_due_since: null, plan: { name: "Growth", limits: { video: true, max_brands: 3 } } };

export function fakeDb(tablesIn: Record<string, unknown[]> = {}, rpc: Record<string, unknown> = {}, updates: Record<string, unknown[]> = {}) {
  const tables: Record<string, unknown[]> = { subscriptions: [ACTIVE_SUBSCRIPTION], ...tablesIn };
  const ops: Op[] = [];
  const builder = (table: string, op: Op["op"], payload?: unknown) => {
    let single = false;
    const eqs: Array<[string, unknown]> = [];
    const b: any = new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === "then") {
          return (res: (v: unknown) => void) => {
            const rows = op === "rpc" ? rpc[table] : op === "update" && table in updates ? updates[table] : tables[table] ?? [];
            if (op === "rpc") {
              const err = rows && typeof rows === "object" && "__error" in (rows as object) ? (rows as { __error: { message: string; code?: string } }).__error : null;
              return res(err ? { data: null, error: err } : { data: rows ?? null, error: null });
            }
            // canned write results (insert/update/…) are returned as given; reads honour eq()
            const arr = op !== "select" ? (rows as unknown[]) : (rows as Array<Record<string, unknown>>).filter((r) => eqs.every(([k, v]) => !(r && typeof r === "object" && k in r) || r[k] === v));
            res({ data: single ? (arr[0] ?? null) : arr, error: null, count: arr.length });
          };
        }
        if (prop === "single" || prop === "maybeSingle") return () => ((single = true), b);
        if (prop === "eq") return (k: string, v: unknown) => (eqs.push([k, v]), b);
        if (prop === "update" || prop === "insert" || prop === "delete" || prop === "upsert") {
          return (p?: unknown) => {
            ops.push({ table, op: prop as Op["op"], payload: p });
            return builder(table, prop as Op["op"], p);
          };
        }
        return () => b;
      },
      apply: () => b,
    });
    return b;
  };
  const db: any = {
    from: (t: string) => builder(t, "select"),
    rpc: (fn: string, args: unknown) => (ops.push({ table: fn, op: "rpc", payload: args }), builder(fn, "rpc")),
    storage: { from: () => builder("storage", "select") },
  };
  return { db, ops };
}
