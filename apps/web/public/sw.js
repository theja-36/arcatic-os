/* Arcatic service worker.
 * Privacy first: API responses and app pages hold customer data, so they are NEVER cached.
 * Cached: Next's immutable build assets, icons, the manifest and an offline fallback page.
 */
const VERSION = "arcatic-v1";
const SHELL = ["/offline", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // API, Supabase, signed media URLs: straight to the network
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; })));
    return;
  }
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/offline")));   // pages: network only, offline page as fallback
  }
});

/* Web Push: the payload is shown as-is; the server side (sending) is not built yet (docs/20). */
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || "Arcatic", { body: data.body || "", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { link: data.link || "/m" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || "/m";
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((ws) => { const w = ws.find((c) => "focus" in c); return w ? w.navigate(link).then((c) => c && c.focus()) : self.clients.openWindow(link); }));
});
