#!/usr/bin/env node
// Usage: node scripts/migrate.mjs [--local|--remote]
// Brings an existing database up to schema.sql. SQLite has no ADD COLUMN IF NOT EXISTS, so this reads
// PRAGMA table_info and adds only the missing columns. Additive only; a no-op on a fresh schema.sql install.
// New TABLES come from re-running schema.sql (safe to re-run); this script names any that are still missing.
import { readFileSync } from "node:fs";
import { die, parseArgs, runQuery, runSql } from "./_d1.mjs";

const COLUMNS = {
  agents: { key_hash_prev: "TEXT", prev_valid_until: "TEXT" }, // v0.1: key rotation grace
  rings: { fail_count: "INTEGER NOT NULL DEFAULT 0" }, // v0.1: doorbell backoff + dead-letter
  ring_log: { detail: "TEXT" }, // v0.1: the reason on error / failed / timeout rows
};

const { pos, mode } = parseArgs(process.argv.slice(2));
if (pos.length) die("usage: migrate.mjs [--local|--remote]");
const add = [];
for (const [table, cols] of Object.entries(COLUMNS)) {
  const out = runQuery(`PRAGMA table_info(${table});`, mode);
  const have = Array.isArray(out) ? out.at(-1)?.results?.map((c) => c.name) : undefined;
  if (!have?.length) die(`table ${table} not found (${mode.slice(2)}): apply schema.sql first`);
  for (const [col, type] of Object.entries(cols))
    if (!have.includes(col)) add.push(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`);
}
if (add.length) runSql(add.join("\n"), mode);
console.error(add.length ? `applied (${mode.slice(2)}):\n${add.join("\n")}` : `columns up to date (${mode.slice(2)})`);

const want = [...readFileSync(new URL("../schema.sql", import.meta.url), "utf8").matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const tables = runQuery("SELECT name FROM sqlite_master WHERE type = 'table';", mode);
const haveTables = Array.isArray(tables) ? tables.at(-1)?.results?.map((t) => t.name) ?? [] : [];
const missing = want.filter((t) => !haveTables.includes(t));
if (missing.length) {
  console.error(`missing table(s): ${missing.join(", ")} -- run: npx wrangler d1 execute <db> ${mode} --file schema.sql (safe to re-run)`);
  process.exitCode = 1; // a Worker deployed now would fail on those tables
}
