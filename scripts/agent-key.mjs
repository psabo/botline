#!/usr/bin/env node
// Usage: node scripts/agent-key.mjs rotate|revoke <id> [--local|--remote]
//   rotate: new key to stdout ONCE (only its sha256 is stored); the old key keeps working for 10 minutes.
//   revoke: the agent's key stops working now (key_hash becomes a random hash nobody holds; no grace).
//           To issue a fresh key afterwards, run rotate.
// A suspected leak: revoke, then rotate. `KEY=$(node scripts/agent-key.mjs rotate claude)` works (notes go to stderr).
import { createHash, randomBytes } from "node:crypto";
import { ID_RE, die, parseArgs, q, runQuery, runSql } from "./_d1.mjs";

const { pos, mode } = parseArgs(process.argv.slice(2));
const [action, id] = pos;
if (!["rotate", "revoke"].includes(action) || !id || !ID_RE.test(id)) die("usage: agent-key.mjs rotate|revoke <id> [--local|--remote]");

const where = `workspace_id = 'default' AND id = ${q(id)}`;
const exists = runQuery(`SELECT id FROM agents WHERE ${where};`, mode);
if (!(Array.isArray(exists) && exists.at(-1)?.results?.length)) die(`no agent '${id}' (${mode.slice(2)})`);

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function rand(n) {
  let s = "";
  while (s.length < n) for (const b of randomBytes(n * 2)) if (b < 248 && s.length < n) s += ALPHA[b % 62]; // unbiased
  return s;
}

let key = null, hash;
if (action === "rotate") {
  key = `bl_${rand(8)}_${rand(32)}`;
  hash = createHash("sha256").update(key).digest("hex");
  const until = new Date(Date.now() + 10 * 60_000).toISOString();
  runSql(`UPDATE agents SET key_hash = ${q(hash)}, key_hash_prev = key_hash, prev_valid_until = ${q(until)} WHERE ${where};`, mode);
} else {
  hash = randomBytes(32).toString("hex"); // shaped like a sha256 but the hash of nothing anyone holds
  runSql(`UPDATE agents SET key_hash = ${q(hash)}, key_hash_prev = NULL, prev_valid_until = NULL WHERE ${where};`, mode);
}
const check = runQuery(`SELECT key_hash = ${q(hash)} AS ok FROM agents WHERE ${where};`, mode);
if (!(Array.isArray(check) && check.at(-1)?.results?.[0]?.ok === 1)) die(`${action} of '${id}' did not apply (${mode.slice(2)})`);
if (key) {
  console.error(`agent '${id}' rotated (${mode.slice(2)}); the old key works for 10 more minutes. New key below is shown ONCE:`);
  console.log(key);
} else console.error(`agent '${id}' revoked (${mode.slice(2)}): its key no longer works. Run rotate to issue a new one.`);
