"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Card } from "@arcatic/ui";
import { useApi } from "@/lib/use-api";

/** PWA start page: jump straight into the last workspace, or pick one. */
export default function MobileStart() {
  const router = useRouter();
  const me = useApi<{ memberships: Array<{ role: string; workspace: { id: string; name: string } | null }> }>("/me");
  const list = (me.data?.memberships ?? []).filter((m) => m.workspace);
  useEffect(() => {
    let last: string | null = null;
    try { last = localStorage.getItem("arcatic:lastWorkspace"); } catch { /* private mode */ }
    if (list.length === 1) router.replace(`/m/${list[0]!.workspace!.id}`);
    else if (last && list.some((m) => m.workspace!.id === last)) router.replace(`/m/${last}`);
  }, [list.length]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Choose a workspace</h1>
      {me.loading && <p className="text-sm text-[var(--text-muted)]">Loading…</p>}
      {list.map((m) => <Link key={m.workspace!.id} href={`/m/${m.workspace!.id}`}><Card className="p-4"><p className="font-medium">{m.workspace!.name}</p><p className="text-xs capitalize text-[var(--text-muted)]">{m.role}</p></Card></Link>)}
    </main>
  );
}
