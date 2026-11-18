/**
 * In-memory stand-in for the supabase-js query builder: eq/neq/in/is/gte/lte/order/limit filters,
 * single/maybeSingle, insert/update/upsert with returning, rpc map, storage stub.
 * Enough to exercise activities' real data flow without Postgres.
 */
type Row = Record<string, unknown>;
export function memDb(seed: Record<string, Row[]> = {}, rpcs: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const storage = new Map<string, Uint8Array>();
  const t = (name: string) => (tables[name] ??= []);

  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Row | Row[] | undefined;
    let single: "one" | "maybe" | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), b),
      lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), b),
      like: (c: string, pat: string) => (filters.push((r) => new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`).test(String(r[c] ?? ""))), b),
      contains: () => b, or: () => b, not: () => b,
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending ?? true }), b),
      limit: (n: number) => ((limit = n), b),
      single: () => ((single = "one"), b),
      maybeSingle: () => ((single = "maybe"), b),
      insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), b),
      upsert: (p: Row | Row[]) => ((op = "upsert"), (payload = p), b),
      update: (p: Row) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      then: (res: (v: unknown) => void, rej?: (e: unknown) => void) => {
        try {
          let rows: Row[];
          if (op === "insert" || op === "upsert") {
            rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }));
            t(table).push(...rows);
          } else {
            rows = t(table).filter((r) => filters.every((f) => f(r)));
            if (op === "update") rows.forEach((r) => Object.assign(r, payload));
            if (op === "delete") tables[table] = t(table).filter((r) => !rows.includes(r));
          }
          if (order) rows = [...rows].sort((a, z) => (String(a[order!.col]) < String(z[order!.col]) ? -1 : 1) * (order!.asc ? 1 : -1));
          if (typeof (rows[0] as Row | undefined)?.version === "number" && order?.col === "version") rows = [...rows].sort((a, z) => ((a.version as number) - (z.version as number)) * (order!.asc ? 1 : -1));
          if (limit !== null) rows = rows.slice(0, limit);
          if (single === "one" && rows.length !== 1) return res({ data: null, error: { message: `expected one ${table} row, got ${rows.length}`, code: "PGRST116" } });
          res({ data: single ? rows[0] ?? null : rows, error: null, count: rows.length });
        } catch (e) {
          rej?.(e);
        }
      },
    };
    return b;
  }
  const db: any = {
    from: query,
    rpc: (fn: string, args: Record<string, unknown>) => Promise.resolve({ data: rpcs[fn]?.(args) ?? null, error: null }),
    storage: {
      from: () => ({
        download: async (p: string) => (storage.has(p) ? { data: new Blob([storage.get(p)!.slice()]), error: null } : { data: null, error: { message: "not found" } }),
        upload: async (p: string, bytes: Uint8Array) => (storage.set(p, bytes), { data: { path: p }, error: null }),
        createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://storage.test/${p}?token=t` }, error: null }),
      }),
    },
  };
  return { db, tables, storage };
}
