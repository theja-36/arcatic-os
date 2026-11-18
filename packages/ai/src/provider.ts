import type { z } from "zod";

export interface GenerateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredRequest<S extends z.ZodType> {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Stable, cacheable prefix: instructions + compiled Brand Context. */
  system: string;
  /** Volatile part: task, retrieved knowledge, user inputs. */
  user: string;
  schema: S;
  /** optional images shown before the text (vision): base64 data */
  images?: Array<{ mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }>;
  maxTokens?: number;
  /** Correlates traces with jobs and tenants. */
  metadata: { workspaceId: string; jobId?: string; template: string };
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  output: T;
  model: string;
  usage: GenerateUsage;
  stopReason: string | null;
  servedByFallback: boolean;
}

/** Swap point for other providers (docs/06 R14). */
export interface LlmProvider {
  generateStructured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>>;
}

/** Observability hook (Langfuse adapter lives in @arcatic/integrations). */
export interface Tracer {
  record(event: {
    name: string;
    workspaceId: string;
    jobId?: string;
    template: string;
    model: string;
    input: { system: string; user: string };
    output?: unknown;
    usage?: GenerateUsage;
    error?: string;
    startedAt: Date;
    endedAt: Date;
  }): Promise<void> | void;
}

export const noopTracer: Tracer = { record: () => undefined };
