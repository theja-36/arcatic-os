/**
 * Contracts that could NOT be verified from source in the project folder:
 *  - Lago: api/ is an empty submodule in lago-main; Phase 10 verified the REST contract against Lago's
 *    published OpenAPI spec instead (see lago.ts).
 *  - Embeddings (TEI / Voyage) and the Whisper server are absent from the folder; their clients
 *    (embeddings.ts, transcriber.ts) follow public HTTP APIs and are fixture-tested only.
 */
export interface UsageMeter {
  sendEvents(events: Array<{ transactionId: string; externalSubscriptionId: string; code: string; properties: Record<string, unknown>; timestamp: number }>): Promise<void>;
}

export interface Transcript {
  text: string;
  language: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
}

export interface Transcriber {
  transcribeFile(bytes: Uint8Array, filename: string, opts?: { language?: string; signal?: AbortSignal }): Promise<Transcript>;
}
