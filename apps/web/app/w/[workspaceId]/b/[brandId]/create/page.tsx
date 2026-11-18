"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { WIZARDS, type WizardGroup } from "@arcatic/core";
import { Card } from "@arcatic/ui";
import { BrandTabs } from "@/components/BrandTabs";

const ORDER: WizardGroup[] = ["Ideas", "Social", "Long-form", "Sales & web", "Visual", "Video", "Documents", "Repurpose"];

function Hub() {
  const { workspaceId, brandId } = useParams<{ workspaceId: string; brandId: string }>();
  const project = useSearchParams().get("project");
  const b = `/w/${workspaceId}/b/${brandId}`;
  const q = project ? `?project=${project}` : "";
  const href = (id: string) => {
    const w = WIZARDS.find((x) => x.id === id)!;
    if (w.href === "repurpose") return `${b}/repurpose${q}`;
    if (!w.steps.length) return `${b}/create/classic?type=${w.type}`;
    return `${b}/create/${w.id}${q}`;
  };
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Create</h1>
        <div className="mt-3"><BrandTabs workspaceId={workspaceId} brandId={brandId} /></div>
      </div>
      <p className="text-sm text-[var(--text-muted)]">
        Pick what you want to make; each guide asks a few questions and writes a first draft in your brand voice, citing your Knowledge.
        {project && " New drafts will be filed in the selected project."} Prefer one form for everything? <Link className="text-[var(--accent)] hover:underline" href={`${b}/create/classic`}>Use the quick form</Link>.
      </p>
      {ORDER.map((g) => {
        const list = WIZARDS.filter((w) => w.group === g);
        if (!list.length) return null;
        return (
          <section key={g} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-[var(--text-muted)]">{g}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((w) => (
                <Link key={w.id} href={href(w.id)} className="group">
                  <Card className="flex h-full flex-col gap-1 p-4 transition group-hover:border-[var(--accent)]">
                    <span className="font-medium">{w.label}</span>
                    <span className="text-sm text-[var(--text-muted)]">{w.description}</span>
                  </Card>
                </Link>
              ))}
              {g === "Video" && (
                <Link href={`${b}/videos`} className="group">
                  <Card className="flex h-full flex-col gap-1 p-4 transition group-hover:border-[var(--accent)]">
                    <span className="font-medium">Video editor</span>
                    <span className="text-sm text-[var(--text-muted)]">Combine clips, photos, text and music into a branded video for each platform.</span>
                  </Card>
                </Link>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default function CreatePage() {
  return <Suspense><Hub /></Suspense>;
}
