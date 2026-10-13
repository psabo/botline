#!/usr/bin/env node
// Usage: BOTLINE_AGENTS=claude,grokbot,muse BOTLINE_KEY_CLAUDE=… BOTLINE_KEY_GROKBOT=… BOTLINE_KEY_MUSE=… \
//          node scripts/conformance.mjs <base-url> [--timeout-min N] [--relay] [--poll-sec S] [--run-id ID]
// The gentle live run (plan §3A "Measure", §3B.5), safe on a deployment whose doorbells are real. For every ordered pair
// (A, B), A sends B one `needs: reply` ping; the script then polls GET /v1/thread/<id> AS THE SENDER (every 15 s) until
// B's reply appears or the timeout (default 20 min). It never reads an inbox (that would claim the agents' mail), never
// acks, never touches a doorbell, the waitlist or an agent row: the only calls it can make are the four in ALLOWED.
// The timeout is a deadline: no poll starts after it, a poll near it gets only the time left, then one final parallel
// read fills the table. A reply (or the relay's closing ack) counts only if the server stamped it by the deadline; a
// later one is reported "replied late" and fails the pair.
// Rings: pings to one recipient go out back to back (0.5 s apart), so normally one ring per recipient (the others
// coalesce); if the agent polls between the two sends, one ring per ping. The replies land in the senders' inboxes like
// any mail and ring them as usual, and each relay hop rings its recipient: worst case for a three-agent run with
// --relay, 2 + 2 + 1 = 5 fires of the Claude routine, under its 30/hour cap. The output counts the rings that happened
// (each recipient's own ring log). --relay adds ONE message from the first agent that carries meta.relay_to through the
// others and back (docs/recipes/relay.md). Exit 0 only if every pair replied in time (and, with --relay, the loop
// closed in time with the body unchanged); 1 otherwise; 2 on bad usage or a failed preflight. Markdown to stdout,
// progress to stderr; never prints a key. The same --run-id again resumes a run: the idempotency keys return the
// original messages, so nothing is sent twice.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const KEY_RE = /^bl_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/;
const RUN_RE = /^[A-Za-z0-9._-]{1,40}$/;
const ALLOWED = [["GET", /^\/v1\/me$/], ["POST", /^\/v1\/send$/], ["GET", /^\/v1\/thread\/[A-Za-z0-9_-]{1,64}$/], ["GET", /^\/v1\/_ring_log$/]];
const SEND_GAP_MS = 500, ACK_GRACE_POLLS = 2, REQUEST_MS = 20_000;
const FIRED = ["ok", "failed", "timeout"]; // ring_log statuses that fetched the doorbell; every other status rang nothing
const USAGE = "usage: BOTLINE_AGENTS=a,b[,…] BOTLINE_KEY_<A>=… node scripts/conformance.mjs <base-url> [--timeout-min N] [--relay] [--poll-sec S] [--run-id ID]";

const die = (msg) => { console.error(msg); process.exit(2); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const hms = (s) => `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
const span = (from, to) => (from && to ? hms(Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000))) : "-");
const clock = (t) => (t ? t.slice(11, 19) + "Z" : "-");
const tally = (rows) => Object.entries(rows.reduce((a, e) => ((a[e.status] = (a[e.status] ?? 0) + 1), a), {})).map(([s, n]) => `${s} ${n}`).join(", ");

// ---- arguments and keys
let base = null, timeoutMin = 20, pollSec = 15, relay = false, runId = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--relay") relay = true;
  else if (a === "--timeout-min") timeoutMin = Number(argv[++i]);
  else if (a === "--poll-sec") pollSec = Number(argv[++i]);
  else if (a === "--run-id") runId = argv[++i];
  else if (a.startsWith("--") || base) die(`${USAGE}\n(unexpected ${a})`);
  else base = a;
}
if (!base || !/^https?:\/\/[^/]+/.test(base)) die(USAGE);
base = base.replace(/\/+$/, "");
if (!(timeoutMin > 0)) die("--timeout-min must be a positive number of minutes");
if (!(pollSec >= 1)) die("--poll-sec must be at least 1");
runId ??= new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
if (!RUN_RE.test(runId)) die("--run-id must match [A-Za-z0-9._-]{1,40}");
const timeoutText = timeoutMin < 1 ? `${Math.round(timeoutMin * 60)} s` : `${timeoutMin} min`;

const agents = (process.env.BOTLINE_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const envName = (id) => `BOTLINE_KEY_${id.toUpperCase().replace(/-/g, "_")}`;
if (agents.length < 2 || !agents.every((a) => ID_RE.test(a)) || new Set(agents.map(envName)).size !== agents.length)
  die("BOTLINE_AGENTS must name two or more distinct agent ids, comma-separated (e.g. claude,grokbot,muse)");
const keys = {};
for (const id of agents) {
  const k = process.env[envName(id)];
  if (!k || !KEY_RE.test(k)) die(`${envName(id)} is missing or is not a bl_<8>_<32> key`);
  keys[id] = k;
}

/** The one HTTP path: a request outside ALLOWED is a bug and throws before anything is sent. Never follows a redirect.
 *  Gives up after `ms` (20 s, or the time left before the deadline). */
async function api(method, path, agent, body, ms = REQUEST_MS) {
  if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) throw new Error(`conformance.mjs refuses ${method} ${path}`);
  const headers = { authorization: `Bearer ${keys[agent]}`, "user-agent": "botline-conformance/0.1" };
  if (body) headers["content-type"] = "application/json";
  try {
    const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(ms) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, error: e?.name !== "TimeoutError" ? "network error" : ms < REQUEST_MS ? "cut off at the deadline" : "timeout" };
  }
}
const describe = (r) =>
  [r.status || r.error, r.json?.error, ...(r.json?.rejected ?? []).map((x) => `${x.id}:${x.reason}`)].filter(Boolean).join(" ");

// ---- preflight: each key is the agent it claims to be; note each doorbell as it was before the run, and the server's
// clock against ours (the deadline is compared with the server's timestamps)
const startedAt = new Date().toISOString();
const before = {};
let skewMs = null;
for (const id of agents) {
  const asked = Date.now();
  const r = await api("GET", "/v1/me", id);
  if (r.status !== 200) die(`GET /v1/me as ${id}: ${describe(r)}`);
  if (r.json?.id !== id) die(`the key in ${envName(id)} authenticates as '${r.json?.id}', not '${id}'`);
  const st = Date.parse(r.json.server_time ?? "");
  skewMs ??= Number.isFinite(st) ? st - Math.round((asked + Date.now()) / 2) : null;
  const d = r.json.doorbell ?? {};
  before[id] = { kind: d.kind ?? r.json.doorbell_kind ?? "?", state: d.state ?? "ok", fail_count: d.fail_count ?? 0 };
  if (before[id].state !== "ok")
    console.error(`warning: ${id}'s doorbell is ${before[id].state} (fail_count ${before[id].fail_count}): it will not be rung; its pings wait for its own poll`);
}
if (skewMs === null) console.error("warning: GET /v1/me has no server_time: the deadline is compared on this machine's clock");
skewMs ??= 0;
const doorbellText = (id) => before[id].kind + (before[id].state === "ok" ? "" : ` (${before[id].state})`);

// ---- the ring budget, stated before anything is sent. Worst case per agent: a ring per ping to it, per reply to its
// own pings and per relay hop it receives (the last agent also gets the first one's reply to the closing hop).
const worstRings = (id) => 2 * (agents.length - 1) + (relay ? 1 + (id === agents.at(-1) ? 1 : 0) : 0);
const doorbelled = agents.filter((id) => before[id].kind !== "none");
console.error(`note: pings to one agent go out ${SEND_GAP_MS / 1000} s apart: normally one ring per recipient; if the agent polls between ` +
  "two sends, one ring per ping. Each reply rings the ping's sender, and each relay hop its recipient. Worst case for this run: " +
  (doorbelled.length ? `${doorbelled.map((id) => `${id} (${before[id].kind}) ${worstRings(id)}`).join(", ")} rings` : "no rings (no agent has a doorbell)") +
  (doorbelled.some((id) => before[id].kind === "claude_fire") ? "; a Claude routine allows 30 fires per hour." : "."));

// ---- send: pings grouped by recipient (normally one ring each, see above), then the relay
const pairs = [];
for (const to of agents) for (const from of agents) if (from !== to) pairs.push({ from, to, name: `${from} -> ${to}` });
for (const p of pairs) {
  const r = await api("POST", "/v1/send", p.from, {
    to: [p.to], subject: `conformance ping ${runId} ${p.from}->${p.to}`, needs: "reply",
    body: `botline conformance run ${runId}: a ping from ${p.from} to ${p.to}. The normal in-thread reply is the whole test.`,
    idempotency_key: `conf-${runId}-${p.from}-${p.to}`,
  });
  if ((r.status === 200 || r.status === 201) && r.json?.message) Object.assign(p, { msg: r.json.message, resumed: r.json.duplicate === true });
  else p.sendError = describe(r);
  await sleep(SEND_GAP_MS);
}
let rl = null;
if (relay) {
  const route = [...agents, agents[0]]; // first -> second -> … -> last -> first
  rl = { first: agents[0], route, body: `conformance relay ${runId}: copy me unchanged` };
  const r = await api("POST", "/v1/send", agents[0], {
    to: [agents[1]], subject: `conformance relay ${runId}`, body: rl.body, needs: "none",
    meta: { relay_to: route.slice(2) }, idempotency_key: `conf-${runId}-relay`,
  });
  if ((r.status === 200 || r.status === 201) && r.json?.message) rl.msg = r.json.message;
  else rl.sendError = describe(r);
}
const resumed = pairs.filter((p) => p.resumed).length;
console.error(`run ${runId}: ${pairs.filter((p) => p.msg).length}/${pairs.length} ping(s) sent${resumed ? ` (${resumed} already sent earlier: resumed)` : ""}` +
  `${rl ? (rl.msg ? " + relay" : ` + relay FAILED (${rl.sendError})`) : ""}; polling threads as the senders every ${pollSec} s for up to ${timeoutText}`);

// ---- poll the threads as the senders (read-only: thread_get marks nothing read)
async function pollPair(p, ms) {
  const r = await api("GET", `/v1/thread/${p.msg.thread_id}`, p.from, undefined, ms);
  if (r.status !== 200) return void (p.pollError = describe(r));
  p.pollError = undefined;
  const msgs = r.json.messages ?? [];
  p.rcpt = msgs.find((m) => m.id === p.msg.id)?.receipts?.find((x) => x.agent === p.to) ?? p.rcpt;
  p.reply ??= msgs.find((m) => m.from === p.to);
}
async function pollRelay(ms) {
  const r = await api("GET", `/v1/thread/${rl.msg.thread_id}`, rl.first, undefined, ms);
  if (r.status !== 200) return void (rl.pollError = describe(r));
  rl.pollError = undefined;
  // The closing hop is the only message in this thread addressed to the first agent; it comes from the last one.
  rl.closing = (r.json.messages ?? []).find((m) => m.to.includes(rl.first) && m.from === rl.route.at(-2)) ?? rl.closing;
  rl.closedAt = rl.closing?.receipts?.find((x) => x.agent === rl.first)?.acked_at ?? null;
}
const waiting = () => pairs.filter((p) => p.msg && !p.reply);
const relayWaiting = () => !!(rl?.msg && !rl.closedAt);
const t0 = Date.now(), deadline = t0 + timeoutMin * 60_000;
// The same instant on the server's clock: a reply or the relay's closing ack counts only if stamped by then.
const deadlineIso = new Date(deadline + skewMs).toISOString();
const inTime = (t) => !!t && Date.parse(t) <= deadline + skewMs;
const late = (p) => !!p.reply && !inTime(p.reply.created_at);
const repliedText = (p) => `${late(p) ? "replied late:" : "replied after"} ${span(p.msg.created_at, p.reply.created_at)}${late(p) ? ` (after the ${timeoutText} timeout)` : ""}`;
let stop = false, wake = () => {};
process.on("SIGINT", () => { stop = true; console.error(`\ninterrupted: printing what is known; resume with --run-id ${runId}`); wake(); });
const nap = (ms) => new Promise((r) => { wake = r; setTimeout(r, ms); });
const elapsed = () => hms(Math.round((Date.now() - t0) / 1000));
// Checked before EVERY poll: after the deadline (or Ctrl-C) no poll starts, and a poll near it gets only the time left.
const over = () => stop || Date.now() >= deadline;
const timeLeft = () => Math.min(REQUEST_MS, Math.max(1, deadline - Date.now()));
let lastNote = 0;
poll: for (;;) {
  for (const p of waiting()) {
    if (over()) break poll;
    await pollPair(p, timeLeft());
    if (p.reply) console.error(`[${elapsed()}] ${p.name}: ${repliedText(p)}`);
  }
  if (relayWaiting()) {
    if (over()) break;
    await pollRelay(timeLeft());
    if (rl.closedAt) console.error(`[${elapsed()}] relay: loop closed after ${span(rl.msg.created_at, rl.closedAt)}`);
  }
  if (over() || (!waiting().length && !relayWaiting())) break;
  if (Date.now() - lastNote >= 60_000) {
    lastNote = Date.now();
    console.error(`[${elapsed()}] waiting for ${[...waiting().map((p) => p.name), ...(relayWaiting() ? ["relay"] : [])].join(", ")}`);
  }
  await nap(Math.min(pollSec * 1000, Math.max(0, deadline - Date.now())));
}
// The agents ack after replying: give replied-but-unacked pings a couple more polls (inside the timeout) for the acked
// column. An unacked ping does not fail the pair.
ack: for (let i = 0; i < ACK_GRACE_POLLS && !over(); i++) {
  const unacked = pairs.filter((p) => p.reply && !p.rcpt?.acked_at);
  if (!unacked.length) break;
  await nap(Math.min(pollSec * 1000, Math.max(0, deadline - Date.now())));
  for (const p of unacked) {
    if (over()) break ack;
    await pollPair(p, timeLeft());
  }
}

// ---- final reads, all in parallel, so the run ends at most one request (20 s) after the deadline: one last look at
// every pair and the relay still waiting (what it finds counts only if stamped by the deadline; it fills the table
// either way), each recipient's own ring log (read-only), and the relay thread as every agent (each sees its own hops).
const lastLook = waiting();
if (lastLook.length || relayWaiting())
  console.error(`[${elapsed()}] ${stop ? "interrupted" : `deadline (${timeoutText})`}: one last read of ${[...lastLook.map((p) => p.name), ...(relayWaiting() ? ["relay"] : [])].join(", ")}`);
const ringLogs = {}, relayViews = {};
await Promise.all([
  ...lastLook.map((p) => pollPair(p)),
  ...(relayWaiting() ? [pollRelay()] : []),
  ...agents.map(async (id) => {
    const r = await api("GET", "/v1/_ring_log", id);
    ringLogs[id] = r.status === 200 ? r.json.entries ?? [] : null;
  }),
  ...(rl?.msg ? agents.map(async (id) => {
    const r = await api("GET", `/v1/thread/${rl.msg.thread_id}`, id);
    if (r.status === 200) relayViews[id] = r.json.messages ?? [];
  }) : []),
]);
for (const p of lastLook) if (p.reply) console.error(`[${elapsed()}] ${p.name}: ${repliedText(p)} (seen in the last read)`);
// Merge every agent's view of the relay thread; a sender's view carries all recipients' receipts.
const byId = new Map();
for (const id of agents)
  for (const m of relayViews[id] ?? []) {
    const known = byId.get(m.id);
    if (!known || m.from === id) byId.set(m.id, m);
  }
const relayMsgs = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

const idsOf = (e) => { try { return JSON.parse(e.message_ids ?? "[]"); } catch { return []; } };
const ringFor = (agent, msgId) => {
  if (!ringLogs[agent]) return "?";
  const e = ringLogs[agent].find((x) => idsOf(x).includes(msgId));
  return e ? `${e.status}${e.http_status ? ` ${e.http_status}` : ""}${e.detail ? ` (${e.detail})` : ""}` : "-";
};

// ---- the §3A table and verdicts
const out = [];
out.push(`## botline conformance run ${runId}`, "");
out.push(`Base \`${base}\`, started ${startedAt}, timeout ${timeoutText} (deadline ${deadlineIso}, server clock), thread polls every ${pollSec} s. ` +
  "Doorbells before the run: " + agents.map((id) => `${id} ${doorbellText(id)}`).join(", ") + ". Times are the server's; accepted, read and acked are " +
  "measured from sent; wall time is sent to the reply; a reply stamped after the deadline is marked late and fails its pair. Human clicks: fill in by hand.", "");
out.push("| run | hop | doorbell before | ring | sent | ring accepted | read | acked | replied | wall time | human clicks |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const p of pairs) {
  const sent = p.msg?.created_at, rc = p.rcpt ?? {};
  out.push(`| ${runId} | ${p.name} | ${doorbellText(p.to)} | ${p.msg ? ringFor(p.to, p.msg.id) : "-"} | ${clock(sent)} | ` +
    `${before[p.to].kind === "none" ? "-" : span(sent, rc.delivered_at)} | ${span(sent, rc.read_at)} | ${span(sent, rc.acked_at)} | ` +
    `${clock(p.reply?.created_at)}${late(p) ? " (late)" : ""} | ${span(sent, p.reply?.created_at)} |  |`);
}
out.push("");
const verdict = (p) => {
  if (!p.msg) return `FAIL: the ping was not sent (${p.sendError})`;
  const rc = p.rcpt ?? {}, ring = ringFor(p.to, p.msg.id);
  const how = before[p.to].kind === "none" ? "poll agent" : `doorbell ${ring}${rc.delivered_at ? `, accepted after ${span(p.msg.created_at, rc.delivered_at)}` : ""}`;
  if (p.reply && !late(p)) return `PASS: ${repliedText(p)} (${how})${rc.acked_at ? "" : "; the ping was not acked"}`;
  if (p.reply) return `FAIL: ${repliedText(p)}; ${how}`;
  const where = !rc.read_at ? "never read" : `read after ${span(p.msg.created_at, rc.read_at)}, no reply${rc.acked_at ? " (acked)" : ""}`;
  return `FAIL: no reply ${stop ? "before the interrupt" : `within ${timeoutText}`}: ${where} (${how})${p.pollError ? `; last poll: ${p.pollError}` : ""}`;
};
for (const p of pairs) out.push(`- ${p.name}: ${verdict(p)}`);
const replied = pairs.filter((p) => p.reply && !late(p)).length, lateCount = pairs.filter(late).length;

// ---- relay
let relayOk = true;
if (rl) {
  out.push("", `### Relay ${runId}: ${rl.route.join(" -> ")}${rl.msg ? ` (thread \`${rl.msg.thread_id}\`)` : ""}`, "");
  if (!rl.msg) {
    relayOk = false;
    out.push(`- relay: FAIL: the first message was not sent (${rl.sendError})`);
  } else {
    out.push("| hop (from -> to) | sent | doorbell | delivered_at | read_at | acked_at | sent->read | sent->acked | human clicks |");
    out.push("|---|---|---|---|---|---|---|---|---|");
    for (const m of relayMsgs)
      for (const to of m.to) {
        const rc = m.receipts?.find((x) => x.agent === to) ?? {};
        out.push(`| ${m.hop_count} ${m.from} -> ${to} | ${m.created_at} | ${ringFor(to, m.id)} | ${rc.delivered_at ?? "-"} | ${rc.read_at ?? "-"} | ` +
          `${rc.acked_at ?? "-"} | ${span(m.created_at, rc.read_at)} | ${span(m.created_at, rc.acked_at)} |  |`);
      }
    // Every hop of the route must exist and carry the original body (relaying is a mechanical copy).
    const hops = rl.route.slice(0, -1).map((from, i) => relayMsgs.find((m) => m.from === from && m.to.includes(rl.route[i + 1])));
    const missing = hops.findIndex((m) => !m), changed = hops.findIndex((m) => m && m.body !== rl.body);
    const bodyText = missing >= 0 ? `hop ${missing} (${rl.route[missing]} -> ${rl.route[missing + 1]}) not seen`
      : changed >= 0 ? `BODY CHANGED at hop ${changed}` : `body unchanged across ${hops.length} relay hops`;
    const closed = inTime(rl.closedAt);
    relayOk = closed && missing < 0 && changed < 0;
    const how = closed ? `loop closed after ${span(rl.msg.created_at, rl.closedAt)} (${rl.first} acked the last hop)`
      : rl.closedAt ? `loop closed late: ${span(rl.msg.created_at, rl.closedAt)} (after the ${timeoutText} timeout)`
      : `${rl.closing ? `the last hop reached ${rl.first} but was not acked` : "the loop did not close"} ${stop ? "before the interrupt" : `within ${timeoutText}`}`;
    out.push("", `- relay: ${relayOk ? "PASS" : "FAIL"}: ${how}; ${bodyText}`);
  }
}

// ---- doorbell rings: each agent's own ring-log rows (its last 100) that name a message of this run
const runMsgIds = new Set([...pairs.flatMap((p) => [p.msg?.id, p.reply?.id]), ...relayMsgs.map((m) => m.id)].filter(Boolean));
out.push("", `### Doorbell rings ${runId}`, "", "Each agent's own ring-log rows that name a message of this run (pings, replies, relay hops). A ring " +
  "fetched the doorbell (ok, failed, timeout); the other rows rang nothing. Normally one ring per recipient for its pings (one per ping if " +
  "it polled between two sends), plus one per reply to its own pings and per relay hop it received; worst case as stated before the run.", "");
out.push("| agent | doorbell before | rings | rows that rang nothing | worst case |", "|---|---|---|---|---|");
for (const id of agents) {
  const rows = ringLogs[id]?.filter((e) => idsOf(e).some((m) => runMsgIds.has(m)));
  const fired = rows?.filter((e) => FIRED.includes(e.status)), quiet = rows?.filter((e) => !FIRED.includes(e.status));
  out.push(`| ${id} | ${doorbellText(id)} | ${rows ? `${fired.length}${fired.length ? ` (${tally(fired)})` : ""}` : "? (ring log not read)"} | ` +
    `${rows ? tally(quiet) || "-" : "?"} | ${before[id].kind === "none" ? "-" : worstRings(id)} |`);
}

const ok = replied === pairs.length && relayOk;
out.push("", `Result: ${replied}/${pairs.length} pairs replied by the deadline${lateCount ? ` (${lateCount} more replied late)` : ""}` +
  `${rl ? `; relay ${relayOk ? "closed" : "FAILED"}` : ""}. ${ok ? "PASS" : "FAIL"}.`);
console.log(out.join("\n"));
process.exit(ok ? 0 : 1);
