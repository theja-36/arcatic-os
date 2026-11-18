import { AppError, assertSafeUrl, type Resolver } from "@arcatic/core";

/**
 * Fetch a user-supplied URL: SSRF check on every redirect hop, no credentials, size cap
 * enforced while streaming, overall timeout. Residual risk: DNS can change between our
 * check and the connection (rebinding) — production egress also goes through a proxy that
 * blocks private ranges (docs/06).
 */
export async function safeFetchBytes(
  rawUrl: string,
  opts: { resolve: Resolver; maxBytes: number; timeoutMs?: number; fetchImpl?: typeof fetch; maxRedirects?: number },
): Promise<{ bytes: Uint8Array; finalUrl: string; contentType: string | null }> {
  const f = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  let url = rawUrl;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const safe = await assertSafeUrl(url, { resolve: opts.resolve });
    const res = await f(safe.toString(), { redirect: "manual", signal, headers: { "user-agent": "ArcaticBot/1.0 (+https://arcatic.app/bot)", accept: "image/*,*/*;q=0.5" } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new AppError("validation_failed", "Redirect without a location.");
      url = new URL(loc, safe).toString();
      continue;
    }
    if (!res.ok) throw new AppError("validation_failed", `The URL returned HTTP ${res.status}.`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > opts.maxBytes) throw new AppError("validation_failed", `File is larger than ${Math.round(opts.maxBytes / 1048576)} MB.`);
    const reader = res.body?.getReader();
    if (!reader) throw new AppError("validation_failed", "Empty response.");
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel();
        throw new AppError("validation_failed", `File is larger than ${Math.round(opts.maxBytes / 1048576)} MB.`);
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) bytes.set(p, o), (o += p.byteLength);
    return { bytes, finalUrl: safe.toString(), contentType: res.headers.get("content-type") };
  }
  throw new AppError("validation_failed", "Too many redirects.");
}
