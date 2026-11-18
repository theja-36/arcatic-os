"use client";
import { useEffect, useState } from "react";

declare global {
  interface Window { __arcaticInstall?: { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> } | null }
}

/**
 * Registers the service worker in production builds and keeps Chrome's install prompt
 * (`beforeinstallprompt`, fired only when the app meets Chrome's installability criteria) so the
 * mobile hub can offer an "Install app" button.
 */
export function RegisterSW() {
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); window.__arcaticInstall = e as unknown as Window["__arcaticInstall"]; window.dispatchEvent(new Event("arcatic:installable")); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", () => { window.__arcaticInstall = null; });
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);
  return null;
}

/** "Install app" button, shown only when the browser says the app can be installed. */
export function InstallButton({ className }: { className?: string }) {
  return <InstallButtonInner className={className} />;
}
function InstallButtonInner({ className }: { className?: string }) {
  const [can, setCan] = useState(false);
  useEffect(() => {
    const on = () => setCan(!!window.__arcaticInstall);
    on();
    window.addEventListener("arcatic:installable", on);
    return () => window.removeEventListener("arcatic:installable", on);
  }, []);
  if (!can) return null;
  return <button className={className} onClick={async () => { await window.__arcaticInstall?.prompt(); window.__arcaticInstall = null; setCan(false); }}>Install app</button>;
}
