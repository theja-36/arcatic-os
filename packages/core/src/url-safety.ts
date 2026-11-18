import { AppError } from "./errors.js";

/**
 * SSRF guard for user-supplied URLs (image imports, crawl seeds, webhook targets).
 * `resolve` is injected so this stays runtime-agnostic; servers pass a node:dns lookup.
 * Re-run on every redirect hop.
 */
export type Resolver = (hostname: string) => Promise<string[]>;

export interface UrlSafetyOptions {
  resolve: Resolver;
  allowedSchemes?: readonly string[];
  allowedPorts?: readonly number[];
}

export async function assertSafeUrl(raw: string, opts: UrlSafetyOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("validation_failed", "Not a valid URL.");
  }
  const schemes = opts.allowedSchemes ?? ["https:", "http:"];
  if (!schemes.includes(url.protocol)) throw new AppError("validation_failed", `Scheme ${url.protocol} is not allowed.`);
  if (url.username || url.password) throw new AppError("validation_failed", "Credentials in URLs are not allowed.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!(opts.allowedPorts ?? [80, 443]).includes(port)) throw new AppError("validation_failed", `Port ${port} is not allowed.`);

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
    throw new AppError("validation_failed", "Internal hostnames are not allowed.");
  }
  const addresses = isIpLiteral(host) ? [host] : await opts.resolve(host);
  if (addresses.length === 0) throw new AppError("validation_failed", "Hostname did not resolve.");
  for (const a of addresses) {
    if (isPrivateAddress(a)) throw new AppError("validation_failed", "URL resolves to a private or reserved address.");
  }
  return url;
}

const isIpLiteral = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");

export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a.includes(":")) {
    if (a === "::" || a === "::1") return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return /^(fc|fd)/.test(a) || /^fe[89ab]/.test(a) || a.startsWith("ff") || a.startsWith("2001:db8") || a.startsWith("64:ff9b");
  }
  const p = a.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [x, y] = p as [number, number, number, number];
  return (
    x === 0 || x === 10 || x === 127 ||
    (x === 100 && y >= 64 && y <= 127) ||   // CGNAT
    (x === 169 && y === 254) ||             // link-local / cloud metadata
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 192 && y === 0) ||
    (x === 198 && (y === 18 || y === 19)) ||
    x >= 224                                 // multicast + reserved
  );
}
