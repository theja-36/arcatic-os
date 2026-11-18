"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CONTENT_TYPE_DEFS, LANGUAGES, TONE_OPTIONS, docText, type ContentDoc, type Scene } from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { useSignedUrl } from "@/lib/media";
import { BrandTabs } from "@/components/BrandTabs";
import { JobProgress } from "@/components/plan/JobProgress";
import { BlockEditor } from "@/components/content/BlockEditor";
import { Checklist } from "@/components/content/Checklist";
import { VisualEditor } from "@/components/content/VisualEditor";
import { PublishPanel } from "@/components/publish/PublishPanel";
import { Feedback } from "@/components/content/Feedback";
import { IdeasPanel } from "@/components/content/IdeasPanel";
import { SeoPanel } from "@/components/content/SeoPanel";
import type { Item, Version } from "@/components/content/types";

const statusTone = (s: string) => (s === "approved" ? "success" : s === "in_review" ? "accent" : s === "changes_requested" || s === "failed" ? "danger" : "neutral");

function VideoAttachment({ workspaceId, brandId, video }: { workspaceId: string; brandId: string; video: { assetId: string; projectId: string } }) {
  const url = useSignedUrl(workspaceId, video.assetId);
  return (
    <div className="flex flex-col gap-2">
      {url ? <video src={url} controls preload="metadata" className="max-h-96 w-full rounded-md bg-black" /> : <div className="h-48 rounded-md bg-[var(--surface-2)]" />}
      <Link href={`/w/${workspaceId}/b/${brandId}/videos/${video.projectId}`} className="text-xs text-[var(--accent)] hover:underline">Edit in the video editor (then send again)</Link>
    </div>
  );
}

function ProjectSelect({ workspaceId, brandId, contentId, value, onChanged }: { workspaceId: string; brandId: string; contentId: string; value: string | null; onChanged: () => void }) {
  const projects = useApi<{ data: Array<{ id: string; name: string }> }>(`/workspaces/${workspaceId}/brands/${brandId}/projects`);
  if (!projects.data?.data.length && !value) return null;
  return (
    <label className="flex items-center gap-2 text-sm"><span className="text-[var(--text-muted)]">Project</span>
      <select className="h-8 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={value ?? ""}
        onChange={(e) => void api(`/workspaces/${workspaceId}/brands/${brandId}/content/${contentId}/project`, { method: "PUT", body: JSON.stringify({ projectId: e.target.value || null }) }).then(onChanged)}>
        <option value="">None</option>{projects.data?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
  );
}

function GeneratedImages({ workspaceId, ids }: { workspaceId: string; ids: string[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    ids.forEach((id) => api<{ url: string }>(`/workspaces/${workspaceId}/media/${id}/url`).then((r) => setUrls((u) => ({ ...u, [id]: r.url }))).catch(() => undefined));
  }, [workspaceId, ids]);
  return <div className="grid grid-cols-2 gap-2">{ids.map((id) => (urls[id] ? <img key={id} src={urls[id]} alt="Generated" className="w-full rounded-md" /> : <div key={id} className="aspect-square rounded-md bg-[var(--surface-2)]" />))}</div>;
}

/** Long-form types that get the SEO / answer-engine panel. */
const SEO_TYPES = new Set(["blog", "landing_page", "case_study", "press_release", "newsletter", "document", "product_copy"]);

export default function Editor() {
  const { workspaceId, brandId, contentId } = useParams<{ workspaceId: string; brandId: string; contentId: string }>();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const { data, reload, error } = useApi<Item>(`${base}/content/${contentId}`);
  const versions = useApi<{ data: Version[] }>(`${base}/content/${contentId}/versions`);
  const ws = useApi<{ role: string }>(`/workspaces/${workspaceId}`);
  const role = ws.data?.role ?? "";
  const canEdit = ["owner", "admin", "editor", "contributor"].includes(role);
  const canDecide = ["owner", "admin", "editor", "reviewer"].includes(role);
  const [doc, setDoc] = useState<ContentDoc>();
  const [scene, setScene] = useState<Scene>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState("");
  const [instruction, setInstruction] = useState("");
  const [tone, setTone] = useState<string>(TONE_OPTIONS[0]);
  const [lang, setLang] = useState("te");
  const [comment, setComment] = useState("");
  const [job, setJob] = useState<{ id: string; label: string }>();
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();

  const v = data?.version;
  useEffect(() => { setDoc(v?.body?.doc); setScene(v?.body?.scene); setSelected(new Set()); }, [v?.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ch = supabase().channel(`content:${contentId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "content_items", filter: `id=eq.${contentId}` }, () => { void reload(); void versions.reload(); })
      .subscribe();
    return () => void supabase().removeChannel(ch);
  }, [contentId]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="text-sm text-[var(--danger)]">{error}</p>;
  if (!data) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  const def = CONTENT_TYPE_DEFS[data.type as keyof typeof CONTENT_TYPE_DEFS];
  const editable = canEdit && data.editable && !job;
  const dirty = !!v?.body && (JSON.stringify(doc) !== JSON.stringify(v.body.doc) || JSON.stringify(scene) !== JSON.stringify(v.body.scene));
  const pending = data.approvals.find((a) => a.status === "pending");
  const isImage = def?.category === "image";

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(undefined);
    try {
      await fn();
      if (ok) setMsg({ text: ok });
      await reload();
      await versions.reload();
    } catch (e) {
      setMsg({ err: true, text: e instanceof ApiError && e.code === "conflict" ? e.message : (e as Error).message });
    }
  };
  const save = (sceneOverride?: Scene) => run(() => api(`${base}/content/${contentId}/versions`, { method: "POST", body: JSON.stringify({ baseVersion: v!.version, doc, scene: sceneOverride ?? scene }) }), "Saved as a new version.");
  const startJob = async (path: string, payload: unknown, label: string) => {
    setMsg(undefined);
    try {
      const r = await api<{ job: { id: string } }>(`${base}/content/${contentId}/${path}`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify(payload) });
      setJob({ id: r.job.id, label });
    } catch (e) {
      setMsg({ err: true, text: (e as Error).message });
    }
  };
  const blockIds = selected.size ? [...selected] : undefined;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm text-[var(--text-muted)]"><Link className="hover:underline" href={`/w/${workspaceId}/b/${brandId}/content`}>Content</Link> /</p>
        <h1 className="text-xl font-semibold">{data.title ?? "Untitled"}</h1>
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge>{def?.label ?? data.type}</Badge>{data.channel && <Badge>{data.channel}</Badge>}<Badge>{LANGUAGES[data.language as keyof typeof LANGUAGES] ?? data.language}</Badge>
          <Badge tone={statusTone(data.status)}>{data.status.replace("_", " ")}</Badge>{v && <Badge>v{v.version}</Badge>}
          {data.source_item_id && !data.source_ref && <Link href={`/w/${workspaceId}/b/${brandId}/content/${data.source_item_id}`}><Badge tone="accent">translation of original</Badge></Link>}
          {data.source_ref && (data.source_ref.kind === "content"
            ? <Link href={`/w/${workspaceId}/b/${brandId}/content/${data.source_ref.id}`}><Badge tone="accent">made from “{data.source_ref.title}”</Badge></Link>
            : <Link href={`/w/${workspaceId}/b/${brandId}/knowledge?source=${data.source_ref.id}`}><Badge tone="accent">made from “{data.source_ref.title}”</Badge></Link>)}
          {data.translations.map((t) => <Link key={t.id} href={`/w/${workspaceId}/b/${brandId}/content/${t.id}`}><Badge tone="accent">{t.language} version</Badge></Link>)}
        </div>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>

      {job && <JobProgress workspaceId={workspaceId} jobId={job.id} label={job.label} onDone={(j) => {
        setJob(undefined);
        const out = j.output as { contentItemId?: string } | null;
        if (j.status === "succeeded" && out?.contentItemId && out.contentItemId !== contentId) setMsg({ text: "Translation created — open it from the badges above." });
        else if (j.status !== "succeeded") setMsg({ err: true, text: j.error?.message ?? "Failed; credits were released." });
        void reload(); void versions.reload();
      }} />}
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-4">
          {scene && <Card><VisualEditor scene={scene} workspaceId={workspaceId} brandId={brandId} readOnly={!editable} onChange={setScene} onExported={(id) => { const s = { ...scene, exportAssetId: id }; setScene(s); void save(s); }} /></Card>}
          {v?.body?.video && <Card><VideoAttachment workspaceId={workspaceId} brandId={brandId} video={v.body.video} /></Card>}
          {isImage && v?.body?.images && <Card><GeneratedImages workspaceId={workspaceId} ids={v.body.images} /></Card>}
          {doc && !isImage && <BlockEditor doc={doc} onChange={setDoc} issues={v?.validation_report?.issues ?? []} selected={selected} onSelect={setSelected} readOnly={!editable} />}
          {editable && dirty && (
            <div className="sticky bottom-4 z-10 flex items-center justify-end gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-lg">
              <span className="mr-auto text-sm">Unsaved changes</span>
              <Button variant="ghost" onClick={() => { setDoc(v?.body?.doc); setScene(v?.body?.scene); }}>Discard</Button>
              <Button onClick={() => save()}>Save version</Button>
            </div>
          )}
          {v?.body?.variants?.length ? (
            <Card className="flex flex-col gap-3">
              <h3 className="font-semibold">Other versions the AI wrote</h3>
              {v.body.variants.map((d, i) => (
                <div key={i} className="rounded-md bg-[var(--surface-2)] p-3 text-sm">
                  <p className="whitespace-pre-wrap">{docText(d)}</p>
                  {editable && <Button variant="ghost" className="mt-2 h-7 px-2 text-xs" onClick={() => run(() => api(`${base}/content/${contentId}/variants/${i}/use`, { method: "POST" }), "Switched to that version.")}>Use this one</Button>}
                </div>
              ))}
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <Checklist report={v?.validation_report ?? null} dirty={dirty} />
          {data.type === "brainstorm" && doc && canEdit && <IdeasPanel workspaceId={workspaceId} brandId={brandId} contentId={contentId} doc={doc} />}
          {SEO_TYPES.has(data.type) && <SeoPanel base={base} contentId={contentId} doc={doc} editable={editable} dirty={dirty} onDocChange={setDoc} />}
          {canEdit && <ProjectSelect workspaceId={workspaceId} brandId={brandId} contentId={contentId} value={data.project_id ?? null} onChanged={() => void reload()} />}

          {canEdit && data.editable && !isImage && v && (
            <Card className="flex flex-col gap-3">
              <h3 className="font-semibold">AI tools</h3>
              <p className="text-xs text-[var(--text-muted)]">{selected.size ? `Applies to ${selected.size} selected block(s).` : "Applies to all blocks you haven't locked."} Your edits are kept when regenerating.</p>
              <div className="flex gap-2">
                <Input placeholder="Direction, e.g. more festive" value={focus} onChange={(e) => setFocus(e.target.value)} aria-label="Regeneration focus" />
                <Button variant="secondary" disabled={!!job || dirty} onClick={() => startJob("regenerate", { focus: focus || undefined, blockIds }, "Regenerating")}>Regenerate</Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {(["improve", "simplify", "shorten", "expand", "fix_grammar"] as const).map((t) => (
                  <Button key={t} variant="ghost" className="h-8 px-2 text-xs" disabled={!!job || dirty} onClick={() => startJob("transform", { transform: t, blockIds }, t.replace("_", " "))}>{t.replace("_", " ")}</Button>
                ))}
              </div>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (instruction.trim()) void startJob("transform", { transform: "rewrite", instruction: instruction.trim(), blockIds }, "Editing").then(() => setInstruction("")); }}>
                <Input placeholder="Ask AI to edit, e.g. add a section on delivery areas" value={instruction} maxLength={500} onChange={(e) => setInstruction(e.target.value)} aria-label="Edit instruction" />
                <Button type="submit" variant="secondary" disabled={!!job || dirty || !instruction.trim()}>Apply</Button>
              </form>
              <div className="flex gap-2">
                <select className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={tone} onChange={(e) => setTone(e.target.value)} aria-label="Tone">{TONE_OPTIONS.map((t) => <option key={t}>{t}</option>)}</select>
                <Button variant="ghost" className="h-8 px-2 text-xs" disabled={!!job || dirty} onClick={() => startJob("transform", { transform: "tone", tone, blockIds }, "Changing tone")}>Change tone</Button>
              </div>
              <div className="flex gap-2">
                <select className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Translate to">{Object.entries(LANGUAGES).filter(([k]) => k !== data.language).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
                <Button variant="ghost" className="h-8 px-2 text-xs" disabled={!!job} onClick={() => startJob("translate", { targetLanguage: lang }, "Translating")}>Translate</Button>
              </div>
              {dirty && <p className="text-xs text-[var(--warning)]">Save your edits before using AI tools.</p>}
            </Card>
          )}

          <Card className="flex flex-col gap-2">
            <h3 className="font-semibold">Approval</h3>
            {pending ? (
              canDecide ? (
                <>
                  <textarea className="min-h-16 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" placeholder="Comment (required to request changes)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Review comment" />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => run(() => api(`${base}/approvals/${pending.id}/decide`, { method: "POST", body: JSON.stringify({ decision: "approved", comment: comment || undefined }) }), "Approved.")}>Approve</Button>
                    <Button variant="secondary" onClick={() => run(() => api(`${base}/approvals/${pending.id}/decide`, { method: "POST", body: JSON.stringify({ decision: "changes_requested", comment }) }), "Changes requested.")}>Request changes</Button>
                    <Button variant="ghost" onClick={() => run(() => api(`${base}/approvals/${pending.id}/decide`, { method: "POST", body: JSON.stringify({ decision: "rejected", comment }) }), "Rejected.")}>Reject</Button>
                  </div>
                </>
              ) : <p className="text-sm text-[var(--text-muted)]">Waiting for review.</p>
            ) : data.status === "approved" ? <p className="text-sm text-[var(--success)]">Approved. Any new edit sends it back to draft.</p>
              : canEdit && v ? (
                <>
                  <Button disabled={dirty || !v.validation_report?.passed} onClick={() => run(() => api(`${base}/content/${contentId}/submit`, { method: "POST", body: "{}" }), "Submitted for review.")}>Submit for approval</Button>
                  {!v.validation_report?.passed && <p className="text-xs text-[var(--text-muted)]">Fix the checklist errors first.</p>}
                </>
              ) : null}
            {data.approvals.filter((a) => a.status !== "pending").slice(0, 3).map((a) => (
              <p key={a.id} className="text-xs text-[var(--text-muted)]">{a.status.replace("_", " ")}{a.comment ? `: “${a.comment}”` : ""} · {a.decided_at ? new Date(a.decided_at).toLocaleString() : ""}</p>
            ))}
          </Card>

          <PublishPanel workspaceId={workspaceId} brandId={brandId} contentId={contentId} contentType={data.type} title={data.title} canPublish={["owner", "admin", "editor"].includes(role)} />

          {v?.origin === "ai" || v?.model ? <Feedback workspaceId={workspaceId} brandId={brandId} contentId={contentId} /> : null}

          <Card className="flex flex-col gap-2">
            <h3 className="font-semibold">History</h3>
            <ul className="max-h-64 space-y-1 overflow-auto text-sm">
              {versions.data?.data.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-2">
                  <span>v{x.version} · {x.origin === "human" ? "you" : x.transform ? x.transform.replace(/[:@]/g, " ") : "AI"}{x.validation_report && !x.validation_report.passed ? " · needs fixes" : ""}</span>
                  {editable && x.version !== v?.version && <button className="text-xs text-[var(--accent)] hover:underline" onClick={() => run(() => api(`${base}/content/${contentId}/restore/${x.version}`, { method: "POST" }), `Restored v${x.version}.`)}>Restore</button>}
                </li>
              ))}
            </ul>
          </Card>

          {v && (
            <details className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
              <summary className="cursor-pointer font-semibold">How this was made</summary>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-[var(--text-muted)]">Model</dt><dd>{v.model ?? "—"}</dd>
                <dt className="text-[var(--text-muted)]">Template</dt><dd>{v.prompt_template ?? "—"}</dd>
                <dt className="text-[var(--text-muted)]">Brand Kit</dt><dd>{v.brand_context_version ? `v${v.brand_context_version}` : "—"}</dd>
                <dt className="text-[var(--text-muted)]">Knowledge cited</dt><dd>{v.source_chunk_ids?.length ?? 0} passage(s)</dd>
                <dt className="text-[var(--text-muted)]">Credits</dt><dd>{v.credits_cost ?? 0}</dd>
              </dl>
              {v.prompt && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-2)] p-2 text-[11px]">{v.prompt}</pre>}
            </details>
          )}
          {canEdit && <Button variant="ghost" onClick={() => run(() => api(`${base}/content/${contentId}/${data.status === "archived" ? "unarchive" : "archive"}`, { method: "POST" }), data.status === "archived" ? "Restored." : "Archived.")}>{data.status === "archived" ? "Restore from archive" : "Archive"}</Button>}
        </div>
      </div>
    </div>
  );
}
