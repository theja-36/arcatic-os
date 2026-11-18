import { z } from "zod";
import { AppError } from "../errors.js";
import { stableStringify } from "./util.js";
import { BrandKitSchema, LIST_LIMITS, LIST_SECTIONS, valueSchemaFor, type AnyFact, type BrandKit, type ListSection } from "./kit.js";

/**
 * Edits a person (or onboarding) makes to a Brand Kit. Pure: returns a new kit.
 * Human-entered values are approved immediately; the kit version itself still needs approval
 * before generation uses it.
 */
export const KitOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("clear"), path: z.string() }),
  z.object({ op: z.literal("add"), list: z.enum(["audiences", "offers"]), value: z.unknown() }),
  z.object({ op: z.literal("update"), id: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("remove"), id: z.string() }),
  z.object({ op: z.literal("approve"), id: z.string() }),
  z.object({ op: z.literal("reject"), id: z.string() }),
  z.object({ op: z.literal("accept_suggestion"), id: z.string() }),
  z.object({ op: z.literal("dismiss_suggestion"), id: z.string() }),
  z.object({ op: z.literal("set_meta"), name: z.string().min(1).max(120).optional(), claimsPolicy: z.enum(["strict", "relaxed"]).optional(), languages: z.object({ primary: z.string(), supported: z.array(z.string()).min(1) }).optional() }),
]);
export type KitOp = z.infer<typeof KitOpSchema>;

export interface OpContext {
  now: string;
  newId: () => string;
  origin?: "human" | "onboarding";
}

function parseValue(path: string, value: unknown) {
  const schema = valueSchemaFor(path);
  if (!schema) throw new AppError("validation_failed", `Unknown field ${path}.`);
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError("validation_failed", `Invalid value for ${path}.`, {
      details: r.error.issues.map((i) => ({ path: [path, ...i.path].join("."), message: i.message })),
    });
  }
  return r.data;
}

function locate(kit: BrandKit, id: string): { path: string; get: () => AnyFact | undefined; put: (f: AnyFact | undefined) => void } {
  const [list] = id.split(":");
  if (id.includes(":") && list && list in LIST_SECTIONS) {
    const arr = kit[list as ListSection] as AnyFact[];
    const idx = arr.findIndex((f) => f.id === id);
    return {
      path: list,
      get: () => (idx >= 0 ? arr[idx] : undefined),
      put: (f) => {
        if (idx < 0) return;
        if (f) arr[idx] = f;
        else arr.splice(idx, 1);
      },
    };
  }
  return {
    path: id,
    get: () => kit.facts[id] as AnyFact | undefined,
    put: (f) => {
      if (f) kit.facts[id] = f as never;
      else delete kit.facts[id];
    },
  };
}

export function applyKitOps(input: BrandKit, ops: readonly KitOp[], ctx: OpContext): { kit: BrandKit; touched: string[] } {
  const kit = structuredClone(input);
  const origin = ctx.origin ?? "human";
  const sources = [{ kind: origin === "onboarding" ? ("onboarding" as const) : ("manual" as const) }];
  const touched = new Set<string>();

  for (const op of ops) {
    switch (op.op) {
      case "set": {
        const value = parseValue(op.path, op.value);
        if (op.path in LIST_SECTIONS) throw new AppError("validation_failed", `Use "add" for ${op.path}.`);
        kit.facts[op.path] = { id: op.path, value, status: "approved", origin, sources, updatedAt: ctx.now } as never;
        touched.add(op.path);
        break;
      }
      case "clear": {
        if (!valueSchemaFor(op.path)) throw new AppError("validation_failed", `Unknown field ${op.path}.`);
        delete kit.facts[op.path];
        touched.add(op.path);
        break;
      }
      case "add": {
        const arr = kit[op.list] as AnyFact[];
        if (arr.length >= LIST_LIMITS[op.list]) throw new AppError("validation_failed", `At most ${LIST_LIMITS[op.list]} ${op.list}.`);
        const id = `${op.list}:${ctx.newId()}`;
        arr.push({ id, value: parseValue(op.list, op.value), status: "approved", origin, sources, updatedAt: ctx.now });
        touched.add(id);
        break;
      }
      case "update": {
        const loc = locate(kit, op.id);
        const cur = loc.get();
        if (!cur) throw new AppError("not_found", `Fact ${op.id} not found.`);
        loc.put({ ...cur, value: parseValue(loc.path, op.value), status: "approved", origin, sources, unverified: undefined, confidence: undefined, updatedAt: ctx.now });
        touched.add(op.id);
        break;
      }
      case "remove": {
        const loc = locate(kit, op.id);
        if (!loc.get()) throw new AppError("not_found", `Fact ${op.id} not found.`);
        loc.put(undefined);
        touched.add(op.id);
        break;
      }
      case "approve":
      case "reject": {
        const loc = locate(kit, op.id);
        const cur = loc.get();
        if (!cur) throw new AppError("not_found", `Fact ${op.id} not found.`);
        loc.put({ ...cur, status: op.op === "approve" ? "approved" : "rejected", updatedAt: ctx.now });
        touched.add(op.id);
        break;
      }
      case "accept_suggestion": {
        const loc = locate(kit, op.id);
        const cur = loc.get();
        if (!cur?.suggestion) throw new AppError("not_found", `No pending suggestion on ${op.id}.`);
        const s = cur.suggestion;
        loc.put({ id: cur.id, value: s.value, status: "approved", origin: "ai", confidence: s.confidence, sources: s.sources, updatedAt: ctx.now });
        touched.add(op.id);
        break;
      }
      case "dismiss_suggestion": {
        const loc = locate(kit, op.id);
        const cur = loc.get();
        if (!cur?.suggestion) throw new AppError("not_found", `No pending suggestion on ${op.id}.`);
        const { suggestion: _drop, ...rest } = cur;
        loc.put(rest as AnyFact);
        touched.add(op.id);
        break;
      }
      case "set_meta": {
        if (op.name) kit.name = op.name;
        if (op.claimsPolicy) kit.claimsPolicy = op.claimsPolicy;
        if (op.languages) kit.languages = op.languages;
        touched.add("meta");
        break;
      }
    }
  }
  return { kit: BrandKitSchema.parse(kit), touched: [...touched] };
}

/** Fact ids whose effective (approved) value differs between two kits — drives selective regeneration. */
export function diffKits(prev: BrandKit | undefined, next: BrandKit): string[] {
  const eff = (k: BrandKit | undefined) => {
    const m = new Map<string, string>();
    if (!k) return m;
    for (const [path, f] of Object.entries(k.facts)) if (f.status === "approved") m.set(path, stableStringify(f.value));
    for (const f of [...k.audiences, ...k.offers]) if (f.status === "approved") m.set(f.id, stableStringify(f.value));
    return m;
  };
  const a = eff(prev);
  const b = eff(next);
  const ids = new Set([...a.keys(), ...b.keys()]);
  const changed = [...ids].filter((id) => a.get(id) !== b.get(id));
  // list membership changes also affect the list as a whole
  for (const list of ["audiences", "offers"]) if (changed.some((id) => id.startsWith(`${list}:`))) changed.push(list);
  return changed.sort();
}
