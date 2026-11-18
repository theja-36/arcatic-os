"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { useApi } from "@/lib/use-api";
import { BrandTabs } from "@/components/BrandTabs";
import { JobProgress } from "@/components/plan/JobProgress";

type Idea = { keyword: string; avgMonthlySearches: number | null; competition?: string | null; intent?: string };
type Cluster = { label: string; keywords: string[]; volume: number | null; intent?: string };
type KeywordSet = { id: string; name: string; seeds: string[]; source: string; status: string; ideas: Idea[]; clusters: Cluster[]; error: string | null; created_at: string };
type Competitor = {
  id: string; name: string; url: string; status: string; error: string | null; analyzed_at: string | null;
  analysis: { positioning: string; audiences: string[]; topics: Array<{ topic: string; pageUrls: string[] }>; offers: string[]; claims: Array<{ text: string; url: string }>; gaps: Array<{ topic: string; why: string }>; pages: Array<{ url: string; title: string }> } | null;
};
type Account = { id: string; provider: string; account_ref: string; display_name: string | null };
const statusTone = (s: string) => (s === "ready" ? "success" : s === "failed" ? "danger" : "neutral");
const fmt = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-IN"));

export default function SeoPage() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const router = useRouter();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const sets = useApi<{ data: KeywordSet[] }>(`${base}/seo/keyword-sets`);
  const comps = useApi<{ data: Competitor[] }>(`${base}/seo/competitors`);
  const accounts = useApi<{ data: Account[] }>(`/workspaces/${workspaceId}/ads/accounts`);   // 403 for roles without ads.read → planner option hidden
  const googleAccounts = (accounts.data?.data ?? []).filter((a) => a.provider === "google_ads");
  const [job, setJob] = useState<{ id: string; label: string; after?: (output: unknown) => void }>();
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [openSet, setOpenSet] = useState<string>();
  const [openComp, setOpenComp] = useState<string>();

  // research form
  const [kName, setKName] = useState("");
  const [seeds, setSeeds] = useState("");
  const [seedUrl, setSeedUrl] = useState("");
  const [geo, setGeo] = useState("India");
  const [planner, setPlanner] = useState("");
  // competitor form
  const [cName, setCName] = useState("");
  const [cUrl, setCUrl] = useState("");
  // article form
  const [keyword, setKeyword] = useState("");
  const [secondary, setSecondary] = useState("");
  const [compIds, setCompIds] = useState<string[]>([]);
  const [words, setWords] = useState(1200);
  const [setId, setSetId] = useState<string | null>(null);

  useEffect(() => {
    const ch = supabase().channel(`seo:${brandId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "keyword_sets", filter: `brand_id=eq.${brandId}` }, () => void sets.reload())
      .on("postgres_changes", { event: "*", schema: "public", table: "competitors", filter: `brand_id=eq.${brandId}` }, () => void comps.reload())
      .subscribe();
    return () => void supabase().removeChannel(ch);
  }, [brandId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => setMsg({ err: true, text: e instanceof ApiError && e.code === "insufficient_credits" ? "Not enough credits." : (e as Error).message });

  async function research(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    try {
      const r = await api<{ id: string; job: { id: string } }>(`${base}/seo/keyword-sets`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({
        name: kName || seeds.split(",")[0]?.trim() || "Keyword research", seeds: seeds.split(",").map((s) => s.trim()).filter(Boolean), seedUrl: seedUrl || null, geo, connectionId: planner || null,
        ...(planner && geo.toLowerCase() === "india" && { locationIds: ["2356"] }),
      }) });
      setJob({ id: r.job.id, label: "Keyword research" }); setOpenSet(r.id); setKName(""); setSeeds(""); setSeedUrl("");
    } catch (err) { fail(err); }
  }
  async function addCompetitor(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    try {
      const c = await api<{ id: string }>(`${base}/seo/competitors`, { method: "POST", body: JSON.stringify({ name: cName, url: cUrl }) });
      setCName(""); setCUrl(""); await comps.reload(); void analyze(c.id);
    } catch (err) { fail(err); }
  }
  async function analyze(id: string) {
    setMsg(undefined);
    try {
      const r = await api<{ job: { id: string } }>(`${base}/seo/competitors/${id}/analyze`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: "{}" });
      setJob({ id: r.job.id, label: "Analysing competitor" }); setOpenComp(id);
    } catch (err) { fail(err); }
  }
  async function write(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    try {
      const r = await api<{ job: { id: string } }>(`${base}/seo/articles`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: JSON.stringify({
        keyword, secondary: secondary.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10), competitorIds: compIds, words, keywordSetId: setId,
      }) });
      setJob({ id: r.job.id, label: "Researching and writing", after: (out) => { const id = (out as { contentItemId?: string } | null)?.contentItemId; if (id) router.push(`/w/${workspaceId}/b/${brandId}/content/${id}`); } });
    } catch (err) { fail(err); }
  }
  const pickKeyword = (k: string, rest: string[], fromSet: string) => { setKeyword(k); setSecondary(rest.filter((x) => x !== k).slice(0, 5).join(", ")); setSetId(fromSet); document.getElementById("write")?.scrollIntoView({ behavior: "smooth" }); };

  const set = sets.data?.data.find((s) => s.id === openSet);
  const comp = comps.data?.data.find((c) => c.id === openComp);
  const readyComps = (comps.data?.data ?? []).filter((c) => c.status === "ready");

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">SEO & answer engines</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <p className="text-sm text-[var(--text-muted)]">Find what people search for, see what competitors cover, then write articles that answer the question directly, back their claims with your sources and link to your own pages. Search volumes come only from Google Keyword Planner (when a Google Ads account is connected); AI suggestions have no numbers.</p>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}
      {job && <JobProgress workspaceId={workspaceId} jobId={job.id} label={job.label} onDone={(j) => { const after = job.after; setJob(undefined); void sets.reload(); void comps.reload(); if (j.status === "succeeded") after?.(j.output); else setMsg({ err: true, text: j.error?.message ?? "It didn't finish." }); }} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <h2 className="font-semibold">Keyword research</h2>
          <form className="flex flex-col gap-2 text-sm" onSubmit={research}>
            <Input placeholder="Seed keywords, comma separated (e.g. tiffin service, office lunch)" value={seeds} onChange={(e) => setSeeds(e.target.value)} aria-label="Seed keywords" />
            <Input type="url" placeholder="…or a page URL to get ideas from (optional)" value={seedUrl} onChange={(e) => setSeedUrl(e.target.value)} aria-label="Seed URL" />
            <div className="flex flex-wrap gap-2">
              <Input className="w-40" placeholder="Name (optional)" value={kName} onChange={(e) => setKName(e.target.value)} aria-label="Name" />
              <Input className="w-32" value={geo} onChange={(e) => setGeo(e.target.value)} aria-label="Country or region" />
              <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2" value={planner} onChange={(e) => setPlanner(e.target.value)} aria-label="Source">
                <option value="">AI suggestions (no volumes)</option>
                {googleAccounts.map((a) => <option key={a.id} value={a.id}>Keyword Planner · {a.display_name ?? a.account_ref}</option>)}
              </select>
            </div>
            <div><Button type="submit" disabled={!!job || (!seeds.trim() && !seedUrl)}>Find keywords</Button> <span className="text-xs text-[var(--text-muted)]">2 credits</span></div>
          </form>
          <ul className="flex flex-col gap-1 text-sm">
            {sets.data?.data.map((s) => (
              <li key={s.id}><button className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-[var(--surface-2)]", openSet === s.id && "bg-[var(--surface-2)]")} onClick={() => setOpenSet(openSet === s.id ? undefined : s.id)}>
                <span className="flex-1 truncate">{s.name}</span><Badge>{s.source === "google_ads_keyword_planner" ? "Keyword Planner" : "AI"}</Badge><Badge tone={statusTone(s.status)}>{s.status}</Badge>
              </button></li>
            ))}
          </ul>
        </Card>

        <Card className="flex flex-col gap-3">
          <h2 className="font-semibold">Competitors</h2>
          <form className="flex flex-wrap gap-2 text-sm" onSubmit={addCompetitor}>
            <Input className="w-40" required placeholder="Name" value={cName} onChange={(e) => setCName(e.target.value)} aria-label="Competitor name" />
            <Input className="min-w-0 flex-1" required type="url" placeholder="https://competitor.example" value={cUrl} onChange={(e) => setCUrl(e.target.value)} aria-label="Competitor website" />
            <Button type="submit" variant="secondary" disabled={!!job}>Add & analyse</Button>
          </form>
          <p className="text-xs text-[var(--text-muted)]">Reads up to 6 public pages (home, pricing, products, blog…). 3 credits per analysis. Their claims are quoted word for word with the page they came from.</p>
          <ul className="flex flex-col gap-1 text-sm">
            {comps.data?.data.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <button className={cn("flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left hover:bg-[var(--surface-2)]", openComp === c.id && "bg-[var(--surface-2)]")} onClick={() => setOpenComp(openComp === c.id ? undefined : c.id)}>
                  <span className="truncate">{c.name}</span><span className="truncate text-xs text-[var(--text-muted)]">{c.url.replace(/^https?:\/\//, "")}</span>
                </button>
                <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                {c.status !== "analyzing" && <Button variant="ghost" className="h-7 px-2 text-xs" disabled={!!job} onClick={() => void analyze(c.id)}>{c.status === "ready" ? "Refresh" : "Analyse"}</Button>}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {set && (
        <Card className="flex flex-col gap-2">
          <h2 className="font-semibold">{set.name} <span className="text-sm font-normal text-[var(--text-muted)]">· {set.ideas.length} keywords in {set.clusters.length} topics</span></h2>
          {set.error && <p className="text-sm text-[var(--danger)]">{set.error}</p>}
          {set.source !== "google_ads_keyword_planner" && <p className="text-xs text-[var(--text-muted)]">AI suggestions: plausible queries, not measured demand. Connect Google Ads to see real monthly searches.</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-[var(--text-muted)]"><th className="py-1">Topic</th><th>Intent</th><th className="text-right">Monthly searches</th><th>Keywords</th><th /></tr></thead>
              <tbody>
                {set.clusters.slice(0, 40).map((c) => (
                  <tr key={c.label} className="border-t border-[var(--border)] align-top">
                    <td className="py-1 font-medium">{c.label}</td><td><Badge>{c.intent ?? "—"}</Badge></td><td className="text-right tabular-nums">{fmt(c.volume)}</td>
                    <td className="text-xs text-[var(--text-muted)]">{c.keywords.slice(0, 6).join(" · ")}{c.keywords.length > 6 ? ` +${c.keywords.length - 6}` : ""}</td>
                    <td><Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => pickKeyword(c.label, c.keywords, set.id)}>Write</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {comp?.analysis && (
        <Card className="flex flex-col gap-3 text-sm">
          <h2 className="font-semibold">{comp.name}</h2>
          <p>{comp.analysis.positioning}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div><h3 className="text-xs font-medium uppercase text-[var(--text-muted)]">Topics they cover</h3><ul className="mt-1 list-disc pl-5">{comp.analysis.topics.map((t) => <li key={t.topic}>{t.topic}</li>)}</ul></div>
            <div><h3 className="text-xs font-medium uppercase text-[var(--text-muted)]">Gaps you could own</h3><ul className="mt-1 list-disc pl-5">{comp.analysis.gaps.map((g) => <li key={g.topic}><button className="text-left text-[var(--accent)] hover:underline" onClick={() => { setKeyword(g.topic.toLowerCase()); setCompIds([comp.id]); document.getElementById("write")?.scrollIntoView({ behavior: "smooth" }); }}>{g.topic}</button> — <span className="text-[var(--text-muted)]">{g.why}</span></li>)}</ul></div>
            {comp.analysis.offers.length > 0 && <div><h3 className="text-xs font-medium uppercase text-[var(--text-muted)]">Offers</h3><ul className="mt-1 list-disc pl-5">{comp.analysis.offers.map((o) => <li key={o}>{o}</li>)}</ul></div>}
            {comp.analysis.claims.length > 0 && <div><h3 className="text-xs font-medium uppercase text-[var(--text-muted)]">Their claims (verbatim)</h3><ul className="mt-1 flex flex-col gap-1">{comp.analysis.claims.map((c) => <li key={c.text}>“{c.text}” <a className="text-xs text-[var(--accent)] hover:underline" href={c.url} target="_blank" rel="noreferrer">page</a></li>)}</ul></div>}
          </div>
          <p className="text-xs text-[var(--text-muted)]">Read {comp.analysis.pages.length} page(s){comp.analyzed_at ? ` · ${new Date(comp.analyzed_at).toLocaleString()}` : ""}.</p>
        </Card>
      )}

      <Card id="write" className="flex flex-col gap-3">
        <h2 className="font-semibold">Write a research-backed article</h2>
        <form className="flex flex-col gap-2 text-sm" onSubmit={write}>
          <Input required minLength={2} placeholder="Target keyword (e.g. tiffin service in pune)" value={keyword} onChange={(e) => { setKeyword(e.target.value); setSetId(null); }} aria-label="Target keyword" />
          <Input placeholder="Secondary keywords, comma separated" value={secondary} onChange={(e) => setSecondary(e.target.value)} aria-label="Secondary keywords" />
          {readyComps.length > 0 && (
            <fieldset className="flex flex-wrap gap-3"><legend className="mb-1 text-xs text-[var(--text-muted)]">Beat these competitors (uses their analysis)</legend>
              {readyComps.map((c) => <label key={c.id} className="flex items-center gap-1"><input type="checkbox" checked={compIds.includes(c.id)} onChange={(e) => setCompIds(e.target.checked ? [...compIds, c.id].slice(0, 5) : compIds.filter((x) => x !== c.id))} />{c.name}</label>)}
            </fieldset>
          )}
          <label className="flex items-center gap-2">Length <Input className="w-24" type="number" min={300} max={3000} step={100} value={words} onChange={(e) => setWords(Number(e.target.value))} aria-label="Words" /> words</label>
          <p className="text-xs text-[var(--text-muted)]">Builds a brief from your knowledge and competitor gaps, writes an answer-first article with question headings and an FAQ, then scores it. About 11 credits.</p>
          <div><Button type="submit" disabled={!!job || keyword.trim().length < 2}>Research & write</Button></div>
        </form>
        <p className="text-xs text-[var(--text-muted)]">Already have a draft? Open it in <Link className="text-[var(--accent)] hover:underline" href={`/w/${workspaceId}/b/${brandId}/content`}>Content</Link> and use the SEO panel.</p>
      </Card>
    </div>
  );
}
