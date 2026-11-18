"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ workspaceId: string }>("/invites/accept", { method: "POST", body: JSON.stringify({ token }) })
      .then((r) => router.replace(`/w/${r.workspaceId}`))
      .catch((e: Error) => setError(e.message));
  }, [token, router]);
  return <p className="p-8 text-sm">{error ? `This invite can't be used: ${error}` : "Joining workspace…"}</p>;
}
