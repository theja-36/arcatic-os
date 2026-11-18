/**
 * Creates .env.staging (git-ignored, mode 600) from .env.staging.example and fills in the secrets
 * WE generate: ENCRYPTION_KEY, ADMIN_API_TOKEN, PUSH_RECEIPT_SECRET and a VAPID key pair.
 * Values are written to the file only — never printed. Provider-issued values (Supabase, Temporal,
 * SMTP, domains) are left blank for you to fill in locally or in the host's secret manager.
 * Refuses to overwrite an existing file. `--merge` appends variables that the template gained since
 * (blank) to an existing file without touching any value already there.
 *
 *   pnpm staging:init            create
 *   pnpm staging:init -- --merge add new template variables to an existing .env.staging
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, ".env.staging");
const merge = process.argv.includes("--merge");
if (existsSync(out) && merge) {
  const have = new Set(readFileSync(out, "utf8").split("\n").map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1]).filter(Boolean));
  const tpl = readFileSync(join(root, ".env.staging.example"), "utf8").split("\n");
  const add: string[] = [];
  let pending: string[] = [];
  for (const l of tpl) {
    const k = /^([A-Z0-9_]+)=/.exec(l)?.[1];
    if (l.startsWith("#")) pending.push(l);
    else if (k) { if (!have.has(k)) add.push(...pending, l); pending = []; }
    else pending = [];
  }
  if (!add.length) { console.log(".env.staging already has every template variable."); process.exit(0); }
  writeFileSync(out, `${readFileSync(out, "utf8").replace(/\n*$/, "\n")}\n# ---- added by staging:init --merge ----\n${add.join("\n")}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`Appended ${add.filter((l) => /^[A-Z0-9_]+=/.test(l)).length} new variable(s) to .env.staging; existing values untouched.`);
  process.exit(0);
}
if (existsSync(out)) { console.error(".env.staging already exists — not overwriting (use --merge to add new variables)."); process.exit(1); }
const webpush = createRequire(join(root, "packages/integrations/package.json"))("web-push") as { generateVAPIDKeys(): { publicKey: string; privateKey: string } };
const vapid = webpush.generateVAPIDKeys();
const rand = () => randomBytes(32).toString("base64url");
const gen: Record<string, string> = { ENCRYPTION_KEY: rand(), ADMIN_API_TOKEN: rand(), PUSH_RECEIPT_SECRET: rand(), VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
let text = readFileSync(join(root, ".env.staging.example"), "utf8");
for (const [k, v] of Object.entries(gen)) text = text.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`);
writeFileSync(out, text, { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`Wrote .env.staging (mode 600) with generated: ${Object.keys(gen).join(", ")}.\nStill blank for you: Supabase keys/URLs, domains, Temporal, SMTP.`);
