import { ApplicationFailure, Context } from "@temporalio/activity";
import { adsBrief, googleRsaCopy, metaAdCopy, type LlmProvider } from "@arcatic/ai";
import {
  AdAudienceSchema, AppError, campaignsToPause, checkCompliance, docText, estimateCredits, fromDbError, GoogleCreativeSchema, MetaCreativeSchema,
  seedGoogleCreative, seedMetaCreative, statusAfter, type AdAction, type AdStatus, type ContentDoc,
} from "@arcatic/core";
import type { Db } from "@arcatic/database";
import type { AdsSyncClient, Embedder } from "@arcatic/integrations";
import { activeBrandContext } from "./content-activity.js";
import type { AdsDraftInput } from "./contracts.js";
import { readSecret } from "./publishing.js";
import { retrieveForGeneration } from "./retrieval.js";

/**
 * Ads module (high risk). The worker only ever executes an ad_actions row that a person with
 * ads.approve approved through decide_ad_action() for the campaign's current revision; it
 * re-checks that here before touching the platform. The spend guard can pause on its own (never
 * start or raise spend).
 */
export interface AdsDeps { db: Db; llm: LlmProvider; ads: AdsSyncClient | null; embedder?: Embedder | null; encryptionKey?: string; signedUrl?: (path: string) => Promise<string> }

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw ApplicationFailure.create({ type: err.code, message: err.message, nonRetryable: !err.retryable });
    throw err;
  }
}

export interface CampaignRow {
  id: string; workspace_id: string; brand_id: string; connection_id: string; platform: "google" | "meta"; name: string; objective: string; status: AdStatus;
  brief: Record<string, unknown>; audience: unknown; creative: Record<string, unknown>; landing_url: string | null; daily_budget_minor: number | null; currency: string;
  start_date: string | null; end_date: string | null; special_ad_categories: string[]; revision: number; external: Record<string, string>; source_content_item_id: string | null;
}
interface ConnRow { id: string; provider: "google_ads" | "meta_ads"; account_ref: string; secret_id: string | null; settings: { loginCustomerId?: string } }
interface PolicyRow { connection_id: string; manage_enabled: boolean; max_daily_budget_minor: number; monthly_spend_cap_minor: number | null; auto_pause_on_cap: boolean; page_id: string | null; instagram_user_id: string | null; currency: string }

export function createAdsActivities({ db, llm, ads, embedder = null, encryptionKey, signedUrl }: AdsDeps) {
  const one = async <T>(q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> => {
    const r = await q;
    if (r.error) throw fromDbError(r.error as never);
    return r.data as T;
  };
  const sidecar = () => {
    if (!ads) throw new AppError("conflict", "The ads-sync service isn't configured (ADS_SYNC_URL).");
    return ads;
  };
  const conn = (workspaceId: string, id: string) => one<ConnRow>(db.from("analytics_connections").select("id, provider, account_ref, secret_id, settings").eq("id", id).eq("workspace_id", workspaceId).single());
  const googleAuth = async (ws: string, c: ConnRow) => ({ customerId: c.account_ref, loginCustomerId: c.settings.loginCustomerId ?? null, refreshToken: await readSecret(db, { workspaceId: ws, secretId: c.secret_id, purpose: "google_ads_refresh_token", key: encryptionKey }) });
  const metaToken = (ws: string, c: ConnRow) => readSecret(db, { workspaceId: ws, secretId: c.secret_id, purpose: "meta_access_token", key: encryptionKey });
  const imageUrl = async (ws: string, assetId: string | null | undefined) => {
    if (!assetId) return null;
    const a = await one<{ storage_path: string; kind: string; status: string } | null>(db.from("media_assets").select("storage_path, kind, status").eq("id", assetId).eq("workspace_id", ws).maybeSingle());
    if (!a || a.kind !== "image" || a.status !== "ready") throw new AppError("validation_failed", "The ad image is missing or still processing.");
    if (signedUrl) return signedUrl(a.storage_path);
    const r = await db.storage.from("media").createSignedUrl(a.storage_path, 3600);
    if (r.error || !r.data?.signedUrl) throw new AppError("upstream_error", "Couldn't prepare the ad image.", { retryable: true });
    return r.data.signedUrl;
  };

  return {
    /** AI brief, audience suggestions and copy for a draft campaign (a person reviews everything). */
    async draftAdCampaign(input: AdsDraftInput): Promise<{ issues: number; credits: number }> {
      return wrap(async () => {
        const c = await one<CampaignRow>(db.from("ad_campaigns").select("*").eq("id", input.campaignId).eq("workspace_id", input.workspaceId).single());
        if (c.status !== "draft" && c.status !== "failed") throw new AppError("conflict", "Only draft campaigns can be drafted with AI.");
        const brand = await activeBrandContext(db, c.workspace_id, c.brand_id);
        let sourceDoc: ContentDoc | null = null;
        if (c.source_content_item_id) {
          const it = await one<{ current_version_id: string | null }>(db.from("content_items").select("current_version_id").eq("id", c.source_content_item_id).single());
          if (it.current_version_id) sourceDoc = (await one<{ body: { doc?: ContentDoc } }>(db.from("content_versions").select("body").eq("id", it.current_version_id).single())).body.doc ?? null;
        }
        const b = c.brief as { offer?: string; audience?: string; goal?: string; notes?: string };
        const knowledge = (await retrieveForGeneration(db, embedder, { brandId: c.brand_id, query: [b.offer, b.goal, c.name].filter(Boolean).join(" "), requestedBy: input.requestedBy, limit: 6 }))
          .map((k) => ({ chunkId: k.chunkId, content: k.content, url: k.url }));
        const meta = { workspaceId: c.workspace_id, jobId: input.jobId };
        const language = brand.data.languages.primary || "en";
        const sourceText = sourceDoc ? docText(sourceDoc) : undefined;
        const br = await adsBrief(llm, { brand, platform: c.platform, objective: c.objective, offer: b.offer, audience: b.audience, goal: b.goal, landingUrl: c.landing_url, sourceText, knowledge }, meta);
        Context.current().heartbeat();
        const pick = br.output.audiences[0];
        const audience = AdAudienceSchema.safeParse(c.audience ?? {}).data ?? AdAudienceSchema.parse({});
        let creative: Record<string, unknown>;
        if (c.platform === "google") {
          const seed = sourceDoc ? seedGoogleCreative(sourceDoc) : undefined;
          const copy = await googleRsaCopy(llm, { brand, brief: br.output.summary, keywords: pick?.keywords.map((k) => k.text) ?? [], landingUrl: c.landing_url, seed, language, knowledge }, meta);
          creative = GoogleCreativeSchema.parse({ headlines: copy.output.headlines, descriptions: copy.output.descriptions, path1: copy.output.path1, path2: copy.output.path2 });
          if (pick && !audience.keywords.length) audience.keywords = pick.keywords;
          if (pick && !audience.negativeKeywords.length) audience.negativeKeywords = pick.negativeKeywords;
        } else {
          const seed = sourceDoc ? seedMetaCreative(sourceDoc) : undefined;
          const copy = await metaAdCopy(llm, { brand, brief: br.output.summary, objective: c.objective, seedText: seed?.primaryText, language, knowledge }, meta);
          const prev = MetaCreativeSchema.safeParse(c.creative ?? {}).data ?? MetaCreativeSchema.parse({});
          creative = MetaCreativeSchema.parse({ ...prev, primaryText: copy.output.primaryTexts[0] ?? seed?.primaryText ?? "", headline: copy.output.headlines[0] ?? seed?.headline ?? "", description: copy.output.descriptions[0] ?? null });
          creative = { ...creative, alternatives: { primaryTexts: copy.output.primaryTexts, headlines: copy.output.headlines, descriptions: copy.output.descriptions } };
          // interest names → real Meta ids (never invented): exact name matches from Meta's targeting search
          if (pick?.interestNames.length && !audience.interests.length && ads) {
            const cn = await conn(c.workspace_id, c.connection_id);
            const token = await metaToken(c.workspace_id, cn);
            for (const name of pick.interestNames.slice(0, 8)) {
              const r = await ads.metaSearch({ accessToken: token, kind: "interest", q: name }).catch(() => ({ results: [] }));
              const hit = r.results.find((x) => String(x.name ?? "").toLowerCase() === name.toLowerCase());
              if (hit) audience.interests.push({ id: String(hit.id), name: String(hit.name) });
            }
          }
          if (pick) { audience.ageMin = pick.ageMin; audience.ageMax = pick.ageMax; }
        }
        const policy = await one<PolicyRow | null>(db.from("ad_account_policies").select("*").eq("connection_id", c.connection_id).maybeSingle());
        const compliance = checkCompliance({
          platform: c.platform, name: c.name, objective: c.objective, audience, creative, landingUrl: c.landing_url, dailyBudgetMinor: c.daily_budget_minor,
          startDate: c.start_date, endDate: c.end_date, specialAdCategories: c.special_ad_categories, hasImage: !!(creative as { mediaAssetId?: string }).mediaAssetId,
          policy: policy && { manageEnabled: policy.manage_enabled, maxDailyBudgetMinor: policy.max_daily_budget_minor, monthlySpendCapMinor: policy.monthly_spend_cap_minor, autoPauseOnCap: policy.auto_pause_on_cap },
        });
        await one(db.from("ad_campaigns").update({
          brief: { ...c.brief, summary: br.output.summary, angles: br.output.angles, audiences: br.output.audiences },
          audience, creative, compliance, revision: c.revision + 1,
        }).eq("id", c.id).eq("revision", c.revision));
        return { issues: compliance.issues.length, credits: estimateCredits({ kind: "ads.draft" }).estimate };
      });
    },

    /**
     * Execute one approved request. Re-checks: approved, same revision, manage switched on, budget
     * within the account limit. Launch creates everything PAUSED.
     */
    async executeAdAction(a: { actionId: string }): Promise<{ status: string; campaignStatus: AdStatus }> {
      return wrap(async () => {
        const act = await one<{ id: string; workspace_id: string; campaign_id: string; action: AdAction; payload: { dailyBudgetMinor?: number }; campaign_revision: number; status: string }>(
          db.from("ad_actions").select("id, workspace_id, campaign_id, action, payload, campaign_revision, status").eq("id", a.actionId).single());
        const c = await one<CampaignRow>(db.from("ad_campaigns").select("*").eq("id", act.campaign_id).single());
        if (act.status === "done") return { status: "done", campaignStatus: c.status };
        if (act.status !== "approved" && act.status !== "executing") throw new AppError("conflict", `This request is ${act.status}.`);
        if (c.revision !== act.campaign_revision) {
          await one(db.from("ad_actions").update({ status: "cancelled", error: "Campaign changed after approval" }).eq("id", act.id));
          throw new AppError("conflict", "The campaign changed after approval; request again.");
        }
        const policy = await one<PolicyRow | null>(db.from("ad_account_policies").select("*").eq("connection_id", c.connection_id).maybeSingle());
        const raises = act.action === "launch" || act.action === "activate" || act.action === "budget_change";
        if (raises && !policy?.manage_enabled) throw new AppError("forbidden", "Campaign management is switched off for this ad account.");
        const budget = act.action === "budget_change" ? act.payload.dailyBudgetMinor ?? 0 : c.daily_budget_minor ?? 0;
        if (raises && policy && budget > policy.max_daily_budget_minor) throw new AppError("forbidden", "Above this ad account's daily budget limit.");

        await one(db.from("ad_actions").update({ status: "executing" }).eq("id", act.id).in("status", ["approved", "executing"]));
        if (act.action === "launch") await one(db.from("ad_campaigns").update({ status: "launching", last_error: null }).eq("id", c.id));
        const cn = await conn(c.workspace_id, c.connection_id);
        const s = sidecar();
        try {
          let external: Record<string, string> = c.external ?? {};
          let budgetMinor = c.daily_budget_minor;
          if (act.action === "launch") {
            const campaign = {
              id: c.id, name: c.name, objective: c.objective, currency: c.currency, dailyBudgetMinor: c.daily_budget_minor ?? 0, landingUrl: c.landing_url ?? "",
              startDate: c.start_date, endDate: c.end_date, audience: c.audience, creative: c.creative, specialAdCategories: c.special_ad_categories,
              pageId: policy?.page_id ?? null, instagramUserId: policy?.instagram_user_id ?? null,
            };
            const res = c.platform === "google"
              ? await s.googleCreate({ ...(await googleAuth(c.workspace_id, cn)), campaign })
              : await s.metaCreate({ accessToken: await metaToken(c.workspace_id, cn), adAccountId: cn.account_ref, campaign: { ...campaign, imageUrl: await imageUrl(c.workspace_id, (c.creative as { mediaAssetId?: string }).mediaAssetId) } });
            external = Object.fromEntries(Object.entries(res).filter(([, v]) => typeof v === "string")) as Record<string, string>;
          } else {
            const status = act.action === "activate" ? "active" : act.action === "pause" || act.action === "end" ? "paused" : undefined;
            const dailyBudgetMinor = act.action === "budget_change" ? act.payload.dailyBudgetMinor : undefined;
            if (!external.campaignId) throw new AppError("conflict", "This campaign hasn't been created on the platform.");
            if (c.platform === "google") await s.googleUpdate({ ...(await googleAuth(c.workspace_id, cn)), campaignId: external.campaignId, budgetResourceName: external.budgetResourceName, status, dailyBudgetMinor });
            else await s.metaUpdate({ accessToken: await metaToken(c.workspace_id, cn), campaignId: external.campaignId, adSetId: external.adSetId, status, dailyBudgetMinor });
            if (dailyBudgetMinor) budgetMinor = dailyBudgetMinor;
          }
          const next = statusAfter(act.action, c.status);
          await one(db.from("ad_campaigns").update({ status: next, external, daily_budget_minor: budgetMinor, last_error: null }).eq("id", c.id));
          await one(db.from("ad_actions").update({ status: "done", executed_at: new Date().toISOString(), result: external }).eq("id", act.id));
          return { status: "done", campaignStatus: next };
        } catch (err) {
          const msg = err instanceof Error ? err.message.slice(0, 500) : String(err);
          const final = err instanceof AppError && !err.retryable;
          if (final || (Context.current().info.attempt ?? 1) >= 3) {
            await one(db.from("ad_actions").update({ status: "failed", error: msg }).eq("id", act.id));
            await one(db.from("ad_campaigns").update({ ...(act.action === "launch" && { status: "failed" }), last_error: msg }).eq("id", c.id));
          }
          throw err;
        }
      });
    },

    /** Month-to-date spend per ad account; over the cap with auto-pause on → pause every active Arcatic campaign there. */
    async adSpendGuard(a: { workspaceId: string }): Promise<{ paused: number }> {
      return wrap(async () => {
        const policies = await one<PolicyRow[]>(db.from("ad_account_policies").select("*").eq("workspace_id", a.workspaceId).not("monthly_spend_cap_minor", "is", null));
        if (!policies.length) return { paused: 0 };
        const monthStart = new Date().toISOString().slice(0, 8) + "01";
        let paused = 0;
        for (const p of policies) {
          const rows = await one<Array<{ spend_minor: number | null }>>(db.from("performance_metrics").select("spend_minor").eq("workspace_id", a.workspaceId).eq("kind", "ad").like("metric_key", `ad:${p.connection_id}:%`).gte("metric_date", monthStart));
          const spent = rows.reduce((s, r) => s + Number(r.spend_minor ?? 0), 0);
          const active = await one<CampaignRow[]>(db.from("ad_campaigns").select("*").eq("connection_id", p.connection_id).eq("status", "active"));
          const ids = campaignsToPause(spent, { manageEnabled: p.manage_enabled, maxDailyBudgetMinor: p.max_daily_budget_minor, monthlySpendCapMinor: p.monthly_spend_cap_minor, autoPauseOnCap: p.auto_pause_on_cap }, active);
          if (!ids.length) continue;
          const cn = await conn(a.workspaceId, p.connection_id);
          for (const c of active.filter((x) => ids.includes(x.id))) {
            await db.from("ad_actions").update({ status: "cancelled" }).eq("campaign_id", c.id).in("status", ["pending", "approved"]);
            const ins = await db.from("ad_actions").insert({ workspace_id: c.workspace_id, campaign_id: c.id, action: "pause", campaign_revision: c.revision, summary: `Paused automatically: this month's spend reached the cap.`, status: "approved", payload: { reason: "spend_cap", spentMinor: spent } }).select("id").single();
            if (ins.error) continue;   // another pause is already in flight
            try {
              if (c.platform === "google") await sidecar().googleUpdate({ ...(await googleAuth(a.workspaceId, cn)), campaignId: c.external.campaignId!, status: "paused" });
              else await sidecar().metaUpdate({ accessToken: await metaToken(a.workspaceId, cn), campaignId: c.external.campaignId!, status: "paused" });
              await one(db.from("ad_campaigns").update({ status: "paused", last_error: "Paused by the monthly spend cap" }).eq("id", c.id));
              await one(db.from("ad_actions").update({ status: "done", executed_at: new Date().toISOString() }).eq("id", ins.data.id));
              paused++;
            } catch (e) {
              await db.from("ad_actions").update({ status: "failed", error: String(e).slice(0, 500) }).eq("id", ins.data.id);
            }
          }
        }
        return { paused };
      });
    },

    async markAdsDraftFailed(a: { campaignId: string; message: string }): Promise<void> {
      await db.from("ad_campaigns").update({ last_error: a.message.slice(0, 500) }).eq("id", a.campaignId);
    },
  };
}

export type AdsActivities = ReturnType<typeof createAdsActivities>;
