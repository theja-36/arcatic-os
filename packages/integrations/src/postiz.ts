import { HttpClient, type HttpOptions } from "./http.js";

/**
 * Postiz public API client. Endpoints verified against
 * postiz-app-main/apps/backend/src/public-api/routes/v1/public.integrations.controller.ts
 * (controller prefix `/public/v1`, org API key in the Authorization header).
 * Each Arcatic workspace maps to one Postiz organization (docs/00 gap #1).
 */
export interface PostizIntegration {
  id: string;
  name: string;
  identifier: string;   // provider, e.g. 'instagram', 'linkedin-page'
  picture?: string;
  disabled?: boolean;
  [k: string]: unknown;
}

export interface PostizMedia {
  id: string;
  path: string;
  alt?: string;
  thumbnail?: string;
}

/** Post row as returned by GET /posts (posts.repository.ts getPosts select). */
export interface PostizPost {
  id: string;
  content: string;
  publishDate: string;
  releaseURL: string | null;
  releaseId: string | null;
  state: "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT";
  error: string | null;
  group: string;
  integration: { id: string; providerIdentifier: string; name: string; picture?: string };
}

/** social.integrations.interface.ts AnalyticsData */
export interface PostizAnalyticsSeries {
  label: string;
  data: Array<{ total: string | number; date: string }>;
  percentageChange: number;
}

/** Mirrors CreatePostDto (libraries/nestjs-libraries/src/dtos/posts/create.post.dto.ts). */
export interface PostizCreatePost {
  type: "draft" | "schedule" | "now";
  date: string;                 // ISO; one date for the whole request on the public API
  shortLink: boolean;
  tags: Array<{ value: string; label: string }>;
  posts: Array<{
    integration: { id: string };
    group?: string;
    value: Array<{ content: string; image: PostizMedia[]; delay?: number }>;
    settings: { __type: string } & Record<string, unknown>;   // provider-specific settings DTO
  }>;
}

export class PostizClient {
  private readonly http: HttpClient;

  constructor(opts: { baseUrl: string; apiKey: string } & Partial<Pick<HttpOptions, "fetchImpl" | "timeoutMs">>) {
    this.http = new HttpClient({
      baseUrl: `${opts.baseUrl.replace(/\/$/, "")}/public/v1`,
      headers: { authorization: opts.apiKey },
      service: "postiz",
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
  }

  listIntegrations() {
    return this.http.request<PostizIntegration[]>("GET", "/integrations");
  }

  /** Postiz-hosted page that explains the connection, then redirects to the platform's OAuth. */
  createConnectLink(integration: string, redirectUrl: string) {
    return this.http.request<{ url: string }>("POST", "/integrations/connect", { integration, redirectUrl });
  }

  deleteIntegration(id: string) {
    return this.http.request<void>("DELETE", `/integrations/${encodeURIComponent(id)}`);
  }

  uploadFromUrl(url: string) {
    return this.http.request<PostizMedia>("POST", "/upload-from-url", { url });
  }

  createPost(body: PostizCreatePost) {
    // not idempotent on the Postiz side → no automatic HTTP retry; publishWorkflow
    // checks for an existing post (group id = publishing_jobs.id) before retrying.
    return this.http.request<Array<{ postId: string; integration: string }>>("POST", "/posts", body, { idempotent: false });
  }

  listPosts(query: { startDate: string; endDate: string; customer?: string }) {
    const qs = new URLSearchParams(query as Record<string, string>).toString();
    return this.http.request<{ posts: PostizPost[] }>("GET", `/posts?${qs}`);
  }

  /** Cheap credential check (GET /is-connected → { connected: true }). */
  isConnected() {
    return this.http.request<{ connected: boolean }>("GET", "/is-connected");
  }

  deletePost(id: string) {
    return this.http.request<void>("DELETE", `/posts/${encodeURIComponent(id)}`);
  }

  deleteGroup(group: string) {
    return this.http.request<void>("DELETE", `/posts/group/${encodeURIComponent(group)}`);
  }

  /** Implemented upstream only for: facebook, instagram(+standalone), linkedin-page, threads, tiktok(+business), x, youtube, pinterest, gmb, dribbble. */
  integrationAnalytics(integrationId: string, days: number) {
    return this.http.request<PostizAnalyticsSeries[]>("GET", `/analytics/${encodeURIComponent(integrationId)}?date=${days}`);
  }

  /** posts.service checkPostAnalytics: AnalyticsData[] | { missing: true } (post deleted on the platform) | [] (no analytics). */
  postAnalytics(postId: string, days: number) {
    return this.http.request<PostizAnalyticsSeries[] | { missing: true }>("GET", `/analytics/post/${encodeURIComponent(postId)}?date=${days}`);
  }
}
