/**
 * Where to send someone after sign-in: only a path on this site. Anything else (another origin,
 * `//host`, `/\host` — browsers treat a backslash as a slash — or control characters) becomes "/".
 */
export function safeNext(next: string | null | undefined, base: string): string {
  if (!next || !next.startsWith("/") || /[\\\u0000-\u001f]/.test(next)) return "/";
  try {
    const u = new URL(next, base);
    return u.origin === new URL(base).origin ? `${u.pathname}${u.search}${u.hash}` : "/";
  } catch {
    return "/";
  }
}
