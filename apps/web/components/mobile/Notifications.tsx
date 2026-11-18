"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@arcatic/ui";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";

type Note = { id: string; kind: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };

/** Bell + list of the person's notifications (same API a native app would use). */
export function NotificationsBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const load = async () => {
    try { const r = await api<{ data: Note[]; unread: number }>("/me/notifications?limit=30"); setItems(r.data); setUnread(r.unread); } catch { /* signed out */ }
  };
  useEffect(() => {
    void load();
    const ch = supabase().channel("me:notifications").on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, () => void load()).subscribe();
    return () => void supabase().removeChannel(ch);
  }, []);
  const [pushState, setPushState] = useState<"unknown" | "unsupported" | "off" | "on" | "denied" | "error">("unknown");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { setPushState("unsupported"); return; }
    if (Notification.permission === "denied") { setPushState("denied"); return; }
    navigator.serviceWorker.getRegistration().then(async (r) => {
      const sub = await r?.pushManager.getSubscription();
      if (!sub || Notification.permission !== "granted") { setPushState("off"); return; }
      // keep the server's device list in sync (new sign-in on this browser, or the device was pruned)
      const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await api("/me/devices", { method: "POST", body: JSON.stringify({ kind: "webpush", endpoint: j.endpoint, keys: j.keys, label: navigator.userAgent.slice(0, 120) }) }).catch(() => undefined);
      setPushState("on");
    }).catch(() => setPushState("off"));
  }, [open]);
  /** Subscribe this browser with the server's VAPID key and register it as a device. */
  const enablePush = async () => {
    try {
      const { publicKey } = await api<{ publicKey: string }>("/me/push-key");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setPushState(perm === "denied" ? "denied" : "off"); return; }
      const reg = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await api("/me/devices", { method: "POST", body: JSON.stringify({ kind: "webpush", endpoint: j.endpoint, keys: j.keys, label: navigator.userAgent.slice(0, 120) }) });
      setPushState("on");
    } catch { setPushState("error"); }
  };
  const markAll = async () => { await api("/me/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }).catch(() => undefined); void load(); };
  return (
    <div className={cn("relative", className)}>
      <button aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open} className="relative flex h-10 w-10 items-center justify-center rounded-full hover:bg-[var(--surface-2)]" onClick={() => setOpen(!open)}>
        <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        {unread > 0 && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-[var(--danger)] px-1 text-[10px] leading-4 text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="fixed inset-x-2 top-16 z-40 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-[22rem]">
          <div className="flex items-center border-b border-[var(--border)] px-3 py-2 text-sm"><span className="font-medium">Notifications</span>{unread > 0 && <button className="ml-auto text-xs text-[var(--accent)]" onClick={() => void markAll()}>Mark all read</button>}</div>
          {pushState === "off" && <button className="w-full border-b border-[var(--border)] px-3 py-2 text-left text-xs text-[var(--accent)]" onClick={() => void enablePush()}>Get push notifications on this device</button>}
          {pushState === "denied" && <p className="border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">Notifications are blocked for this site in your browser settings.</p>}
          {pushState === "error" && <p className="border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--danger)]">Couldn't turn on push here.</p>}
          <ul className="max-h-[60vh] overflow-auto">
            {items.length === 0 && <li className="p-3 text-sm text-[var(--text-muted)]">Nothing yet.</li>}
            {items.map((n) => (
              <li key={n.id} className={cn("border-b border-[var(--border)] last:border-0", !n.read_at && "bg-[var(--surface-2)]")}>
                <Link href={n.link ?? "#"} className="block px-3 py-2 text-sm" onClick={() => { setOpen(false); void api("/me/notifications/read", { method: "POST", body: JSON.stringify({ ids: [n.id] }) }).then(load).catch(() => undefined); }}>
                  <p className="font-medium">{n.title}</p>{n.body && <p className="text-xs text-[var(--text-muted)]">{n.body}</p>}
                  <p className="text-[11px] text-[var(--text-muted)]">{new Date(n.created_at).toLocaleString()}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
