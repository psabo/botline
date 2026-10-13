#!/usr/bin/env node
// Usage: node scripts/agent-add.mjs <id> [--name N] [--allow a,b|*] [--local|--remote]
// Creates an agent with a fresh key. The key goes to stdout ONCE (only its sha256 is stored);
// human-readable notes go to stderr, so `KEY=$(node scripts/agent-add.mjs claude)` works.
import { createHash, randomBytes } from "node:crypto";
import { ID_RE, die, parseArgs, q, runSql } from "./_d1.mjs";

const { pos, flags, mode } = parseArgs(process.argv.slice(2), ["name", "allow"]);
const [id] = pos;
if (!id || !ID_RE.test(id)) die("usage: agent-add.mjs <id> [--name N] [--allow a,b|*] [--local|--remote]  (id: [a-z0-9_-], <= 32)");
const name = (flags.name ?? id).slice(0, 64);
const allow = flags.allow ?? "*"; // '*' = any agent in the workspace; '' = nobody
let allowed = "*";
if (allow !== "*") {
  const ids = allow.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.every((x) => ID_RE.test(x))) die(`bad --allow list: ${allow}`);
  allowed = JSON.stringify(ids);
}

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function rand(n) {
  let s = "";
  while (s.length < n) for (const b of randomBytes(n * 2)) if (b < 248 && s.length < n) s += ALPHA[b % 62]; // unbiased
  return s;
}
const key = `bl_${rand(8)}_${rand(32)}`;
const hash = createHash("sha256").update(key).digest("hex");

runSql(
  `INSERT INTO agents (workspace_id, id, name, key_hash, allowed_senders, doorbell_kind, created_at)
   VALUES ('default', ${q(id)}, ${q(name)}, ${q(hash)}, ${q(allowed)}, 'none', ${q(new Date().toISOString())});`,
  mode,
);
console.error(`agent '${id}' created (${mode.slice(2)}); allowed_senders=${allowed}. Key below is shown ONCE:`);
console.log(key);
