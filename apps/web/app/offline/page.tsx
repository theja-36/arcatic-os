export const metadata = { title: "Offline · Arcatic" };

/** Served by the service worker when there is no connection. No customer data is cached offline. */
export default function Offline() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">You're offline</h1>
      <p className="text-sm text-[var(--text-muted)]">Arcatic needs a connection to show your approvals, calendar and media. Nothing is stored on this device. Reconnect and try again.</p>
      <a href="/m" className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm text-[var(--accent-fg)]">Try again</a>
    </main>
  );
}
