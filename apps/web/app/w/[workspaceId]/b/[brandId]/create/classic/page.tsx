"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { CONTENT_TYPE_DEFS, LANGUAGES, SIZE_PRESETS, VISUAL_TEMPLATES, type ContentType } from "@arcatic/core";
import { Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { JobProgress } from "@/components/plan/JobProgress";

type Asset = { id: string; title: string | null; kind: string };
const GROUPS: Array<{ label: string; types: ContentType[] }> = [
  { label: "Social", types: ["social_post", "carousel", "story", "caption", "x_thread"] },
  { label: "Long-form & ads", types: ["email", "blog", "yt_script", "short_video", "ad"] },
  { label: "Visuals & images", types: ["static_visual", "profile_asset", "image", "product_photo"] },
];
const PROFILE_PRESETS = ["profile-picture", "facebook-cover", "linkedin-banner", "youtube-banner", "youtube-thumbnail", "sticker"];

export default function CreateClassic() {
  return <Suspense><Create /></Suspense>;
}

/** All types on one form (also used for image, product-photo and profile-asset flows from the wizard hub). */
function Create() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const initial = search.get("type");
  const [type, setType] = useState<ContentType>(initial && initial in CONTENT_TYPE_DEFS ? (initial as ContentType) : "social_post");
  const def = CONTENT_TYPE_DEFS[type];
  const [f, setF] = useState<Record<string, string | number>>({ language: "en" });
  const [tier, setTier] = useState<"economy" | "standard" | "premium">("standard");
  const [refs, setRefs] = useState<string[]>([]);
  const [refImage, setRefImage] = useState("");
  const [visual, setVisual] = useState({ preset: "instagram-square", template: "bold-headline", imageAssetId: "" });
  const [image, setImage] = useState({ prompt: "", preset: "instagram-square", count: 1, modelKey: "sdxl-base-1.0", productAssetId: "" });
  const [cost, setCost] = useState<{ estimate: number; max: number }>();
  const [job, setJob] = useState<string>();
  const [err, setErr] = useState("");
  const brand = useApi<{ languages: string[] }>(base);
  const sources = useApi<{ data: Array<{ id: string; title: string }> }>(`${base}/sources?limit=100&status=ready`);
  const images = useApi<{ data: Asset[] }>(`/workspaces/${workspaceId}/media?kind=image&limit=60`);
  const [models, setModels] = useState<Array<{ key: string; display_name: string; license: string }>>([]);
  useEffect(() => {
    void supabase().from("ai_models").select("key, display_name, license").eq("kind", "image").eq("enabled", true).eq("commercial_use", true).then(({ data }) => setModels(data ?? []));
  }, []);
  useEffect(() => { if (brand.data?.languages?.[0]) setF((x) => ({ ...x, language: brand.data!.languages[0]! })); }, [brand.data]);
  useEffect(() => {
    setF((x) => ({ ...x, channel: "defaultChannel" in def ? def.defaultChannel : "" }));
    if (type === "profile_asset") setVisual((v) => ({ ...v, preset: "profile-picture", template: "profile-badge" }));
    if (type === "static_visual") setVisual((v) => ({ ...v, preset: "instagram-square", template: "bold-headline" }));
  }, [type]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api<{ estimate: number; max: number }>(`${base}/content/estimate`, { method: "POST", body: JSON.stringify({ type, modelTier: tier, count: image.count }) }).then(setCost).catch(() => setCost(undefined));
  }, [base, type, tier, image.count]);

  const set = (k: string, v: string | number) => setF((x) => ({ ...x, [k]: v }));
  const text = (k: string, label: string, placeholder = "", area = false) => (
    <label className={cn("flex flex-col gap-1 text-sm", area && "sm:col-span-2")}>
      <span className="font-medium">{label}</span>
      {area ? <textarea className="min-h-20 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2" value={String(f[k] ?? "")} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />
        : <Input value={String(f[k] ?? "")} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />}
    </label>
  );
  const num = (k: string, label: string, min: number, max: number, dflt: number) => (
    <label className="flex flex-col gap-1 text-sm"><span className="font-medium">{label}</span><Input type="number" min={min} max={max} value={Number(f[k] ?? dflt)} onChange={(e) => set(k, Number(e.target.value))} /></label>
  );
  const presets = useMemo(() => Object.entries(SIZE_PRESETS).filter(([k]) => (type === "profile_asset" ? PROFILE_PRESETS.includes(k) : !PROFILE_PRESETS.includes(k) || k === "youtube-thumbnail")), [type]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      const input = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "" && v !== undefined));
      const payload = def.category === "image"
        ? { type, image: { ...image, productAssetId: image.productAssetId || undefined } }
        : {
            type, input, modelTier: tier, referenceSourceIds: refs.length ? refs : undefined, referenceMediaIds: refImage ? [refImage] : undefined,
            ...(def.category === "visual" && { visual: { ...visual, imageAssetId: visual.imageAssetId || null } }),
          };
      const r = await api<{ job: { id: string } }>(`${base}/content`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify(payload) });
      setJob(r.job.id);
    } catch (e) {
      const details = e instanceof ApiError && Array.isArray(e.details) ? ` (${(e.details as Array<{ path: string; message: string }>).map((d) => `${d.path}: ${d.message}`).join("; ")})` : "";
      setErr(e instanceof ApiError && e.code === "insufficient_credits" ? "Not enough credits." : `${(e as Error).message}${details}`);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Create <Link href={`/w/${workspaceId}/b/${brandId}/create`} className="ml-2 text-sm font-normal text-[var(--accent)] hover:underline">← guided wizards</Link></h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      {GROUPS.map((g) => (
        <section key={g.label}>
          <h2 className="mb-2 text-sm font-medium text-[var(--text-muted)]">{g.label}</h2>
          <div className="flex flex-wrap gap-2">
            {g.types.map((t) => (
              <button key={t} onClick={() => setType(t)} aria-pressed={type === t} className={cn("rounded-md border px-3 py-2 text-sm", type === t ? "border-[var(--accent)] bg-[var(--surface-2)] font-medium" : "border-[var(--border)]")}>{CONTENT_TYPE_DEFS[t].label}</button>
            ))}
          </div>
        </section>
      ))}
      <p className="text-sm text-[var(--text-muted)]">Making a video from your clips, photos and music? Use the <Link href={`/w/${workspaceId}/b/${brandId}/videos`} className="text-[var(--accent)] hover:underline">video editor</Link>.</p>

      <Card>
        <form onSubmit={generate} className="grid gap-4 sm:grid-cols-2">
          {def.category === "image" ? (<>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="font-medium">{type === "product_photo" ? "Describe the new setting" : "Describe the image"}</span>
              <textarea required className="min-h-20 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2" value={image.prompt} onChange={(e) => setImage({ ...image, prompt: e.target.value })} placeholder={type === "product_photo" ? "on a brass plate with banana leaves, festive Diwali table" : "steaming idli on a banana leaf, morning light"} />
            </label>
            {type === "product_photo" && (
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Product photo</span>
                <select required className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={image.productAssetId} onChange={(e) => setImage({ ...image, productAssetId: e.target.value })}>
                  <option value="">Choose from media…</option>{images.data?.data.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Size</span>
              <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={image.preset} onChange={(e) => setImage({ ...image, preset: e.target.value })}>{Object.entries(SIZE_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
            </label>
            {type === "image" && <label className="flex flex-col gap-1 text-sm"><span className="font-medium">How many</span><Input type="number" min={1} max={4} value={image.count} onChange={(e) => setImage({ ...image, count: Number(e.target.value) })} /></label>}
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Model</span>
              <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={image.modelKey} onChange={(e) => setImage({ ...image, modelKey: e.target.value })}>
                {models.map((m) => <option key={m.key} value={m.key}>{m.display_name} — {m.license}</option>)}
              </select>
            </label>
          </>) : (<>
            {text("topic", def.category === "visual" ? "What is the graphic about?" : "What is it about?", "e.g. our new lunch subscription for offices in Gachibowli", true)}
            {def.channels && def.channels.length > 1 && (
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Channel</span>
                <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={String(f.channel ?? "")} onChange={(e) => set("channel", e.target.value)}>{def.channels.map((c) => <option key={c}>{c}</option>)}</select>
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Language</span>
              <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={String(f.language)} onChange={(e) => set("language", e.target.value)}>{Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            {text("goal", "Goal (optional)", "e.g. 20 office sign-ups this month")}
            {text("cta", "Call to action (optional)", "e.g. Message us on WhatsApp")}
            {text("audience", "Audience (optional)")}
            {type === "social_post" && num("variants", "Variants", 1, 3, 1)}
            {type === "carousel" && num("slides", "Slides", 3, 10, 5)}
            {type === "x_thread" && num("posts", "Posts in the thread", 3, 15, 6)}
            {type === "blog" && (<>{text("keyword", "Primary keyword (optional)")}{num("words", "Length (words)", 300, 3000, 900)}</>)}
            {(type === "yt_script" || type === "short_video") && num("seconds", "Length (seconds)", 15, 1800, type === "short_video" ? 45 : 480)}
            {type === "ad" && (<>
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Objective</span>
                <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={String(f.objective ?? "traffic")} onChange={(e) => set("objective", e.target.value)}>{["awareness", "traffic", "leads", "sales"].map((o) => <option key={o}>{o}</option>)}</select>
              </label>
              {text("offer", "Offer (optional)")}
            </>)}
            {def.category === "visual" && (<>
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Size</span>
                <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={visual.preset} onChange={(e) => setVisual({ ...visual, preset: e.target.value })}>{presets.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
              </label>
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Layout</span>
                <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={visual.template} onChange={(e) => setVisual({ ...visual, template: e.target.value })}>{Object.entries(VISUAL_TEMPLATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              {(visual.template === "photo-overlay" || visual.template === "split-offer") && (
                <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Photo</span>
                  <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={visual.imageAssetId} onChange={(e) => setVisual({ ...visual, imageAssetId: e.target.value })}>
                    <option value="">Choose from media…</option>{images.data?.data.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                  </select>
                </label>
              )}
            </>)}
            {type === "caption" && (
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Image to caption</span>
                <select required className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={refImage} onChange={(e) => setRefImage(e.target.value)}>
                  <option value="">Choose from media…</option>{images.data?.data.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
              </label>
            )}
            {text("focus", "Anything else? (optional)", "tone, things to mention or avoid", true)}
            <details className="sm:col-span-2">
              <summary className="cursor-pointer text-sm font-medium">Sources & model</summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm"><span>Use only these knowledge sources (optional)</span>
                  <select multiple className="min-h-24 rounded-md border border-[var(--border)] bg-[var(--surface)] p-1" value={refs} onChange={(e) => setRefs([...e.target.selectedOptions].map((o) => o.value))}>
                    {sources.data?.data.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm"><span>Model quality</span>
                  <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={tier} onChange={(e) => setTier(e.target.value as never)}>
                    <option value="economy">Fast (½ credits)</option><option value="standard">Standard</option><option value="premium">Best (3× credits)</option>
                  </select>
                </label>
              </div>
            </details>
          </>)}
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={!!job}>Generate</Button>
            {cost && <span className="text-sm text-[var(--text-muted)]">≈ {cost.estimate} credits · up to {cost.max} held until it finishes</span>}
          </div>
          {err && <p className="text-sm text-[var(--danger)] sm:col-span-2">{err}</p>}
        </form>
      </Card>
      {job && <JobProgress workspaceId={workspaceId} jobId={job} label="Creating" onDone={(j) => {
        const out = j.output as { contentItemId?: string } | null;
        if (j.status === "succeeded" && out?.contentItemId) router.push(`/w/${workspaceId}/b/${brandId}/content/${out.contentItemId}`);
        else { setJob(undefined); setErr(j.error?.message ?? "Generation failed."); }
      }} />}
    </div>
  );
}
