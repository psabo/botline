// Shared helper for the admin scripts: run SQL through `wrangler d1 execute` from a private temp file
// (keeps doorbell secrets out of process args and shell history).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DB = process.env.BOTLINE_DB ?? "botline-spike";
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const q = (v) => (v == null ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);

export function die(msg) {
  console.error(msg);
  process.exit(1);
}

/** Positionals, --flag value pairs for `valueFlags`, and --local (default) | --remote. */
export function parseArgs(argv, valueFlags = []) {
  const pos = [], flags = {};
  let mode = "--local";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local" || a === "--remote") mode = a;
    else if (a.startsWith("--") && valueFlags.includes(a.slice(2))) flags[a.slice(2)] = argv[++i] ?? "";
    else if (a.startsWith("--")) die(`unknown flag ${a}`);
    else pos.push(a);
  }
  return { pos, flags, mode };
}

/** wrangler prints upload progress lines before the JSON in --remote mode; keep only the JSON array/object. */
function parseJsonOutput(stdout) {
  const i = stdout.search(/^[\[{]/m);
  try { return JSON.parse(i >= 0 ? stdout.slice(i) : stdout); } catch { return stdout; }
}

function exec(args) {
  // BOTLINE_PERSIST_TO points --local at another local state dir (same as `wrangler dev --persist-to`).
  const persist = args[0] === "--local" && process.env.BOTLINE_PERSIST_TO ? ["--persist-to", process.env.BOTLINE_PERSIST_TO] : [];
  const r = spawnSync("npx", ["wrangler", "d1", "execute", DB, ...args, ...persist, "--yes", "--json"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) die(`wrangler d1 execute failed:\n${r.stderr || r.stdout}`);
  return parseJsonOutput(r.stdout);
}

/** Execute SQL from a private temp file (secrets stay out of argv). In --remote mode a file run returns only an
 *  execution summary, never rows: use runQuery for anything you need to read back. Exits on failure. */
export function runSql(sql, mode) {
  const dir = mkdtempSync(join(tmpdir(), "botline-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    return exec([mode, "--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Execute a secret-free SELECT via --command; returns rows in both modes. */
export function runQuery(sql, mode) {
  return exec([mode, "--command", sql]);
}
