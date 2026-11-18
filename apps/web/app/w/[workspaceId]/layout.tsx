"use client";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { cn } from "@arcatic/ui";
import { useApi } from "@/lib/use-api";
import { NotificationsBell } from "@/components/mobile/Notifications";

const nav = [
  { href: "", label: "Home" },
  { href: "/brands", label: "Brands" },
  { href: "/media", label: "Media" },
  { href: "/jobs", label: "Activity" },
  { href: "/settings/channels", label: "Channels" },
  { href: "/settings/ads", label: "Ad accounts" },
  { href: "/settings/members", label: "Team" },
  { href: "/settings/api-keys", label: "API keys" },
  { href: "/settings/billing", label: "Billing" },
];

/** Shown when paid work is paused (trial ended, payment overdue, cancelled) or about to be. */
function BillingBanner({ workspaceId }: { workspaceId: string }) {
  const { data } = useApi<{ state: { canSpend: boolean; reason?: string; warning?: string } }>(`/workspaces/${workspaceId}/billing`);
  const s = data?.state;
  if (!s || (s.canSpend && !s.warning)) return null;
  return (
    <div role="status" className={cn("mb-4 rounded-[var(--radius)] border p-3 text-sm", s.canSpend ? "border-[var(--warning)]" : "border-[var(--danger)]")}>
      {s.canSpend ? s.warning : <><span className="font-medium">Creating is paused.</span> {s.reason}</>}{" "}
      <Link className="text-[var(--accent)] hover:underline" href={`/w/${workspaceId}/settings/billing`}>Billing</Link>
    </div>
  );
}

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const path = usePathname();
  const { data: ws } = useApi<{ name: string; role: string }>(`/workspaces/${workspaceId}`);
  const base = `/w/${workspaceId}`;
  const desk = useApi<{ role: string }>("/desk/me");   // 404 for everyone outside the service team
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-b border-[var(--border)] bg-[var(--surface)] md:w-56 md:border-b-0 md:border-r">
        <div className="flex items-start gap-2 px-4 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Workspace</p>
            <p className="truncate font-semibold">{ws?.name ?? "…"}</p>
            {ws && <p className="text-xs capitalize text-[var(--text-muted)]">{ws.role}</p>}
          </div>
          <NotificationsBell />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {nav.map((n) => {
            const href = base + n.href;
            const active = n.href === "" ? path === base : path.startsWith(href);
            return (
              <Link key={n.href} href={href} className={cn("whitespace-nowrap rounded-md px-3 py-2 text-sm", active ? "bg-[var(--surface-2)] font-medium" : "text-[var(--text-muted)] hover:bg-[var(--surface-2)]")}>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden flex-col gap-1 px-2 pb-4 text-sm md:flex">
          <Link href={`/m/${workspaceId}`} className="rounded-md px-3 py-2 text-[var(--text-muted)] hover:bg-[var(--surface-2)]">Mobile view</Link>
          {desk.data && <Link href="/desk" className="rounded-md px-3 py-2 text-[var(--text-muted)] hover:bg-[var(--surface-2)]">Service desk</Link>}
        </div>
      </aside>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-8">
        {ws && ["owner", "admin", "editor"].includes(ws.role) && !path.startsWith(`${base}/settings/billing`) && <BillingBanner workspaceId={workspaceId} />}
        {children}
      </main>
    </div>
  );
}
