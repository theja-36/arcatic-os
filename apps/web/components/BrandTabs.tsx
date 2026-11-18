"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@arcatic/ui";

export function BrandTabs({ workspaceId, brandId }: { workspaceId: string; brandId: string }) {
  const path = usePathname();
  const tabs = [
    { href: `/w/${workspaceId}/b/${brandId}/kit`, label: "Brand Kit" },
    { href: `/w/${workspaceId}/b/${brandId}/knowledge`, label: "Knowledge" },
    { href: `/w/${workspaceId}/b/${brandId}/strategy`, label: "Strategy" },
    { href: `/w/${workspaceId}/b/${brandId}/campaigns`, label: "Campaigns" },
    { href: `/w/${workspaceId}/b/${brandId}/planner`, label: "Planner" },
    { href: `/w/${workspaceId}/b/${brandId}/calendar`, label: "Calendar" },
    { href: `/w/${workspaceId}/b/${brandId}/create`, label: "Create" },
    { href: `/w/${workspaceId}/b/${brandId}/repurpose`, label: "Repurpose" },
    { href: `/w/${workspaceId}/b/${brandId}/videos`, label: "Videos" },
    { href: `/w/${workspaceId}/b/${brandId}/content`, label: "Content" },
    { href: `/w/${workspaceId}/b/${brandId}/projects`, label: "Projects" },
    { href: `/w/${workspaceId}/b/${brandId}/seo`, label: "SEO" },
    { href: `/w/${workspaceId}/b/${brandId}/ads`, label: "Ads" },
    { href: `/w/${workspaceId}/b/${brandId}/services`, label: "Services" },
    { href: `/w/${workspaceId}/b/${brandId}/review`, label: "Review" },
    { href: `/w/${workspaceId}/b/${brandId}/analytics`, label: "Analytics" },
    { href: `/w/${workspaceId}/b/${brandId}/insights`, label: "Insights" },
  ];
  return (
    <nav className="flex gap-4 overflow-x-auto whitespace-nowrap border-b border-[var(--border)] text-sm" aria-label="Brand">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={cn("-mb-px border-b-2 pb-2", path.startsWith(t.href) ? "border-[var(--accent)] font-medium" : "border-transparent text-[var(--text-muted)]")}>{t.label}</Link>
      ))}
    </nav>
  );
}
