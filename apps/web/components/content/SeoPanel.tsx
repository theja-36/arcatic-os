"use client";
import { useEffect, useState } from "react";
import { applyLink, type ContentDoc } from "@arcatic/core";
import { Badge, Button, Card, Input, cn } from "@arcatic/ui";
import { api } from "@/lib/api";

type Check = { id: string; group: "seo" | "aeo"; label: string; status: "pass" | "warn" | "fail"; detail: string; blockId?: string };
type Claim = { blockId: string; text: string; kinds: string[]; status: "supported" | "partial" | "unsupported"; risk: "low" | "medium" | "high"; evidence: Array<{ id: string; kind: string; url?: string | null; snippet: string }> };
type Link = { blockId: string; anchor: string; url: string; title: string; reason: string };
type Report = {
  scores: { overall: number; seo: { score: number; checks: Check[] }; aeo: { score: number; checks: Check[] }; claims: { score: number; supported: number; partial: number; unsupported: number; highRisk: number }; evidenceCount: number };
  claims: Claim[]; links: Link[]; schema_jsonld?: unknown; schemaJsonld?: unknown; content_version_id?: string; versionId?: string;
};
type Settings = { primary?: string | null; secondary?: string[]; question?: string | null; canonicalUrl?: string | null };

const toneFor = (n: number) => (n >= 75 ? "success" : n >= 50 ? "warning" : "danger");
const STATUS = { pass: "✓", warn: "!", fail: "✕" } as const;

/**
 * SEO / answer-engine readiness for long-form content: target keywords, deterministic checks,
 * source-backed claims and internal-link suggestions. Adding a link edits the draft; saving
 * creates a new version as usual.
 */
export function SeoPanel({ base, contentId, doc, editable, dirty, onDocChange }: { base: string; contentId: string; doc: ContentDoc | undefined; editable: boolean; dirty: boolean; onDocChange: (d: ContentDoc) => void }) {
  const [settings, setSettings] = useState<Settings>({});
  const [secondary, setSecondary] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ err?: boolean; text: string }>();
  const [tab, setTab] = useState<"checks" | "claims" | "links" | "schema">("checks");

  const load = async () => {
    const r = await api<{ settings: Settings; report: Report | null; stale: boolean }>(`${base}/content/${contentId}/seo`);
    setSettings(r.settings); setSecondary((r.settings.secondary ?? []).join(", ")); setReport(r.report); setStale(r.stale);
  };
  useEffect(() => { void load().catch(() => undefined); }, [contentId]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function saveSettings() {
    setBusy(true); setMsg(undefined);
    try {
      const body = { ...settings, primary: settings.primary?.trim() || null, question: settings.question?.trim() || null, canonicalUrl: settings.canonicalUrl?.trim() || null, secondary: secondary.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12) };
      await api(`${base}/content/${contentId}/seo`, { method: "PUT", body: JSON.stringify(body) });
      setMsg({ text: "Saved. Analyse again to update the score." });
    } catch (e) { setMsg({ err: true, text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function analyze() {
    setBusy(true); setMsg(undefined);
    try {
      const r = await api<Report>(`${base}/content/${contentId}/seo/analyze`, { method: "POST", body: "{}" });
      setReport(r); setStale(false);
    } catch (e) { setMsg({ err: true, text: (e as Error).message }); } finally { setBusy(false); }
  }
  function addLink(l: Link) {
    if (!doc) return;
    onDocChange(applyLink(doc, l));
    setReport((r) => (r ? { ...r, links: r.links.filter((x) => x.url !== l.url) } : r));
    setMsg({ text: `Linked “${l.anchor}”. Save to keep it.` });
  }

  const s = report?.scores;
  const checks = s ? [...s.seo.checks, ...s.aeo.checks].sort((a, b) => ({ fail: 0, warn: 1, pass: 2 }[a.status] - { fail: 0, warn: 1, pass: 2 }[b.status])) : [];
  const jsonld = report?.schemaJsonld ?? report?.schema_jsonld;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">SEO & answer readiness</h2>
        {s && <Badge tone={toneFor(s.overall)}>{s.overall}/100</Badge>}
        {stale && <span className="text-xs text-[var(--text-muted)]">not analysed for this version</span>}
      </div>
      <div className="grid gap-2 text-sm">
        <label className="flex flex-col gap-1">Target keyword<Input value={settings.primary ?? ""} onChange={(e) => setSettings({ ...settings, primary: e.target.value })} disabled={!editable} placeholder="e.g. tiffin service in pune" /></label>
        <label className="flex flex-col gap-1">Secondary keywords<Input value={secondary} onChange={(e) => setSecondary(e.target.value)} disabled={!editable} placeholder="comma separated" /></label>
        <label className="flex flex-col gap-1">Question it answers<Input value={settings.question ?? ""} onChange={(e) => setSettings({ ...settings, question: e.target.value })} disabled={!editable} placeholder="What does a tiffin service cost?" /></label>
        <label className="flex flex-col gap-1">Canonical URL (once published)<Input type="url" value={settings.canonicalUrl ?? ""} onChange={(e) => setSettings({ ...settings, canonicalUrl: e.target.value })} disabled={!editable} /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        {editable && <Button variant="secondary" disabled={busy} onClick={() => void saveSettings()}>Save targets</Button>}
        <Button disabled={busy || dirty} onClick={() => void analyze()} title={dirty ? "Save your edits first" : undefined}>Analyse</Button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">Checks are writing guidelines, not a ranking guarantee. Free; no credits.</p>
      {msg && <p className={cn("text-sm", msg.err ? "text-[var(--danger)]" : "text-[var(--success)]")} role="status">{msg.text}</p>}

      {s && (
        <>
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded border border-[var(--border)] p-2"><div className="text-xs text-[var(--text-muted)]">Search</div><div className="font-semibold">{s.seo.score}</div></div>
            <div className="rounded border border-[var(--border)] p-2"><div className="text-xs text-[var(--text-muted)]">Answer engines</div><div className="font-semibold">{s.aeo.score}</div></div>
            <div className="rounded border border-[var(--border)] p-2"><div className="text-xs text-[var(--text-muted)]">Claims backed</div><div className="font-semibold">{s.claims.score}</div></div>
          </div>
          <div role="tablist" className="flex gap-3 border-b border-[var(--border)] text-sm">
            {(["checks", "claims", "links", "schema"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={cn("-mb-px border-b-2 pb-1", tab === t ? "border-[var(--accent)] font-medium" : "border-transparent text-[var(--text-muted)]")} onClick={() => setTab(t)}>
                {t === "checks" ? "Checks" : t === "claims" ? `Claims (${report!.claims.length})` : t === "links" ? `Links (${report!.links.length})` : "Structured data"}
              </button>
            ))}
          </div>
          {tab === "checks" && (
            <ul className="flex flex-col gap-1 text-sm">
              {checks.map((c) => (
                <li key={c.id} className="flex gap-2">
                  <span aria-label={c.status} className={cn("w-4 shrink-0 text-center font-bold", c.status === "pass" ? "text-[var(--success)]" : c.status === "warn" ? "text-[var(--warning)]" : "text-[var(--danger)]")}>{STATUS[c.status]}</span>
                  <span><span className="font-medium">{c.label}</span> <Badge>{c.group === "aeo" ? "answer" : "search"}</Badge><br /><span className="text-xs text-[var(--text-muted)]">{c.detail}</span></span>
                </li>
              ))}
            </ul>
          )}
          {tab === "claims" && (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-xs text-[var(--text-muted)]">Figures, superlatives, guarantees and “studies show” sentences, matched against the knowledge this draft was written from and your Brand Kit. “No evidence found” means nothing here backs it — check it or remove it.</p>
              {report!.claims.length === 0 && <p className="text-[var(--text-muted)]">No checkable claims found.</p>}
              {report!.claims.map((c, i) => (
                <div key={i} className="rounded border border-[var(--border)] p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={c.status === "supported" ? "success" : c.status === "partial" ? "warning" : "danger"}>{c.status === "unsupported" ? "no evidence found" : c.status}</Badge>
                    {c.risk === "high" && <Badge tone="danger">high risk</Badge>}
                    <span className="text-xs text-[var(--text-muted)]">{c.kinds.join(", ")}</span>
                  </div>
                  <p className="mt-1">{c.text}</p>
                  {c.evidence.slice(0, 2).map((e) => (
                    <p key={e.id} className="mt-1 border-l-2 border-[var(--border)] pl-2 text-xs text-[var(--text-muted)]">
                      “{e.snippet}” {e.url && <a className="text-[var(--accent)] hover:underline" href={e.url} target="_blank" rel="noreferrer">source</a>}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
          {tab === "links" && (
            <div className="flex flex-col gap-2 text-sm">
              {report!.links.length === 0 && <p className="text-[var(--text-muted)]">No suggestions. Add your website in the Brand Kit and publish or import more pages to get internal-link ideas.</p>}
              {report!.links.map((l) => (
                <div key={l.url} className="flex items-start gap-2 rounded border border-[var(--border)] p-2">
                  <div className="min-w-0 flex-1">
                    <p>Link “<span className="font-medium">{l.anchor}</span>” → <a className="text-[var(--accent)] hover:underline" href={l.url} target="_blank" rel="noreferrer">{l.title}</a></p>
                    <p className="text-xs text-[var(--text-muted)]">{l.reason}</p>
                  </div>
                  {editable && <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => addLink(l)}>Add link</Button>}
                </div>
              ))}
            </div>
          )}
          {tab === "schema" && (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-xs text-[var(--text-muted)]">schema.org JSON-LD (Article, plus FAQPage when the article has question headings with answers). Paste into your page’s &lt;head&gt; if your CMS doesn’t add it.</p>
              <pre className="max-h-64 overflow-auto rounded bg-[var(--surface-2)] p-2 text-xs">{JSON.stringify(jsonld, null, 2)}</pre>
              <Button variant="ghost" className="self-start" onClick={() => void navigator.clipboard.writeText(`<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`)}>Copy</Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
