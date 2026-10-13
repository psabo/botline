#!/usr/bin/env node
// Usage: node scripts/doorbell-set.mjs <id> <kind> <url> [secret] [--local|--remote]
//   kind: none | claude_fire | grokbot_webhook | generic_webhook   (for `none`, pass '-' as url)
//   secret may instead come from env BOTLINE_DOORBELL_SECRET (keeps it out of shell history).
//   With DOORBELL_MASTER_KEY in the environment (the same value as the Worker secret) the secret is stored
//   encrypted (enc:v1:…); without it, plaintext with a warning.
// Any run (any kind) also resets the doorbell's backoff / dead-letter state: fail_count = 0, and a backoff lease is
// lifted so the next send rings. A lease held by a ring in flight is left alone (one ring in flight at a time).
import { ID_RE, die, parseArgs, q, runQuery, runSql } from "./_d1.mjs";
import { masterKeyFromEnv, sealSecret } from "./_secret.mjs";

const KINDS = ["none", "claude_fire", "grokbot_webhook", "generic_webhook"];
// Must match the Worker's pins in src/adapters/{claude_fire,grokbot_webhook}.ts; the Worker refuses anything else.
const VENDOR_HOST = { claude_fire: "api.anthropic.com", grokbot_webhook: "api2.cursor.sh" };
const { pos, mode } = parseArgs(process.argv.slice(2));
const [id, kind, rawUrl, argSecret] = pos;
if (!id || !ID_RE.test(id) || !KINDS.includes(kind))
  die(`usage: doorbell-set.mjs <id> <${KINDS.join("|")}> <url|-> [secret] [--local|--remote]`);

let url = null, secret = null;
if (kind !== "none") {
  try { url = new URL(rawUrl ?? ""); } catch { die(`bad url: ${rawUrl}`); }
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) die("url must be https (http only for localhost)");
  if (VENDOR_HOST[kind] && (url.protocol !== "https:" || url.hostname !== VENDOR_HOST[kind]))
    die(`${kind} only rings https://${VENDOR_HOST[kind]}/… (see src/adapters/${kind}.ts)`);
  if (kind === "claude_fire" && !/\/fire$/.test(url.pathname)) console.error("warning: claude_fire URLs normally end in /fire");
  if (kind === "generic_webhook") console.error(`note: the Worker rings this only if ${url.hostname} is in WEBHOOK_ALLOWED_HOSTS`);
  url = url.toString();
  secret = argSecret ?? process.env.BOTLINE_DOORBELL_SECRET ?? null;
  if (kind !== "generic_webhook" && !secret) die(`${kind} needs a secret (the routine/webhook bearer token)`);
}
const master = masterKeyFromEnv();
if (secret && master) secret = await sealSecret(secret, master, `default/${id}`);
else if (secret) console.error("warning: DOORBELL_MASTER_KEY is not set; storing the doorbell secret in plaintext");

// The UPDATE carries the secret, so it goes through a temp file; the read-back is secret-free and uses
// --command, which is the only form that returns rows in --remote mode.
runSql(
  `UPDATE agents SET doorbell_kind = ${q(kind)}, doorbell_url = ${q(url)}, doorbell_secret = ${q(secret)}
     WHERE workspace_id = 'default' AND id = ${q(id)};
   UPDATE rings SET fail_count = 0, lease_until = CASE WHEN in_flight_since IS NULL THEN NULL ELSE lease_until END
     WHERE workspace_id = 'default' AND agent = ${q(id)};`,
  mode,
);
const out = runQuery(
  `SELECT a.id, a.doorbell_kind, a.doorbell_url, COALESCE(r.fail_count, 0) AS fail_count FROM agents a
     LEFT JOIN rings r ON r.workspace_id = a.workspace_id AND r.agent = a.id WHERE a.workspace_id = 'default' AND a.id = ${q(id)};`,
  mode,
);
const row = Array.isArray(out) ? out.at(-1)?.results?.[0] : undefined;
if (!row) die(`no agent '${id}' (${mode.slice(2)})`);
if (row.fail_count !== 0) die(`doorbell for '${row.id}' set, but fail_count is still ${row.fail_count} (${mode.slice(2)})`);
console.error(`doorbell for '${row.id}': ${row.doorbell_kind} ${row.doorbell_url ?? ""} (secret ${secret ? (master ? "set, encrypted" : "set, plaintext") : "none"}; fail_count 0)`);
