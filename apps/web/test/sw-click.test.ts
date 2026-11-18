import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The service worker's push + notification-click behaviour, run in a simulated worker scope.
 * Covers: app open and focused (foreground), app open but not focused (background), app closed,
 * and hostile / malformed links. Real-browser checks are recorded in docs/21.
 */
const SW = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
const ORIGIN = "https://app.arcatic.test";
const WS = "11111111-1111-4111-8111-111111111111", BRAND = "33333333-3333-4333-8333-333333333333", REQ = "44444444-4444-4444-8444-444444444444";
const DEEP = `/m/${WS}?tab=inbox&service=${REQ}&brand=${BRAND}`;

type Win = { url: string; focused: boolean; calls: string[]; navigateFails?: boolean; focus: () => Promise<Win>; navigate: (u: string) => Promise<Win>; postMessage: (m: unknown) => void; messages: unknown[] };
const win = (url: string, o: { navigateFails?: boolean } = {}): Win => {
  const w: Win = { url, focused: false, calls: [], messages: [], navigateFails: o.navigateFails,
    focus: async () => { w.calls.push("focus"); w.focused = true; return w; },
    navigate: async (u) => { w.calls.push(`navigate:${u}`); if (w.navigateFails) throw new TypeError("uncontrolled client"); w.url = new URL(u, ORIGIN).href; return w; },
    postMessage: (m) => { w.calls.push("postMessage"); w.messages.push(m); } };
  return w;
};

function worker(clients: Win[]) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const opened: string[] = [], shown: Array<{ title: string; opts: Record<string, unknown> }> = [], matchArgs: unknown[] = [];
  const fetched: Array<{ url: string; body: { receipt: string; event: string } }> = [];
  const self = {
    location: { origin: ORIGIN }, addEventListener: (t: string, f: (e: unknown) => void) => { handlers[t] = f; }, skipWaiting() {},
    clients: { claim() {}, matchAll: async (a: unknown) => { matchArgs.push(a); return clients; }, openWindow: async (u: string) => { opened.push(u); } },
    registration: { showNotification: async (title: string, opts: Record<string, unknown>) => { shown.push({ title, opts }); } },
  };
  new Function("self", "caches", "fetch", SW)(self, { open: async () => ({}), keys: async () => [], match: async () => undefined }, async (url: string, init: { body: string }) => { fetched.push({ url, body: JSON.parse(init.body) }); return {}; });
  const waits: Promise<unknown>[] = [];
  const ev = (extra: object) => ({ waitUntil: (p: Promise<unknown>) => waits.push(p), ...extra });
  const push = async (payload: unknown) => { handlers.push!(ev({ data: { json: () => payload, text: () => "x" } })); await Promise.all(waits); };
  const click = async (link: unknown, extra: object = {}) => { let closed = false; handlers.notificationclick!(ev({ notification: { data: link === undefined ? { ...extra } : { link, ...extra }, close: () => { closed = true; } } })); await Promise.all(waits); return closed; };
  return { opened, shown, matchArgs, fetched, push, click };
}

describe("push display", () => {
  it("shows title, body, tag and keeps the target link", async () => {
    const w = worker([]);
    await w.push({ title: "Ready for your review: Tiffin guide", body: "Here you go", link: DEEP, tag: "customer.delivered" });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]).toMatchObject({ title: "Ready for your review: Tiffin guide", opts: { body: "Here you go", tag: "customer.delivered", data: { link: DEEP } } });
  });
  it("falls back to /m when the payload has no link", async () => {
    const w = worker([]);
    await w.push({ title: "Hi" });
    expect(w.shown[0]!.opts.data).toMatchObject({ link: "/m" });
  });
});

describe("push display: no silent replacement, receipts", () => {
  it("each notification has its own tag and always alerts, even when it replaces another", async () => {
    const w = worker([]);
    await w.push({ title: "A", tag: "n-1" });
    await w.push({ title: "B", tag: "n-2" });
    expect(w.shown.map((n) => n.opts.tag)).toEqual(["n-1", "n-2"]);
    expect(w.shown.every((n) => n.opts.renotify === true)).toBe(true);
    await w.push({ title: "no tag" });
    expect(w.shown[2]!.opts).toMatchObject({ tag: undefined, renotify: false });
  });
  it("reports 'displayed' and 'clicked' to the server with the signed token (only when the push carries one)", async () => {
    const w = worker([]);
    const payload = { title: "T", tag: "n-9", link: DEEP, receipt: "id.sig", receiptUrl: "https://api.arcatic.test/push/receipt" };
    await w.push(payload);
    expect(w.fetched).toEqual([{ url: payload.receiptUrl, body: { receipt: "id.sig", event: "displayed" } }]);
    await w.click(DEEP, { receipt: "id.sig", receiptUrl: payload.receiptUrl });
    expect(w.fetched.at(-1)).toEqual({ url: payload.receiptUrl, body: { receipt: "id.sig", event: "clicked" } });
    const quiet = worker([]);
    await quiet.push({ title: "T" });
    await quiet.click(DEEP);
    expect(quiet.fetched).toEqual([]);
  });
});

describe("notification click", () => {
  it("foreground: the focused app window is focused and taken to the request", async () => {
    const a = win(`${ORIGIN}/m/${WS}?tab=create`); a.focused = true;
    const w = worker([a]);
    expect(await w.click(DEEP)).toBe(true);   // notification closed
    expect(a.calls).toEqual(["focus", `navigate:${DEEP}`]);
    expect(a.url).toBe(`${ORIGIN}${DEEP}`);
    expect(w.opened).toEqual([]);
  });
  it("background: a hidden / unfocused window is brought forward and navigated", async () => {
    const bg = win(`${ORIGIN}/w/${WS}/media`);
    const w = worker([bg]);
    await w.click(DEEP);
    expect(bg.focused).toBe(true);
    expect(bg.calls[0]).toBe("focus");
    expect(bg.calls).toContain(`navigate:${DEEP}`);
    expect(w.opened).toEqual([]);
  });
  it("also finds windows this worker doesn't control yet (includeUncontrolled)", async () => {
    const w = worker([win(`${ORIGIN}/m`)]);
    await w.click(DEEP);
    expect(w.matchArgs[0]).toEqual({ type: "window", includeUncontrolled: true });
  });
  it("closed browser: opens a new window at the right /m page", async () => {
    const w = worker([]);
    await w.click(DEEP);
    expect(w.opened).toEqual([DEEP]);
  });
  it("ignores windows of other origins", async () => {
    const other = win("https://elsewhere.example/page");
    const w = worker([other]);
    await w.click(DEEP);
    expect(other.calls).toEqual([]);
    expect(w.opened).toEqual([DEEP]);
  });
  it("a window already on that page is just focused, not reloaded", async () => {
    const same = win(`${ORIGIN}${DEEP}`);
    await worker([same]).click(DEEP);
    expect(same.calls).toEqual(["focus"]);
  });
  it("when a window can't be navigated, it is asked to navigate itself", async () => {
    const stuck = win(`${ORIGIN}/m/${WS}`, { navigateFails: true });
    await worker([stuck]).click(DEEP);
    expect(stuck.messages).toEqual([{ type: "arcatic:navigate", url: DEEP }]);
  });
  it("never leaves the app: other origins, protocol tricks and junk become /m", async () => {
    for (const bad of ["https://evil.example/phish", "//evil.example/x", "javascript:alert(1)", "data:text/html,x", "http://localhost:1/x", 42, null]) {
      const w = worker([]);
      await w.click(bad);
      expect(w.opened, String(bad)).toEqual(["/m"]);
    }
    const w = worker([]); await w.click(undefined);
    expect(w.opened).toEqual(["/m"]);
  });
  it("an absolute link to this app's own origin is reduced to its path", async () => {
    const w = worker([]);
    await w.click(`${ORIGIN}${DEEP}`);
    expect(w.opened).toEqual([DEEP]);
  });
});
