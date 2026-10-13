#!/usr/bin/env node
// Usage: DOORBELL_MASTER_KEY=<base64> node scripts/doorbell-reencrypt.mjs [--local|--remote]
// Encrypts every plaintext doorbell secret in place (enc:v1:…). Idempotent: rows already prefixed `enc:` are skipped,
// and each UPDATE only applies if the row still holds the plaintext it read. Never prints a secret.
// The count it reports is read back from the database: a row counts as encrypted only if it now holds the exact
// ciphertext this run wrote (a row changed concurrently, e.g. by doorbell-set, is reported as skipped).
import { die, parseArgs, q, runQuery, runSql } from "./_d1.mjs";
import { masterKeyFromEnv, sealSecret } from "./_secret.mjs";

const { pos, mode } = parseArgs(process.argv.slice(2));
if (pos.length) die("usage: doorbell-reencrypt.mjs [--local|--remote]  (needs DOORBELL_MASTER_KEY in the environment)");
const master = masterKeyFromEnv() ?? die("DOORBELL_MASTER_KEY is not set (the same value as the Worker secret)");

const readSecrets = () => {
  const out = runQuery("SELECT workspace_id, id, doorbell_secret FROM agents WHERE doorbell_secret IS NOT NULL;", mode);
  const rows = Array.isArray(out) ? out.at(-1)?.results : undefined;
  if (!Array.isArray(rows)) die("unexpected wrangler output");
  return rows;
};
const rows = readSecrets();
const plain = rows.filter((r) => !r.doorbell_secret.startsWith("enc:"));
const sealed = new Map(); // "<workspace>/<id>" -> the ciphertext this run wrote
const sql = [];
for (const r of plain) {
  const aad = `${r.workspace_id}/${r.id}`;
  sealed.set(aad, await sealSecret(r.doorbell_secret, master, aad));
  sql.push(`UPDATE agents SET doorbell_secret = ${q(sealed.get(aad))}
    WHERE workspace_id = ${q(r.workspace_id)} AND id = ${q(r.id)} AND doorbell_secret = ${q(r.doorbell_secret)};`);
}
if (sql.length) runSql(sql.join("\n"), mode); // temp file (0600): the WHERE carries the plaintext

const changed = sql.length ? readSecrets().filter((r) => sealed.get(`${r.workspace_id}/${r.id}`) === r.doorbell_secret) : [];
const skipped = plain.filter((r) => !changed.some((c) => c.workspace_id === r.workspace_id && c.id === r.id));
console.error(
  `encrypted ${changed.length} secret(s) [${changed.map((r) => r.id).join(", ")}]` +
    (skipped.length ? `; ${skipped.length} skipped, changed during this run (run again) [${skipped.map((r) => r.id).join(", ")}]` : "") +
    `; ${rows.length - plain.length} already encrypted (${mode.slice(2)})`,
);
