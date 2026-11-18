"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

/** Send people to their first workspace, or to onboarding if they have none. */
export default function Root() {
  const router = useRouter();
  useEffect(() => {
    api<{ data: Array<{ id: string }> }>("/workspaces")
      .then((r) => router.replace(r.data[0] ? `/w/${r.data[0].id}` : "/onboarding"))
      .catch(() => router.replace("/sign-in"));
  }, [router]);
  return <p className="p-8 text-sm text-[var(--text-muted)]">Loading…</p>;
}
