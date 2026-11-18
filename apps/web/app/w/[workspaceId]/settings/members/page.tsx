"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Input } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

type Member = { user_id: string; role: string; status: string; user: { email: string; full_name: string | null } };
const ROLES = ["admin", "editor", "contributor", "reviewer", "viewer"];

export default function Members() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { data, reload } = useApi<{ data: Member[] }>(`/workspaces/${workspaceId}/members`);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [link, setLink] = useState("");
  const [msg, setMsg] = useState("");

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    try {
      const r = await api<{ token: string }>(`/workspaces/${workspaceId}/invites`, { method: "POST", body: JSON.stringify({ email, role }) });
      setLink(`${window.location.origin}/invite/${r.token}`);
      setEmail("");
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function changeRole(userId: string, newRole: string) {
    try {
      await api(`/workspaces/${workspaceId}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role: newRole }) });
      await reload();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Team</h1>
      <Card>
        <form onSubmit={invite} className="flex flex-col gap-2 sm:flex-row">
          <Input type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
          <select className="h-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <Button type="submit">Invite</Button>
        </form>
        {link && <p className="mt-3 break-all text-sm">Share this invite link (valid 7 days): <code>{link}</code></p>}
        {msg && <p className="mt-3 text-sm text-[var(--danger)]">{msg}</p>}
      </Card>
      <Card className="divide-y divide-[var(--border)] p-0">
        {data?.data.map((m) => (
          <div key={m.user_id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{m.user.full_name ?? m.user.email}</p>
              <p className="truncate text-xs text-[var(--text-muted)]">{m.user.email}</p>
            </div>
            <div className="flex items-center gap-2">
              {m.status !== "active" && <Badge tone="warning">{m.status}</Badge>}
              {m.role === "owner" ? <Badge tone="accent">owner</Badge> : (
                <select className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" value={m.role} onChange={(e) => changeRole(m.user_id, e.target.value)} aria-label={`Role for ${m.user.email}`}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
