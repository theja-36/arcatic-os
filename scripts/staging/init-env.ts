/**
 * Creates .env.staging (git-ignored, mode 600) from .env.staging.example and fills in the secrets
 * WE generate: ENCRYPTION_KEY, ADMIN_API_TOKEN, PUSH_RECEIPT_SECRET and a VAPID key pair.
 * Values are written to the file only — never printed. Provider-issued values (Supabase, Temporal,
 * SMTP, domains) are left blank for you to fill in locally or in the host's secret manager.
 * Refuses to overwrite an existing file.
 *
 *   pnpm staging:init
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, ".env.staging");
if (existsSync(out)) { console.error(".env.staging already exists — not overwriting."); process.exit(1); }
const webpush = createRequire(join(root, "packages/integrations/package.json"))("web-push") as { generateVAPIDKeys(): { publicKey: string; privateKey: string } };
const vapid = webpush.generateVAPIDKeys();
const rand = () => randomBytes(32).toString("base64url");
const gen: Record<string, string> = { ENCRYPTION_KEY: rand(), ADMIN_API_TOKEN: rand(), PUSH_RECEIPT_SECRET: rand(), VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
let text = readFileSync(join(root, ".env.staging.example"), "utf8");
for (const [k, v] of Object.entries(gen)) text = text.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`);
writeFileSync(out, text, { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`Wrote .env.staging (mode 600) with generated: ${Object.keys(gen).join(", ")}.\nStill blank for you: Supabase keys/URLs, domains, Temporal, SMTP.`);
