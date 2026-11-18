import {
  AppError, CONTENT_TYPE_DEFS, IntakeFieldSchema, SERVICE_HOLD_TTL_SECONDS, buildServiceBrief, canEditContent, customerStage, docText, dueAt, fromDbError,
  isContentType, revisionCost, revisionDueAt, transitionAllowed, validateDoc, validateIntake, type BrandContext, type ContentDoc, type ServiceStatus,
} from "@arcatic/core";
import { ledger, type Db } from "@arcatic/database";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, ok } from "../http.js";
import { requirePermission as can } from "../middleware/workspace.js";
import { serviceNotify } from "../notify.js";
import type { ApiDeps, AppEnv } from "../types.js";
import { assertCanSpend } from "./billing.js";

/**
 * Human-finished services, customer side: intake → submit (credits held) → follow progress and
 * talk to the team → review the delivery → approve (charged, delivered into Content / Media) or
 * ask for a revision (included revisions are free, further ones hold extra credits).
 */
export const REQUEST_COLS = "id, brand_id, offering_key, title, status, intake, brief, source_content_item_id, source_version_id, reference_asset_ids, credits, revisions_included, revisions_used, due_at, submitted_at, assigned_at, delivered_at, approved_at, cancelled_at, result_content_item_id, result_version_id, result_asset_ids, rating, feedback, lock_version, created_by, created_at, updated_at";
export type Offering = { key: string; name: string; description: string; category: string; credits: number; turnaround_hours: number; included_revisions: number; extra_revision_credits: number; deliverable_type: string | null; deliverable_kind: "content" | "files" | "content_and_files"; needs_source_content: boolean; qa_required: boolean; intake_fields: unknown };
export type ServiceRequest = {
  id: string; workspace_id?: string; brand_id: string; offering_key: string; title: string; status: ServiceStatus; intake: Record<string, unknown>; brief: unknown; source_content_item_id: string | null; source_version_id: string | null;
  reference_asset_ids: string[]; credits: number | null; reservation_id?: string | null; extra_reservation_ids?: string[]; revisions_included: number; revisions_used: number; assignee_id?: string | null;
  due_at: string | null; lock_version: number; created_by: string | null;
};
export type Deliverable = { id: string; request_id: string; round: number; doc: ContentDoc | null; files: Array<{ path: string; name: string; mime: string; size: number }>; note: string | null; status: string; qa_note?: string | null };

function maybe<T>(res: { data: T; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw fromDbError(res.error);
  return res.data ?? null;
}
export const offeringFields = (o: Offering) => z.array(IntakeFieldSchema).parse(o.intake_fields ?? []);
export const linkFor = (r: { workspace_id?: string; brand_id: string; id: string }, ws?: string) => `/w/${ws ?? r.workspace_id}/b/${r.brand_id}/services/${r.id}`;

/** Status change guarded twice: by the actor rules here and by the DB trigger; the lock version stops lost updates. */
export async function moveRequest(db: Db, r: ServiceRequest, to: ServiceStatus, patch: Record<string, unknown>, ev: { actorId: string | null; actorKind: "customer" | "staff" | "system"; note?: string; internal?: boolean }) {
  const up = await db.from("service_requests").update({ status: to, ...patch }).eq("id", r.id).eq("lock_version", r.lock_version).select("*").maybeSingle();
  if (up.error) throw fromDbError(up.error);
  if (!up.data) throw new AppError("conflict", "This request just changed; reload and try again.");
  await db.from("service_events").insert({ request_id: r.id, workspace_id: r.workspace_id, brand_id: r.brand_id, from_status: r.status, to_status: to, kind: "status", actor_id: ev.actorId, actor_kind: ev.actorKind, note: ev.note ?? null, visibility: ev.internal ? "internal" : "all" });
  return up.data as ServiceRequest;
}

export async function signedFiles(db: Db, files: Deliverable["files"]) {
  return Promise.all(files.map(async (f) => {
    const s = await db.storage.from("service-files").createSignedUrl(f.path, 3600);
    return { ...f, url: (s.data as { signedUrl?: string } | null)?.signedUrl ?? null };
  }));
}

const mimeKind = (m: string) => (m.startsWith("image/") ? "image" : m.startsWith("video/") ? "video" : m.startsWith("audio/") ? "audio" : "document");

export const serviceRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const ws = (c: Context<AppEnv>) => c.get("workspaceId");
  const brandId = (c: Context<AppEnv>) => c.req.param("brandId")!;
  const svc = () => deps.serviceDb();
  const notes = serviceNotify(deps);
  const facts = (req: ServiceRequest, o: Pick<Offering, "name">, extra: Record<string, unknown> = {}) => ({ requestId: req.id, workspaceId: req.workspace_id ?? ws_(req), brandId: req.brand_id, title: req.title, offeringName: o.name, dueAt: req.due_at, ...extra });
  const ws_ = (req: ServiceRequest) => req.workspace_id as string;
  const userOnly = (c: Context<AppEnv>) => {
    const p = c.get("principal");
    if (p.kind !== "user") throw new AppError("forbidden", "Service requests need a signed-in person.");
    return p.userId;
  };
  const offering = async (key: string) => {
    const o = maybe(await svc().from("service_offerings").select("*").eq("key", key).eq("active", true).maybeSingle()) as Offering | null;
    if (!o) throw new AppError("not_found", "That service isn't available.");
    return o;
  };
  async function request(c: Context<AppEnv>) {
    const row = maybe(await c.get("db").from("service_requests").select(REQUEST_COLS).eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).eq("id", c.req.param("requestId")!).maybeSingle()) as ServiceRequest | null;
    if (!row) throw new AppError("not_found", "Request not found.");
    const full = maybe(await svc().from("service_requests").select("*").eq("id", row.id).maybeSingle()) as ServiceRequest;
    return full;
  }
  async function sourceOk(c: Context<AppEnv>, id: string | null | undefined) {
    if (!id) return null;
    const it = maybe(await c.get("db").from("content_items").select("id, current_version_id").eq("brand_id", brandId(c)).eq("id", id).maybeSingle()) as { id: string; current_version_id: string | null } | null;
    if (!it?.current_version_id) throw new AppError("not_found", "Pick a content item that has a draft.");
    return it;
  }
  async function assetsOk(c: Context<AppEnv>, ids: string[]) {
    if (!ids.length) return;
    const rows = check(await c.get("db").from("media_assets").select("id").eq("workspace_id", ws(c)).in("id", ids)) as Array<{ id: string }>;
    if (rows.length !== new Set(ids).size) throw new AppError("not_found", "A reference file wasn't found.");
  }
  const customerView = <T extends { status: ServiceStatus }>(x: T) => ({ ...x, stage: customerStage(x.status) });

  // ---------------------------------------------------------------- catalogue
  r.get("/services/offerings", async (c) => {
    const rows = check(await c.get("db").from("service_offerings").select("key, name, description, category, credits, turnaround_hours, included_revisions, extra_revision_credits, deliverable_type, deliverable_kind, needs_source_content, intake_fields").eq("active", true).order("sort"));
    return c.json({ data: rows });
  });

  // ---------------------------------------------------------------- requests
  r.get("/brands/:brandId/services", can("content.read"), async (c) => {
    const rows = check(await c.get("db").from("service_requests").select(REQUEST_COLS).eq("workspace_id", ws(c)).eq("brand_id", brandId(c)).order("updated_at", { ascending: false }).limit(200)) as Array<{ status: ServiceStatus }>;
    return c.json({ data: rows.map(customerView) });
  });

  r.post("/brands/:brandId/services", can("content.create"), async (c) => {
    const i = await body(c, z.object({
      offeringKey: z.string().min(1).max(60), title: z.string().trim().min(1).max(200), intake: z.record(z.string(), z.unknown()).default({}),
      sourceContentItemId: z.uuid().nullable().optional(), referenceAssetIds: z.array(z.uuid()).max(20).default([]),
    }));
    const who = userOnly(c);
    const o = await offering(i.offeringKey);
    const v = validateIntake(offeringFields(o), i.intake, { partial: true });
    if (!v.ok) throw new AppError("validation_failed", "Check the form.", { details: v.errors });
    await sourceOk(c, i.sourceContentItemId);
    await assetsOk(c, i.referenceAssetIds);
    const row = check(await svc().from("service_requests").insert({
      workspace_id: ws(c), brand_id: brandId(c), offering_key: o.key, title: i.title, intake: v.values, source_content_item_id: i.sourceContentItemId ?? null,
      reference_asset_ids: i.referenceAssetIds, revisions_included: o.included_revisions, created_by: who,
    }).select(REQUEST_COLS).single()) as { status: ServiceStatus };
    return c.json(customerView(row), 201);
  });

  r.get("/brands/:brandId/services/:requestId", can("content.read"), async (c) => {
    const req = await request(c);
    const [o, messages, events, deliverables] = await Promise.all([
      offering(req.offering_key).catch(() => null),
      c.get("db").from("service_messages").select("id, author_kind, author_id, body, created_at").eq("request_id", req.id).eq("visibility", "all").order("created_at", { ascending: true }).limit(500),
      c.get("db").from("service_events").select("id, from_status, to_status, kind, actor_kind, note, created_at").eq("request_id", req.id).eq("visibility", "all").order("id", { ascending: true }).limit(500),
      c.get("db").from("service_deliverables").select("id, round, doc, files, note, status, created_at, updated_at").eq("request_id", req.id).in("status", ["delivered", "accepted", "superseded"]).order("round", { ascending: false }),
    ]);
    const dels = check(deliverables) as unknown as Deliverable[];
    const { reservation_id: _r, extra_reservation_ids: _x, assignee_id, ...pub } = req as ServiceRequest & Record<string, unknown>;
    return c.json({
      ...customerView(pub as unknown as ServiceRequest), assigned: !!assignee_id, offering: o, messages: check(messages),
      // internal QA steps stay internal: customers see "being worked on" until it's delivered
      events: (check(events) as Array<{ to_status: string | null; kind: string; note: string | null }>).filter((e) => e.to_status !== "in_review" && !(e.kind === "status" && e.to_status === "in_progress" && e.note === "Returned by QA")).map((e) => (e.kind === "assigned" ? { ...e, note: null } : e)),
      deliverables: await Promise.all(dels.map(async (d) => ({ ...d, files: await signedFiles(svc(), d.files ?? []) }))),
      nextRevisionCredits: o ? revisionCost(o, req.revisions_used) : null,
    });
  });

  r.patch("/brands/:brandId/services/:requestId", can("content.create"), async (c) => {
    const i = await body(c, z.object({ title: z.string().trim().min(1).max(200).optional(), intake: z.record(z.string(), z.unknown()).optional(), sourceContentItemId: z.uuid().nullable().optional(), referenceAssetIds: z.array(z.uuid()).max(20).optional() }));
    userOnly(c);
    const req = await request(c);
    if (req.status !== "draft") throw new AppError("conflict", "Only drafts can be edited; send the team a message instead.");
    const o = await offering(req.offering_key);
    const patch: Record<string, unknown> = {};
    if (i.title) patch.title = i.title;
    if (i.intake) {
      const v = validateIntake(offeringFields(o), i.intake, { partial: true });
      if (!v.ok) throw new AppError("validation_failed", "Check the form.", { details: v.errors });
      patch.intake = v.values;
    }
    if (i.sourceContentItemId !== undefined) { await sourceOk(c, i.sourceContentItemId); patch.source_content_item_id = i.sourceContentItemId; }
    if (i.referenceAssetIds) { await assetsOk(c, i.referenceAssetIds); patch.reference_asset_ids = i.referenceAssetIds; }
    const up = check(await svc().from("service_requests").update(patch).eq("id", req.id).eq("status", "draft").select(REQUEST_COLS).single()) as { status: ServiceStatus };
    return c.json(customerView(up));
  });

  /** Submit: full form check, brief frozen, price fixed, credits held (60 days). */
  r.post("/brands/:brandId/services/:requestId/submit", can("content.create"), async (c) => {
    const who = userOnly(c);
    const req = await request(c);
    if (!transitionAllowed(req.status, "submitted", "customer")) throw new AppError("conflict", `A ${req.status} request can't be submitted.`);
    const o = await offering(req.offering_key);
    const fields = offeringFields(o);
    const v = validateIntake(fields, req.intake);
    if (!v.ok) throw new AppError("validation_failed", "Check the form.", { details: v.errors });
    if (o.needs_source_content && !req.source_content_item_id) throw new AppError("validation_failed", "Pick the draft you want finished.");
    const brand = check(await svc().from("brands").select("active_kit_version_id").eq("id", req.brand_id).single()) as { active_kit_version_id: string | null };
    if (!brand.active_kit_version_id) throw new AppError("validation_failed", "Approve a Brand Kit first so the team knows your brand.");
    const ctx = (check(await svc().from("brand_contexts").select("context").eq("kit_version_id", brand.active_kit_version_id).single()) as { context: BrandContext }).context;
    let source: { title: string | null; type: string; text: string } | null = null;
    let sourceVersionId: string | null = null;
    if (req.source_content_item_id) {
      const it = check(await svc().from("content_items").select("title, type, current_version_id").eq("id", req.source_content_item_id).single()) as { title: string | null; type: string; current_version_id: string };
      const ver = check(await svc().from("content_versions").select("id, body").eq("id", it.current_version_id).single()) as { id: string; body: { doc?: ContentDoc } };
      source = { title: it.title, type: it.type, text: ver.body.doc ? docText(ver.body.doc) : "" };
      sourceVersionId = ver.id;
    }
    const refs = req.reference_asset_ids.length ? check(await svc().from("media_assets").select("title, kind").in("id", req.reference_asset_ids)) as Array<{ title: string | null; kind: string }> : [];
    const now = new Date();
    const due = dueAt(now, o.turnaround_hours);
    const brief = buildServiceBrief({ offering: o, fields, values: v.values, title: req.title, brand: ctx.data, source, references: refs.map((x) => ({ name: x.title ?? "file", kind: x.kind })), dueAt: due });
    await assertCanSpend(deps, ws(c));
    const hold = await ledger.reserve(svc(), { workspaceId: ws(c), amount: Number(o.credits), idempotencyKey: `service:${req.id}`, reason: `service.${o.key}`, ttlSeconds: SERVICE_HOLD_TTL_SECONDS });
    try {
      const up = await moveRequest(svc(), req, "submitted", { brief, credits: o.credits, reservation_id: hold.id, source_version_id: sourceVersionId, submitted_at: now.toISOString(), due_at: due.toISOString(), revisions_included: o.included_revisions }, { actorId: who, actorKind: "customer" });
      await svc().from("service_events").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, kind: "hold", actor_id: who, actor_kind: "customer", note: `${o.credits} credits held` });
      const brandName = (maybe(await svc().from("brands").select("name").eq("id", req.brand_id).maybeSingle()) as { name: string } | null)?.name ?? null;
      await notes.customers(req, "received", { ...facts(up, o), creditsHeld: Number(o.credits) }, `received:${req.id}`);
      await notes.staff(await notes.managers(), "new_request", { requestId: req.id, title: req.title, offeringName: o.name, brandName, dueAt: up.due_at }, `new:${req.id}`);
      return c.json({ ...customerView(up), reservation: { amount: hold.amount } });
    } catch (e) {
      await ledger.release(svc(), hold.id, "service_submit_failed").catch(() => undefined);
      throw e;
    }
  });

  r.post("/brands/:brandId/services/:requestId/cancel", can("content.create"), async (c) => {
    const who = userOnly(c);
    const req = await request(c);
    if (!transitionAllowed(req.status, "cancelled", "customer")) throw new AppError("conflict", req.status === "in_progress" || req.status === "in_review" ? "Work has started; message the team to stop it." : `A ${req.status} request can't be cancelled.`);
    const up = await moveRequest(svc(), req, "cancelled", { cancelled_at: new Date().toISOString() }, { actorId: who, actorKind: "customer" });
    let released = 0;
    for (const id of [req.reservation_id, ...(req.extra_reservation_ids ?? [])].filter((x): x is string => !!x)) {
      const r = await ledger.release(svc(), id, "service_cancelled").catch(() => null);
      if (r) released += Number(r.amount);
    }
    if (released) await svc().from("service_events").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, kind: "release", actor_id: who, actor_kind: "customer", note: `${released} credits released` });
    const o = await offering(req.offering_key).catch(() => ({ name: req.offering_key }));
    await notes.customers(req, "cancelled", { ...facts(req, o), creditsReleased: released }, `cancelled:${req.id}`);
    await notes.staff([req.assignee_id], "cancelled", { requestId: req.id, title: req.title, offeringName: o.name }, `cancelled:${req.id}`);
    return c.json(customerView(up));
  });

  r.post("/brands/:brandId/services/:requestId/messages", can("content.read"), async (c) => {
    const i = await body(c, z.object({ body: z.string().trim().min(1).max(5000) }));
    const who = userOnly(c);
    const req = await request(c);
    if (req.status === "draft") throw new AppError("conflict", "Submit the request first.");
    const m = check(await svc().from("service_messages").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, author_id: who, author_kind: "customer", body: i.body }).select("id, author_kind, body, created_at").single());
    const o = await offering(req.offering_key).catch(() => ({ name: req.offering_key }));
    await notes.staff(req.assignee_id ? [req.assignee_id] : await notes.managers(), "customer_message", { requestId: req.id, title: req.title, offeringName: o.name, customerText: i.body });
    return c.json(m, 201);
  });

  /** Accept the delivery: lands in Content / Media, then the held credits are charged. */
  r.post("/brands/:brandId/services/:requestId/approve", can("approval.decide"), async (c) => {
    const i = await body(c, z.object({ rating: z.number().int().min(1).max(5).optional(), feedback: z.string().trim().max(2000).optional() }));
    const who = userOnly(c);
    const req = await request(c);
    if (!transitionAllowed(req.status, "approved", "customer")) throw new AppError("conflict", "There's no delivery waiting for approval.");
    const o = await offering(req.offering_key);
    const del = maybe(await svc().from("service_deliverables").select("*").eq("request_id", req.id).eq("status", "delivered").order("round", { ascending: false }).limit(1).maybeSingle()) as Deliverable | null;
    if (!del) throw new AppError("conflict", "The delivery is missing; ask the team to deliver again.");

    // 1. make sure every hold is still there (re-hold if it expired) before delivering anything
    const holds = await prepareHolds(req, o, who);
    let resultItem: string | null = null, resultVersion: string | null = null;
    const assetIds: string[] = [];
    if (del.doc && o.deliverable_kind !== "files") {
      const r2 = await landContent(svc(), { req, o, doc: del.doc, actor: who });
      resultItem = r2.itemId; resultVersion = r2.versionId;
    }
    for (const f of del.files ?? []) {
      const dl = await svc().storage.from("service-files").download(f.path);
      if (dl.error || !dl.data) throw new AppError("upstream_error", `Couldn't copy ${f.name}; try again.`, { retryable: true });
      const id = crypto.randomUUID();
      const path = `${req.workspace_id}/${req.brand_id}/${id}/${f.name.replace(/[^\w.\- ]+/g, "_")}`;
      const up = await svc().storage.from("media").upload(path, dl.data as Blob, { contentType: f.mime, upsert: false });
      if (up.error) throw fromDbError(up.error as never);
      ok(await svc().from("media_assets").insert({ id, workspace_id: req.workspace_id, brand_id: req.brand_id, kind: mimeKind(f.mime), status: "ready", storage_path: path, source: "service", mime_type: f.mime, bytes: f.size, title: f.name, created_by: who, metadata: { serviceRequestId: req.id } }));
      assetIds.push(id);
    }

    const up = await moveRequest(svc(), req, "approved", { approved_at: new Date().toISOString(), rating: i.rating ?? null, feedback: i.feedback ?? null, result_content_item_id: resultItem, result_version_id: resultVersion, result_asset_ids: assetIds }, { actorId: who, actorKind: "customer" });
    ok(await svc().from("service_deliverables").update({ status: "accepted" }).eq("id", del.id));
    // charge: base price + every paid revision (each held separately)
    for (const h of holds) await ledger.settle(svc(), h.holdId, h.amount);
    const charged = holds.reduce((t, h) => t + h.amount, 0);
    await svc().from("service_events").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, kind: "charge", actor_id: who, actor_kind: "customer", note: `${charged} credits` });
    await notes.customers(req, "approved", { ...facts(req, o), creditsCharged: charged }, `approved:${req.id}`);
    await notes.staff([req.assignee_id], "approved", { requestId: req.id, title: req.title, offeringName: o.name, rating: i.rating ?? null, customerText: i.feedback ?? null }, `approved:${req.id}`);
    return c.json({ ...customerView(up), resultContentItemId: resultItem, resultAssetIds: assetIds });
  });

  r.post("/brands/:brandId/services/:requestId/revise", can("approval.decide"), async (c) => {
    const i = await body(c, z.object({ note: z.string().trim().min(5).max(5000) }));
    const who = userOnly(c);
    const req = await request(c);
    if (!transitionAllowed(req.status, "revision_requested", "customer")) throw new AppError("conflict", "There's no delivery to revise.");
    const o = await offering(req.offering_key);
    const cost = revisionCost(o, req.revisions_used);
    const extra = [...(req.extra_reservation_ids ?? [])];
    if (cost > 0) {
      await assertCanSpend(deps, ws(c));
      const hold = await ledger.reserve(svc(), { workspaceId: ws(c), amount: cost, idempotencyKey: `service:${req.id}:rev:${req.revisions_used + 1}`, reason: `service.${o.key}.revision`, ttlSeconds: SERVICE_HOLD_TTL_SECONDS });
      extra.push(hold.id);
    }
    const up = await moveRequest(svc(), req, "revision_requested", { revisions_used: req.revisions_used + 1, extra_reservation_ids: extra, due_at: revisionDueAt(new Date(), o.turnaround_hours).toISOString() }, { actorId: who, actorKind: "customer", note: i.note.slice(0, 500) });
    await svc().from("service_messages").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, author_id: who, author_kind: "customer", body: `Revision requested: ${i.note}` });
    if (cost > 0) await svc().from("service_events").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, kind: "hold", actor_id: who, actor_kind: "customer", note: `${cost} credits held for revision ${req.revisions_used + 1}` });
    await notes.staff(req.assignee_id ? [req.assignee_id] : await notes.managers(), "revision_requested", { requestId: req.id, title: req.title, offeringName: o.name, dueAt: up.due_at, customerText: i.note }, `revision:${req.id}:${req.revisions_used + 1}`);
    return c.json({ ...customerView(up), charged: cost });
  });

  /**
   * Charge on approval. A hold that expired or was lost (e.g. maintenance couldn't extend it) is
   * re-held first; without enough credits the approval stops with 402 and nothing is charged.
   */
  async function prepareHolds(req: ServiceRequest, o: Offering, who: string): Promise<Array<{ holdId: string; amount: number }>> {
    const parts: Array<{ id: string | null | undefined; amount: number; key: string }> = [
      { id: req.reservation_id, amount: Number(req.credits ?? o.credits), key: "base" },
      ...(req.extra_reservation_ids ?? []).map((id, i) => ({ id, amount: Number(o.extra_revision_credits), key: `rev${i + 1}` })),
    ];
    const ready: Array<{ holdId: string; amount: number }> = [];
    for (const p of parts) {
      let holdId = p.id ?? null;
      const cur = holdId ? maybe(await svc().from("credit_reservations").select("id, status").eq("id", holdId).maybeSingle()) as { id: string; status: string } | null : null;
      if (!cur || cur.status !== "held") {
        const re = await ledger.reserve(svc(), { workspaceId: req.workspace_id as string, amount: p.amount, idempotencyKey: `service:${req.id}:recharge:${p.key}`, reason: `service.${o.key}.recharge`, ttlSeconds: 3600 });
        holdId = re.id;
        await svc().from("service_events").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, kind: "hold", actor_id: who, actor_kind: "customer", note: `re-held ${p.amount} credits (previous hold ${cur?.status ?? "missing"})` });
      }
      ready.push({ holdId: holdId!, amount: p.amount });
    }
    return ready;
  }

  return r;
};

/** Put a delivered document into Content: a new version of the source item if it can still be edited, else a new item. */
async function landContent(db: Db, a: { req: ServiceRequest; o: Offering; doc: ContentDoc; actor: string }): Promise<{ itemId: string; versionId: string }> {
  const { req, o, doc, actor } = a;
  type Item = { id: string; type: string; channel: string | null; status: string; current_version_id: string | null };
  const item: Item | null = req.source_content_item_id ? maybe(await db.from("content_items").select("id, type, channel, status, current_version_id").eq("id", req.source_content_item_id).maybeSingle()) as Item | null : null;
  const type = item?.type ?? o.deliverable_type ?? "document";
  if (!isContentType(type)) throw new AppError("validation_failed", "Unsupported content type.");
  const report = validateDoc(type, doc, item?.channel ?? null);
  const plain = doc.blocks.map((b) => b.text).join("\n\n").slice(0, 50_000);
  if (item && canEditContent(item.status as never) && item.current_version_id) {
    const cur = check(await db.from("content_versions").select("version").eq("id", item.current_version_id).single()) as { version: number };
    const v = check(await db.from("content_versions").insert({
      workspace_id: req.workspace_id, brand_id: req.brand_id, content_item_id: item.id, version: cur.version + 1, origin: "human", transform: "service", base_version: cur.version,
      body: { format: 1, doc }, plain_text: plain, created_by: actor, validation_report: report, inputs: { serviceRequestId: req.id },
    }).select("id").single()) as { id: string };
    ok(await db.from("content_items").update({ current_version_id: v.id }).eq("id", item.id));
    return { itemId: item.id, versionId: v.id };
  }
  const def = CONTENT_TYPE_DEFS[type];
  const it = check(await db.from("content_items").insert({
    workspace_id: req.workspace_id, brand_id: req.brand_id, type, channel: item?.channel ?? ("defaultChannel" in def ? def.defaultChannel : null), title: req.title, status: "draft", created_by: actor,
    source_ref: { kind: "service", id: req.id, title: req.title },
  }).select("id").single()) as { id: string };
  const v = check(await db.from("content_versions").insert({
    workspace_id: req.workspace_id, brand_id: req.brand_id, content_item_id: it.id, version: 1, origin: "human", transform: "service", body: { format: 1, doc }, plain_text: plain, created_by: actor, validation_report: report, inputs: { serviceRequestId: req.id },
  }).select("id").single()) as { id: string };
  ok(await db.from("content_items").update({ current_version_id: v.id }).eq("id", it.id));
  return { itemId: it.id, versionId: v.id };
}
