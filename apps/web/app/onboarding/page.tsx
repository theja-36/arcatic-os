"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@arcatic/ui";
import { api, ApiError } from "@/lib/api";

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

export default function Onboarding() {
  const router = useRouter();
  const [org, setOrg] = useState("");
  const [ws, setWs] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ workspaceId: string }>("/organizations", {
        method: "POST",
        body: JSON.stringify({ organizationName: org, workspaceName: ws || org, workspaceSlug: slug || slugify(ws || org) }),
      });
      router.replace(`/w/${r.workspaceId}`);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "conflict" ? "That workspace address is taken." : (err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
      <h1 className="text-2xl font-semibold">Set up your workspace</h1>
      <p className="mb-6 mt-1 text-sm text-[var(--text-muted)]">A workspace holds your brands, team, connected channels and credits. Agencies can add more later.</p>
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="org">Business or agency name</label>
            <Input id="org" required value={org} onChange={(e) => { setOrg(e.target.value); if (!slugTouched) setSlug(slugify(ws || e.target.value)); }} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="ws">Workspace name <span className="text-[var(--text-muted)]">(optional)</span></label>
            <Input id="ws" value={ws} placeholder={org || "Marketing"} onChange={(e) => { setWs(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value || org)); }} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="slug">Workspace address</label>
            <Input id="slug" required pattern="[a-z0-9][a-z0-9-]{1,46}[a-z0-9]" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
          </div>
          <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create workspace"}</Button>
          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
          <p className="text-xs text-[var(--text-muted)]">Includes a 100-credit trial.</p>
        </form>
      </Card>
    </main>
  );
}
