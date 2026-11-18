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

/* Web Push: show the notice; sending lives on the server (packages/jobs/src/notifier.ts). */
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: e.data && e.data.text() }; }
  // renotify: a notification that replaces another with the same tag must still alert
  e.waitUntil(Promise.all([
    self.registration.showNotification(data.title || "Arcatic", { body: data.body || "", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", tag: data.tag || undefined, renotify: !!data.tag, data: { link: data.link || "/m", receipt: data.receipt || null, receiptUrl: data.receiptUrl || null } }),
    receipt(data.receiptUrl, data.receipt, "displayed"),
  ]));
});

/** Tell the server what really happened (best effort): displayed, clicked. Separates push-service acceptance from display. */
let lastReceipt = null;
function receipt(url, token, event) {
  if (!url || !token) return Promise.resolve();
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: token, event }), keepalive: true })
    .then((r) => { lastReceipt = { event, status: r.status, at: Date.now() }; })
    .catch((err) => { lastReceipt = { event, error: String(err), at: Date.now() }; });
}

/** Diagnostics for the page: what did the last receipt attempt do? (`{type:"arcatic:diag"}`) */
self.addEventListener("message", (e) => {
  if (!e.data || !e.source) return;
  if (e.data.type === "arcatic:diag") e.source.postMessage({ type: "arcatic:diag-result", lastReceipt });
  // exercise the receipt path from the worker itself, without needing a push
  if (e.data.type === "arcatic:receipt-test") e.waitUntil(receipt(e.data.url, e.data.token, e.data.event).then(() => e.source.postMessage({ type: "arcatic:diag-result", lastReceipt })));
});

/** Only app pages on this origin are ever opened: a push payload can't send people to another site. */
const APP_PATH = /^\/(m|w|desk)(\/|\?|#|$)/;
function safeLink(raw) {
  if (typeof raw !== "string") return "/m";
  try {
    const u = new URL(raw, self.location.origin);
    const path = u.pathname + u.search + u.hash;
    return u.origin === self.location.origin && APP_PATH.test(path) ? path : "/m";
  } catch { return "/m"; }
}

/**
 * Notification click, three situations:
 *  - the app is open and focused / open in the background: focus that window and take it to the
 *    notice's page (full navigation; a message to the page is the fallback for windows the worker
 *    doesn't control)
 *  - the app is closed: open a new window at the notice's page
 */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = safeLink(e.notification.data && e.notification.data.link);
  const d = e.notification.data || {};
  e.waitUntil((async () => {
    await receipt(d.receiptUrl, d.receipt, "clicked");
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((c) => { try { return new URL(c.url).origin === self.location.origin; } catch { return false; } });
    if (!win) { await self.clients.openWindow(url); return; }
    try { await win.focus(); } catch { /* focus can be refused; navigation below still helps */ }
    const here = new URL(win.url);
    if (here.pathname + here.search === new URL(url, self.location.origin).pathname + new URL(url, self.location.origin).search) return;
    try { await win.navigate(url); } catch { win.postMessage({ type: "arcatic:navigate", url }); }
  })());
});
