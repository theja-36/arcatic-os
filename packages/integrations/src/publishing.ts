/**
 * Channel-agnostic publishing contract. PostizAdapter is the first implementation;
 * direct WordPress REST / GBP adapters implement the same interface (docs/00).
 */
export interface PublishRequest {
  idempotencyKey: string;               // publishing_jobs.id
  connectedAccountExternalId: string;
  provider: string;
  text: string;
  media: Array<{ url: string; mimeType: string; alt?: string }>;
  publishAt: Date | "now";
  settings: Record<string, unknown>;
}

export interface PublishResult {
  externalPostId: string;
  externalUrl?: string;
  status: "scheduled" | "published";
}

export interface PublishingAdapter {
  readonly key: string;
  supports(provider: string): boolean;
  publish(req: PublishRequest, signal?: AbortSignal): Promise<PublishResult>;
  /** Reversal where the platform API allows it. */
  remove(externalPostId: string): Promise<void>;
}
