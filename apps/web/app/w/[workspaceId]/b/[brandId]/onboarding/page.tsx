"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CHANNELS, GOALS, MATURITY, TONES, type OnboardingAnswers } from "@arcatic/core";
import { Button, Card, Input, cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { LANGUAGES } from "@/components/kit/fields";

const STEPS = [
  { id: "business", title: "Your business" },
  { id: "goals", title: "Goals & audience" },
  { id: "offers", title: "Offers & competitors" },
  { id: "voice", title: "Voice & language" },
  { id: "channels", title: "Channels" },
] as const;

const GOAL_LABEL: Record<string, string> = { awareness: "Get known", leads: "More enquiries", sales: "More sales", footfall: "More walk-ins", bookings: "More bookings", retention: "Repeat customers", launch: "Launch something new", community: "Build a community", hiring: "Hire people" };
const MATURITY_LABEL: Record<string, string> = { starting: "Just starting", occasional: "Post now and then", consistent: "Post regularly", advanced: "Run planned campaigns" };

function Chips<T extends string>({ options, value, onChange, labels, max }: { options: readonly T[]; value: T[] | undefined; onChange: (v: T[]) => void; labels?: Record<string, string>; max?: number }) {
  const v = value ?? [];
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = v.includes(o);
        return (
          <button type="button" key={o} aria-pressed={on}
            onClick={() => onChange(on ? v.filter((x) => x !== o) : max && v.length >= max ? v : [...v, o])}
            className={cn("rounded-full border px-3 py-1.5 text-sm", on ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] bg-[var(--surface)]")}>
            {labels?.[o] ?? o}
          </button>
        );
      })}
    </div>
  );
}

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-sm font-medium">{label}</span>
    {hint && <span className="text-xs text-[var(--text-muted)]">{hint}</span>}
    {children}
  </div>
);
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export default function Onboarding() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const router = useRouter();
  const base = `/workspaces/${workspaceId}/brands/${brandId}`;
  const [a, setA] = useState<OnboardingAnswers>({});
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [offersText, setOffersText] = useState("");
  const [competitorsText, setCompetitorsText] = useState("");
  const [bannedText, setBannedText] = useState("");

  useEffect(() => {
    api<{ answers: OnboardingAnswers; step: string }>(`${base}/onboarding`).then((r) => {
      setA(r.answers ?? {});
      const i = STEPS.findIndex((s) => s.id === r.step);
      if (i > 0) setStep(i);
      setOffersText((r.answers?.offers ?? []).map((o) => (o.price ? `${o.name} | ${o.price}` : o.name)).join("\n"));
      setCompetitorsText((r.answers?.competitors ?? []).map((c) => c.name).join("\n"));
      setBannedText((r.answers?.bannedWords ?? []).join("\n"));
    }).catch((e: Error) => setErr(e.message));
  }, [base]);

  const answers = (): OnboardingAnswers => ({
    ...a,
    offers: lines(offersText).map((l) => { const [name, price] = l.split("|").map((x) => x.trim()); return { name: name!, kind: "service" as const, ...(price && { price }) }; }),
    competitors: lines(competitorsText).map((name) => ({ name })),
    bannedWords: lines(bannedText),
  });

  async function save(next: number, complete = false) {
    setBusy(true);
    setErr("");
    try {
      await api(`${base}/onboarding`, { method: "PUT", body: JSON.stringify({ answers: answers(), step: STEPS[Math.min(next, STEPS.length - 1)]!.id, complete }) });
      if (complete) router.push(`/w/${workspaceId}/b/${brandId}/kit`);
      else setStep(next);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof OnboardingAnswers>(k: K, v: OnboardingAnswers[K]) => setA((x) => ({ ...x, [k]: v }));
  const langs = a.languages ?? { primary: "en", supported: ["en"] };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div>
        <p className="text-sm text-[var(--text-muted)]">Step {step + 1} of {STEPS.length}</p>
        <h1 className="text-xl font-semibold">{STEPS[step]!.title}</h1>
        <div className="mt-3 flex gap-1" aria-hidden>{STEPS.map((s, i) => <div key={s.id} className={cn("h-1 flex-1 rounded-full", i <= step ? "bg-[var(--accent)]" : "bg-[var(--surface-2)]")} />)}</div>
      </div>
      <Card className="flex flex-col gap-5">
        {step === 0 && (<>
          <Field label="Business name"><Input value={a.businessName ?? ""} onChange={(e) => set("businessName", e.target.value)} /></Field>
          <Field label="What kind of business is it?" hint="e.g. Cloud kitchen, dental clinic, interior design studio"><Input value={a.businessType ?? ""} onChange={(e) => set("businessType", e.target.value)} /></Field>
          <Field label="Describe it in one sentence" hint="Up to 200 characters becomes your one-line description."><textarea className="min-h-20 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" maxLength={600} value={a.description ?? ""} onChange={(e) => set("description", e.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location"><Input value={a.location ?? ""} onChange={(e) => set("location", e.target.value)} placeholder="Hyderabad" /></Field>
            <Field label="Website"><Input type="url" value={a.website ?? ""} onChange={(e) => set("website", e.target.value)} placeholder="https://" /></Field>
          </div>
        </>)}
        {step === 1 && (<>
          <Field label="What should marketing achieve?" hint="Pick up to 3."><Chips options={GOALS} value={a.goals} onChange={(v) => set("goals", v)} labels={GOAL_LABEL} max={3} /></Field>
          <Field label="Who are your customers?" hint="Who they are, what they need, what makes them hesitate.">
            <textarea className="min-h-24 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={a.audience?.description ?? ""} onChange={(e) => set("audience", { ...a.audience, description: e.target.value })} />
          </Field>
          <Field label="Where are they?"><Input value={a.audience?.geography ?? ""} onChange={(e) => set("audience", { description: a.audience?.description ?? "", geography: e.target.value })} placeholder="Gachibowli and Madhapur" /></Field>
        </>)}
        {step === 2 && (<>
          <Field label="What do you sell?" hint="One per line. Add a price after | if you want it used in posts: Breakfast tiffin | ₹1,499/month">
            <textarea className="min-h-28 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={offersText} onChange={(e) => setOffersText(e.target.value)} />
          </Field>
          <Field label="Competitors" hint="One per line (optional)."><textarea className="min-h-20 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={competitorsText} onChange={(e) => setCompetitorsText(e.target.value)} /></Field>
        </>)}
        {step === 3 && (<>
          <Field label="How should you sound?" hint="Pick up to 4."><Chips options={TONES} value={a.tone} onChange={(v) => set("tone", v)} max={4} /></Field>
          <Field label="Words you never want used" hint="One per line. Checked automatically on every draft."><textarea className="min-h-20 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={bannedText} onChange={(e) => setBannedText(e.target.value)} /></Field>
          <Field label="Languages for your content">
            <div className="flex flex-wrap gap-3">
              {Object.entries(LANGUAGES).map(([code, label]) => (
                <label key={code} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={langs.supported.includes(code)} onChange={(e) => {
                    const supported = e.target.checked ? [...new Set([...langs.supported, code])] : langs.supported.filter((x) => x !== code);
                    if (!supported.length) return;
                    set("languages", { primary: supported.includes(langs.primary) ? langs.primary : supported[0]!, supported });
                  }} />{label}
                </label>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm">Main language
              <select className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2" value={langs.primary} onChange={(e) => set("languages", { ...langs, primary: e.target.value })}>
                {langs.supported.map((c) => <option key={c} value={c}>{LANGUAGES[c] ?? c}</option>)}
              </select>
            </label>
          </Field>
        </>)}
        {step === 4 && (<>
          <Field label="Where do you want to show up?"><Chips options={CHANNELS} value={a.channels} onChange={(v) => set("channels", v)} /></Field>
          <Field label="How much marketing do you do today?"><Chips options={MATURITY} value={a.maturity ? [a.maturity] : []} onChange={(v) => set("maturity", v.at(-1))} labels={MATURITY_LABEL} /></Field>
          <p className="text-sm text-[var(--text-muted)]">Finishing creates a Brand Kit draft from your answers. Next you can analyse your website to fill in the rest, with sources for every suggestion.</p>
        </>)}
        {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
        <div className="flex justify-between">
          <Button variant="ghost" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>Back</Button>
          {step < STEPS.length - 1
            ? <Button disabled={busy} onClick={() => save(step + 1)}>{busy ? "Saving…" : "Continue"}</Button>
            : <Button disabled={busy} onClick={() => save(step, true)}>{busy ? "Saving…" : "Create Brand Kit"}</Button>}
        </div>
      </Card>
    </div>
  );
}
