"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Input } from "@arcatic/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

type Key = { id: string; name: string; prefix: string; role: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null };

export default function ApiKeys() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { data, reload, error } = useApi<{ data: Key[] }>(`/workspaces/${workspaceId}/api-keys`);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const r = await api<{ key: string }>(`/workspaces/${workspaceId}/api-keys`, { method: "POST", body: JSON.stringify({ name, role: "editor" }) });
    setSecret(r.key);
    setName("");
    await reload();
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">API keys</h1>
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      <Card>
        <form onSubmit={create} className="flex flex-col gap-2 sm:flex-row">
          <Input required placeholder="Key name, e.g. Zapier" value={name} onChange={(e) => setName(e.target.value)} aria-label="Key name" />
          <Button type="submit">Create key</Button>
        </form>
        {secret && (
          <div className="mt-3 rounded-md bg-[var(--surface-2)] p-3 text-sm">
            <p className="font-medium">Copy this key now — it won't be shown again.</p>
            <code className="break-all">{secret}</code>
          </div>
        )}
      </Card>
      <Card className="divide-y divide-[var(--border)] p-0">
        {data?.data.map((k) => (
          <div key={k.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <div>
              <p className="font-medium">{k.name}</p>
              <p className="text-xs text-[var(--text-muted)]">{k.prefix}… · {k.role} · {k.last_used_at ? `used ${new Date(k.last_used_at).toLocaleDateString()}` : "never used"}</p>
            </div>
            {k.revoked_at ? <Badge>revoked</Badge> : (
              <Button variant="ghost" onClick={() => api(`/workspaces/${workspaceId}/api-keys/${k.id}`, { method: "DELETE" }).then(reload)}>Revoke</Button>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
