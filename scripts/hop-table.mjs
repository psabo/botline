#!/usr/bin/env node
// Usage: node scripts/hop-table.mjs <thread_id> [--local|--remote]
// Plan §3A per-hop record: one markdown row per (message, recipient) in the thread. `doorbell` is the latest
// ring_log row for that recipient whose message_ids contain the message ("poll" if none). Reads only; no bodies.
import { die, parseArgs, q, runQuery } from "./_d1.mjs";

const { pos, mode } = parseArgs(process.argv.slice(2));
const [tid] = pos;
if (!tid || !/^[A-Za-z0-9_-]{1,64}$/.test(tid)) die("usage: hop-table.mjs <thread_id> [--local|--remote]");

const sql = `SELECT m.id, m.hop_count, m.from_agent, r.agent, m.created_at, r.delivered_at, r.read_at, r.acked_at,
  (SELECT l.status || COALESCE(' ' || l.http_status, '') FROM ring_log l
    WHERE l.workspace_id = m.workspace_id AND l.agent = r.agent
      AND EXISTS (SELECT 1 FROM json_each(l.message_ids) j WHERE j.value = m.id)
    ORDER BY l.id DESC LIMIT 1) AS ring
  FROM messages m JOIN receipts r ON r.workspace_id = m.workspace_id AND r.message_id = m.id
  WHERE m.workspace_id = 'default' AND m.thread_id = ${q(tid)}
  ORDER BY m.created_at, m.id, r.agent`.replace(/\s+/g, " ");
const out = runQuery(sql, mode);
const rows = Array.isArray(out) ? out.at(-1)?.results : undefined;
if (!Array.isArray(rows)) die(`unexpected wrangler output:\n${String(out).slice(0, 500)}`);
if (rows.length === 0) die(`no messages in thread ${tid} (${mode.slice(2)})`);

const span = (from, to) => {
  if (!to) return "-";
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
console.log("| hop (from -> to) | sent | doorbell | delivered_at | read_at | acked_at | sent->read | sent->acked | human clicks |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows)
  console.log(`| ${r.hop_count} ${r.from_agent} -> ${r.agent} | ${r.created_at} | ${r.ring ?? "poll"} | ${r.delivered_at ?? "-"} | ` +
    `${r.read_at ?? "-"} | ${r.acked_at ?? "-"} | ${span(r.created_at, r.read_at)} | ${span(r.created_at, r.acked_at)} |  |`);
console.error(`thread ${tid}: ${new Set(rows.map((r) => r.id)).size} message(s), ${rows.length} hop(s) (${mode.slice(2)})`);
