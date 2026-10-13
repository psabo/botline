#!/usr/bin/env node
// Usage: node scripts/waitlist-export.mjs [--local|--remote] > waitlist.csv
// CSV of the CONFIRMED (double opt-in) waitlist rows: email, would_pay, source, created_at, confirmed_at. Pending rows
// are never exported. The Phase 2 gate counts would_pay = yes (plan §3B "Gate to Phase 2": 25). Counts go to stderr,
// so stdout is pure CSV. The output holds email addresses: keep it out of git and shared folders.
import { die, parseArgs, runQuery } from "./_d1.mjs";

const { pos, mode } = parseArgs(process.argv.slice(2));
if (pos.length) die("usage: waitlist-export.mjs [--local|--remote]");
const out = runQuery(
  "SELECT email, would_pay, source, created_at, confirmed_at FROM waitlist WHERE workspace_id = 'default' AND confirmed_at IS NOT NULL ORDER BY confirmed_at, email;",
  mode,
);
const rows = Array.isArray(out) ? out.at(-1)?.results : undefined;
if (!Array.isArray(rows)) die(`unexpected wrangler output:\n${String(out).slice(0, 500)}`);

const COLS = ["email", "would_pay", "source", "created_at", "confirmed_at"];
// RFC 4180 quoting, and a leading ' on cells a spreadsheet would read as a formula.
const cell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
console.log(COLS.join(","));
for (const r of rows) console.log(COLS.map((c) => cell(r[c])).join(","));
const n = (k) => rows.filter((r) => r.would_pay === k).length;
console.error(`${rows.length} confirmed: yes=${n("yes")} maybe=${n("maybe")} no=${n("no")} (Phase 2 gate: 25 yes) (${mode.slice(2)})`);
