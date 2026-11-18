"use client";
import { useState } from "react";
import { Button, Card, Input } from "@arcatic/ui";
import { supabase } from "@/lib/supabase";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const { error } = await supabase().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(new URLSearchParams(window.location.search).get("next") ?? "/")}` },
    });
    if (error) {
      setError(error.message);
      setState("error");
    } else setState("sent");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-semibold">Arcatic</h1>
      <p className="mb-6 text-sm text-[var(--text-muted)]">Your brand, planned, made and measured in one place.</p>
      <Card>
        {state === "sent" ? (
          <p className="text-sm">Check <strong>{email}</strong> for a sign-in link.</p>
        ) : (
          <form onSubmit={send} className="flex flex-col gap-3">
            <label className="text-sm font-medium" htmlFor="email">Work email</label>
            <Input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button type="submit" disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Email me a sign-in link"}</Button>
            {state === "error" && <p className="text-sm text-[var(--danger)]">{error}</p>}
          </form>
        )}
      </Card>
    </main>
  );
}
