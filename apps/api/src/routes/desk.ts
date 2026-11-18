import { AppError, ContentDocSchema, fromDbError, rankSpecialists, transitionAllowed, type ContentDoc } from "@arcatic/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { body, check, ok } from "../http.js";
import { serviceNotify } from "../notify.js";
import { serviceOps } from "../service-ops.js";
import type { ApiDeps, AppEnv } from "../types.js";
import { linkFor, moveRequest, signedFiles, type Deliverable, type Offering, type ServiceRequest } from "./services.js";

/**
 * Service desk: Arcatic's service team. Staff are NOT workspace members; they see only the frozen
 * brief, the intake, files the customer attached, and the conversation — never the workspace.
 *  - specialists act on requests assigned to them
 *  - managers triage, assign, run quality review, and see everything that was submitted
 */
type Staff = { user_id: string; role: "manager" | "specialist"; display_name: string; skills: string[]; active: boolean; max_active: number };
const FILE_LIMIT = 200 * 1024 * 1024;
const MIME_OK = /^(image\/(png|jpeg|webp|gif|svg\+xml)|video\/(mp4|quicktime|webm)|audio\/(mpeg|wav|mp4)|application\/(pdf|zip)|text\/plain)$/;

function maybe<T>(res: { data: T; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw fromDbError(res.error);
  return res.data ?? null;
}

export const deskRoutes = (deps: ApiDeps) => {
  const r = new Hono<AppEnv>();
  const svc = () => deps.serviceDb();
  async function staff(c: Context<AppEnv>): Promise<Staff> {
    const p = c.get("principal");
    if (p.kind !== "user") throw new AppError("not_found", "Route not found.");
    const s = maybe(await svc().from("service_staff").select("*").eq("user_id", p.userId).eq("active", true).maybeSingle()) as Staff | null;
    if (!s) throw new AppError("not_found", "Route not found.");   // the desk doesn't exist for non-staff
    return s;
  }
  const manager = async (c: Context<AppEnv>) => {
    const s = await staff(c);
    if (s.role !== "manager") throw new AppError("forbidden", "Managers only.");
    return s;
  };
  async function request(c: Context<AppEnv>, s: Staff) {
    const req = maybe(await svc().from("service_requests").select("*").eq("id", c.req.param("requestId")!).maybeSingle()) as (ServiceRequest & { workspace_id: string }) | null;
    if (!req || req.status === "draft" || (s.role !== "manager" && req.assignee_id !== s.user_id)) throw new AppError("not_found", "Request not found.");
    return req;
  }
  const offering = async (key: string) => check(await svc().from("service_offerings").select("*").eq("key", key).single()) as Offering;
  const round = (req: ServiceRequest) => req.revisions_used + 1;
  async function currentDeliverable(req: ServiceRequest) {
    return maybe(await svc().from("service_deliverables").select("*").eq("request_id", req.id).eq("round", round(req)).maybeSingle()) as Deliverable | null;
  }
  const notes = serviceNotify(deps);
  const cFacts = (req: ServiceRequest & { workspace_id: string }, o: Pick<Offering, "name">) => ({ requestId: req.id, workspaceId: req.workspace_id, brandId: req.brand_id, title: req.title, offeringName: o.name, dueAt: req.due_at });
  const sFacts = (req: ServiceRequest, o: Pick<Offering, "name">) => ({ requestId: req.id, title: req.title, offeringName: o.name, dueAt: req.due_at });

  r.get("/me", async (c) => c.json(await staff(c)));

  /** Managers: workload, SLA, credit holds. */
  r.get("/ops", async (c) => {
    await manager(c);
    return c.json(await serviceOps(svc()));
  });

  r.get("/requests", async (c) => {
    const s = await staff(c);
    const scope = c.req.query("scope") ?? (s.role === "manager" ? "queue" : "mine");
    let q = svc().from("service_requests").select("id, workspace_id, brand_id, offering_key, title, status, due_at, assignee_id, revisions_used, submitted_at, delivered_at, updated_at").neq("status", "draft").order("due_at", { ascending: true }).limit(200);
    if (s.role !== "manager" || scope === "mine") q = q.eq("assignee_id", s.user_id);
    if (scope === "queue") q = q.in("status", ["submitted", "in_review", "revision_requested"]);
    else if (scope !== "all") q = q.in("status", ["assigned", "in_progress", "in_review", "revision_requested", "submitted"]);
    const rows = check(await q) as Array<{ workspace_id: string; brand_id: string }>;
    const brands = rows.length ? check(await svc().from("brands").select("id, name").in("id", [...new Set(rows.map((x) => x.brand_id))])) as Array<{ id: string; name: string }> : [];
    return c.json({ data: rows.map((x) => ({ ...x, brandName: brands.find((b) => b.id === x.brand_id)?.name ?? null })), role: s.role });
  });

  r.get("/requests/:requestId", async (c) => {
    const s = await staff(c);
    const req = await request(c, s);
    const [o, messages, events, dels, brand] = await Promise.all([
      offering(req.offering_key),
      svc().from("service_messages").select("id, author_kind, author_id, visibility, body, created_at").eq("request_id", req.id).order("created_at", { ascending: true }).limit(500),
      svc().from("service_events").select("id, from_status, to_status, kind, actor_kind, note, created_at").eq("request_id", req.id).order("id", { ascending: true }).limit(500),
      svc().from("service_deliverables").select("*").eq("request_id", req.id).order("round", { ascending: false }),
      svc().from("brands").select("name").eq("id", req.brand_id).single(),
    ]);
    // reference files the customer attached: short-lived links, no library access
    const refs = req.reference_asset_ids.length ? check(await svc().from("media_assets").select("id, title, kind, storage_path, mime_type").eq("workspace_id", req.workspace_id).in("id", req.reference_asset_ids)) as Array<{ id: string; title: string | null; kind: string; storage_path: string; mime_type: string | null }> : [];
    const refLinks = await Promise.all(refs.map(async (a) => ({ id: a.id, title: a.title, kind: a.kind, mime: a.mime_type, url: ((await svc().storage.from("media").createSignedUrl(a.storage_path, 3600)).data as { signedUrl?: string } | null)?.signedUrl ?? null })));
    const source = req.source_version_id ? maybe(await svc().from("content_versions").select("body").eq("id", req.source_version_id).maybeSingle()) as { body: { doc?: ContentDoc } } | null : null;
    const { reservation_id: _a, extra_reservation_ids: _b, ...pub } = req as ServiceRequest & Record<string, unknown>;
    return c.json({
      ...pub, brandName: (check(brand) as { name: string }).name, offering: o, messages: check(messages), events: check(events), references: refLinks, sourceDoc: source?.body.doc ?? null,
      deliverables: await Promise.all((check(dels) as Deliverable[]).map(async (d) => ({ ...d, files: await signedFiles(svc(), d.files ?? []) }))), role: s.role, mine: req.assignee_id === s.user_id,
    });
  });

  // ---------------------------------------------------------------- triage (managers)
  r.get("/staff", async (c) => {
    await manager(c);
    const team = check(await svc().from("service_staff").select("*").order("display_name")) as Staff[];
    const open = check(await svc().from("service_requests").select("assignee_id").in("status", ["assigned", "in_progress", "in_review", "revision_requested"]).not("assignee_id", "is", null)) as Array<{ assignee_id: string }>;
    const load = new Map<string, number>();
    for (const o of open) load.set(o.assignee_id, (load.get(o.assignee_id) ?? 0) + 1);
    const forReq = c.req.query("requestId");
    let suggested: string[] = [];
    if (forReq) {
      const req = maybe(await svc().from("service_requests").select("offering_key").eq("id", forReq).maybeSingle()) as { offering_key: string } | null;
      if (req) suggested = rankSpecialists(team, (await offering(req.offering_key)).category, load).map((x) => x.user_id);
    }
    return c.json({ data: team.map((t) => ({ ...t, load: load.get(t.user_id) ?? 0 })), suggested });
  });

  r.post("/requests/:requestId/assign", async (c) => {
    const i = await body(c, z.object({ userId: z.uuid() }));
    const m = await manager(c);
    const req = await request(c, m);
    const target = maybe(await svc().from("service_staff").select("*").eq("user_id", i.userId).eq("active", true).maybeSingle()) as Staff | null;
    if (!target) throw new AppError("not_found", "That person isn't on the service team.");
    let up: ServiceRequest;
    if (req.status === "assigned") {
      // reassign before work starts: same status, new owner
      const u = await svc().from("service_requests").update({ assignee_id: target.user_id, assigned_at: new Date().toISOString() }).eq("id", req.id).eq("lock_version", req.lock_version).select("*").maybeSingle();
      if (u.error) throw fromDbError(u.error);
      if (!u.data) throw new AppError("conflict", "This request just changed; reload.");
      up = u.data as ServiceRequest;
      await svc().from("service_events").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, kind: "assigned", actor_id: m.user_id, actor_kind: "staff", note: target.display_name, visibility: "internal" });
    } else {
      if (!transitionAllowed(req.status, "assigned", "manager")) throw new AppError("conflict", `A ${req.status} request can't be assigned.`);
      up = await moveRequest(svc(), req, "assigned", { assignee_id: target.user_id, assigned_at: new Date().toISOString() }, { actorId: m.user_id, actorKind: "staff" });
      await svc().from("service_events").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, kind: "assigned", actor_id: m.user_id, actor_kind: "staff", note: target.display_name, visibility: "internal" });
    }
    const o = await offering(req.offering_key);
    await notes.staff([target.user_id], "assigned", sFacts(up, o), `assigned:${req.id}:${target.user_id}:${up.lock_version}`);
    if (req.status === "submitted") await notes.customers(req, "assigned", cFacts(req, o), `assigned:${req.id}`);   // once, without naming the specialist
    return c.json(up);
  });

  r.post("/requests/:requestId/unassign", async (c) => {
    const m = await manager(c);
    const req = await request(c, m);
    if (!transitionAllowed(req.status, "submitted", "manager")) throw new AppError("conflict", "Only assigned requests that haven't started can be unassigned.");
    return c.json(await moveRequest(svc(), req, "submitted", { assignee_id: null, assigned_at: null }, { actorId: m.user_id, actorKind: "staff", note: "Unassigned", internal: true }));
  });

  // ---------------------------------------------------------------- doing the work (assignee)
  r.post("/requests/:requestId/start", async (c) => {
    const s = await staff(c);
    const req = await request(c, s);
    if (req.assignee_id !== s.user_id || !transitionAllowed(req.status, "in_progress", "specialist")) throw new AppError("conflict", "Only the assigned specialist can start this.");
    const up = await moveRequest(svc(), req, "in_progress", {}, { actorId: s.user_id, actorKind: "staff" });
    if (!(await currentDeliverable(req))) {
      // round 1 starts from the customer's draft (if any); later rounds from the last delivery
      const prev = maybe(await svc().from("service_deliverables").select("doc, files").eq("request_id", req.id).order("round", { ascending: false }).limit(1).maybeSingle()) as { doc: ContentDoc | null; files: Deliverable["files"] } | null;
      const src = !prev && req.source_version_id ? maybe(await svc().from("content_versions").select("body").eq("id", req.source_version_id).maybeSingle()) as { body: { doc?: ContentDoc } } | null : null;
      const ins = await svc().from("service_deliverables").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, round: round(req), doc: prev?.doc ?? src?.body.doc ?? null, files: prev?.files ?? [], created_by: s.user_id });
      if (ins.error && ins.error.code !== "23505") throw fromDbError(ins.error);
    }
    return c.json(up);
  });

  r.put("/requests/:requestId/deliverable", async (c) => {
    const i = await body(c, z.object({ doc: ContentDocSchema.nullable().optional(), note: z.string().trim().max(5000).nullable().optional() }));
    const s = await staff(c);
    const req = await request(c, s);
    if (req.assignee_id !== s.user_id || req.status !== "in_progress") throw new AppError("conflict", "Start the work first.");
    const d = await currentDeliverable(req);
    if (!d) throw new AppError("conflict", "Start the work first.");
    const up = check(await svc().from("service_deliverables").update({ ...(i.doc !== undefined && { doc: i.doc }), ...(i.note !== undefined && { note: i.note }), status: "draft" }).eq("id", d.id).select("id, round, doc, files, note, status, updated_at").single());
    return c.json(up);
  });

  /** Signed upload into the private service-files bucket; the file joins the deliverable on confirm. */
  r.post("/requests/:requestId/files", async (c) => {
    const i = await body(c, z.object({ name: z.string().trim().min(1).max(200), mime: z.string().max(100), size: z.number().int().positive().max(FILE_LIMIT) }));
    const s = await staff(c);
    const req = await request(c, s);
    if (req.assignee_id !== s.user_id || req.status !== "in_progress") throw new AppError("conflict", "Start the work first.");
    if (!MIME_OK.test(i.mime)) throw new AppError("validation_failed", "That file type isn't accepted.");
    const path = `${req.id}/r${round(req)}/${crypto.randomUUID()}-${i.name.replace(/[^\w.\- ]+/g, "_")}`;
    const up = await svc().storage.from("service-files").createSignedUploadUrl(path);
    if (up.error || !up.data) throw new AppError("upstream_error", "Couldn't prepare the upload.", { retryable: true });
    return c.json({ path, ...(up.data as object) }, 201);
  });

  r.post("/requests/:requestId/files/confirm", async (c) => {
    const i = await body(c, z.object({ path: z.string().min(1).max(500), name: z.string().trim().min(1).max(200), mime: z.string().max(100), size: z.number().int().positive().max(FILE_LIMIT) }));
    const s = await staff(c);
    const req = await request(c, s);
    if (req.assignee_id !== s.user_id || req.status !== "in_progress" || !i.path.startsWith(`${req.id}/r${round(req)}/`)) throw new AppError("conflict", "That upload doesn't belong to this round.");
    const d = await currentDeliverable(req);
    if (!d) throw new AppError("conflict", "Start the work first.");
    const head = await svc().storage.from("service-files").createSignedUrl(i.path, 60);
    if (head.error || !(head.data as { signedUrl?: string } | null)?.signedUrl) throw new AppError("validation_failed", "The upload wasn't found; upload it again.");
    const files = [...(d.files ?? []).filter((f) => f.path !== i.path), { path: i.path, name: i.name, mime: i.mime, size: i.size }].slice(0, 30);
    const up = check(await svc().from("service_deliverables").update({ files }).eq("id", d.id).select("id, files").single());
    await svc().from("service_events").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, kind: "file_added", actor_id: s.user_id, actor_kind: "staff", note: i.name, visibility: "internal" });
    return c.json(up);
  });

  r.delete("/requests/:requestId/files", async (c) => {
    const path = c.req.query("path") ?? "";
    const s = await staff(c);
    const req = await request(c, s);
    const d = await currentDeliverable(req);
    if (req.assignee_id !== s.user_id || req.status !== "in_progress" || !d) throw new AppError("conflict", "Start the work first.");
    ok(await svc().from("service_deliverables").update({ files: (d.files ?? []).filter((f) => f.path !== path) }).eq("id", d.id));
    await svc().storage.from("service-files").remove([path]);
    return c.body(null, 204);
  });

  /** Hand in: to quality review when the offering needs it, otherwise straight to the customer. */
  r.post("/requests/:requestId/submit", async (c) => {
    const s = await staff(c);
    const req = await request(c, s);
    if (req.assignee_id !== s.user_id || req.status !== "in_progress") throw new AppError("conflict", "Only the assigned specialist can hand this in.");
    const o = await offering(req.offering_key);
    const d = await currentDeliverable(req);
    const hasDoc = !!d?.doc && d.doc.blocks.some((b) => b.text.trim());
    if (!d || ((o.deliverable_kind === "content" || o.deliverable_kind === "content_and_files") && !hasDoc)) throw new AppError("validation_failed", "Add the finished text first.");
    if ((o.deliverable_kind === "files" || o.deliverable_kind === "content_and_files") && !(d.files ?? []).length) throw new AppError("validation_failed", "Upload the finished files first.");
    if (o.qa_required) {
      const up = await moveRequest(svc(), req, "in_review", {}, { actorId: s.user_id, actorKind: "staff", internal: true });
      ok(await svc().from("service_deliverables").update({ status: "in_review" }).eq("id", d.id));
      await notes.staff((await notes.managers()).filter((u) => u !== s.user_id), "qa_ready", { ...sFacts(req, o), specialistName: s.display_name }, `qa:${req.id}:${d.round}:${up.lock_version}`);
      return c.json(up);
    }
    return c.json(await deliver(req, d, s));
  });

  r.post("/requests/:requestId/qa", async (c) => {
    const i = await body(c, z.object({ decision: z.enum(["approve", "return"]), note: z.string().trim().max(5000).optional() }));
    const m = await manager(c);
    const req = await request(c, m);
    if (req.status !== "in_review") throw new AppError("conflict", "Nothing is waiting for QA.");
    const d = await currentDeliverable(req);
    if (!d) throw new AppError("conflict", "The deliverable is missing.");
    if (i.decision === "return") {
      if (!i.note) throw new AppError("validation_failed", "Say what needs fixing.");
      const up = await moveRequest(svc(), req, "in_progress", { qa_by: m.user_id }, { actorId: m.user_id, actorKind: "staff", note: "Returned by QA", internal: true });
      ok(await svc().from("service_deliverables").update({ status: "returned", qa_note: i.note }).eq("id", d.id));
      await svc().from("service_messages").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, author_id: m.user_id, author_kind: "staff", visibility: "internal", body: `QA: ${i.note}` });
      await notes.staff([req.assignee_id], "qa_returned", { ...sFacts(req, await offering(req.offering_key)), qaNote: i.note });   // staff only: QA never reaches the customer
      return c.json(up);
    }
    return c.json(await deliver(req, d, m, true));
  });

  async function deliver(req: ServiceRequest & { workspace_id: string }, d: Deliverable, s: Staff, viaQa = false) {
    const up = await moveRequest(svc(), req, "delivered", { delivered_at: new Date().toISOString(), ...(viaQa && { qa_by: s.user_id }) }, { actorId: s.user_id, actorKind: "staff" });
    ok(await svc().from("service_deliverables").update({ status: "superseded" }).eq("request_id", req.id).eq("status", "delivered"));
    ok(await svc().from("service_deliverables").update({ status: "delivered" }).eq("id", d.id));
    await notes.customers(req, "delivered", { ...cFacts(req, await offering(req.offering_key)), customerNote: d.note }, `delivered:${req.id}:${d.round}`);
    return up;
  }

  r.post("/requests/:requestId/messages", async (c) => {
    const i = await body(c, z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) }));
    const s = await staff(c);
    const req = await request(c, s);
    const m = check(await svc().from("service_messages").insert({ request_id: req.id, workspace_id: req.workspace_id, brand_id: req.brand_id, author_id: s.user_id, author_kind: "staff", visibility: i.internal ? "internal" : "all", body: i.body }).select("id, author_kind, visibility, body, created_at").single());
    if (!i.internal) await notes.customers(req, "message", { ...cFacts(req, await offering(req.offering_key)), staffMessage: i.body });
    return c.json(m, 201);
  });

  return r;
};
