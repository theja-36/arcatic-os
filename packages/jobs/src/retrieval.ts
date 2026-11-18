import { fromDbError } from "@arcatic/core";
import type { Db } from "@arcatic/database";
import { toPgVector, type Embedder } from "@arcatic/integrations";

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  content: string;
  url?: string;
  title: string;
}

/**
 * Knowledge for a generation. Runs with the service role, so it applies the private-source
 * rule itself: private sources are used only for their owner's own generations.
 */
export async function retrieveForGeneration(
  db: Db,
  embedder: Embedder | null,
  args: { brandId: string; query: string; requestedBy?: string; limit?: number; signal?: AbortSignal },
): Promise<RetrievedChunk[]> {
  if (args.query.trim().length < 2) return [];
  let embedding: string | null = null;
  if (embedder) {
    try {
      embedding = toPgVector((await embedder.embed([args.query], "query", args.signal))[0]!);
    } catch {
      embedding = null;   // keyword search only
    }
  }
  const res = await db.rpc("search_knowledge", {
    p_brand: args.brandId, p_query: args.query, p_embedding: embedding, p_model: embedding ? embedder!.model : null, p_limit: (args.limit ?? 6) * 2,
  });
  if (res.error) throw fromDbError(res.error);
  const rows = (res.data ?? []) as Array<{ chunk_id: string; source_id: string; content: string; source_title: string; page_url: string | null; source_url: string | null }>;
  if (!rows.length) return [];
  const vis = await db.from("sources").select("id, visibility, owner_id").in("id", [...new Set(rows.map((r) => r.source_id))]);
  if (vis.error) throw fromDbError(vis.error);
  const allowed = new Set((vis.data ?? []).filter((s) => s.visibility === "brand" || (args.requestedBy && s.owner_id === args.requestedBy)).map((s) => s.id as string));
  return rows
    .filter((r) => allowed.has(r.source_id))
    .slice(0, args.limit ?? 6)
    .map((r) => ({ chunkId: r.chunk_id, sourceId: r.source_id, content: r.content, url: r.page_url ?? r.source_url ?? undefined, title: r.source_title }));
}
