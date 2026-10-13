#!/usr/bin/env node
// Test aid for scripts/conformance-selftest.sh, never for a real deployment: it PLAYS the agents in BOTLINE_AGENTS
// (keys from BOTLINE_KEY_<ID>, as conformance.mjs) against a LOCAL botline. Every --interval-ms it reads each agent's
// unread inbox (which claims the mail), forwards per the relay rule (docs/recipes/relay.md), replies in-thread to
// `needs: reply`, and acks. --silent a,b: agents it never touches (an agent that neither polls nor replies).
// --slow a=S[,b=S]: those agents read on time but answer (relay or reply, then ack) S seconds after reading.
// --front-delay-ms N: also serve a slow front for conformance.mjs on 127.0.0.1 (a free port, printed to stdout as
// `front http://127.0.0.1:<port>`) that forwards every request to the base unchanged, but holds each GET /v1/thread/*
// for N ms first, as a slow server would; a request its client gave up on meanwhile is not forwarded.
//   node scripts/conformance-sim.mjs <local-base-url> [--interval-ms N] [--silent a,b] [--slow a=S] [--front-delay-ms N]
//   (runs until killed)
import { createServer } from "node:http";

const die = (msg) => { console.error(msg); process.exit(2); };
const argv = process.argv.slice(2);
let base = null, interval = 1000, silent = [], slow = {}, frontMs = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--interval-ms") interval = Number(argv[++i]);
  else if (argv[i] === "--silent") silent = (argv[++i] ?? "").split(",").filter(Boolean);
  else if (argv[i] === "--slow") slow = Object.fromEntries((argv[++i] ?? "").split(",").filter(Boolean).map((kv) => [kv.split("=")[0], Number(kv.split("=")[1])]));
  else if (argv[i] === "--front-delay-ms") frontMs = Number(argv[++i]);
  else if (!base && !argv[i].startsWith("--")) base = argv[i].replace(/\/+$/, "");
  else die(`unexpected ${argv[i]}`);
}
if (!base || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) die("conformance-sim.mjs reads inboxes: local http://127.0.0.1:<port> bases only");
if (!Object.values(slow).every((s) => s >= 0)) die("--slow takes agent=seconds[,agent=seconds]");
if (frontMs !== null && !(frontMs >= 0)) die("--front-delay-ms takes a number of milliseconds");
const agents = (process.env.BOTLINE_AGENTS ?? "").split(",").map((s) => s.trim()).filter((a) => a && !silent.includes(a));
const key = (id) => process.env[`BOTLINE_KEY_${id.toUpperCase().replace(/-/g, "_")}`];
if (!agents.length || !agents.every(key)) die("set BOTLINE_AGENTS and BOTLINE_KEY_<ID> for each agent");

const call = async (id, method, path, body) => {
  const res = await fetch(base + path, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${key(id)}`, ...(body ? { "content-type": "application/json" } : {}) },
  });
  return res.json();
};

async function answer(id, m) {
  const next = Array.isArray(m.meta?.relay_to) ? m.meta.relay_to : [];
  if (next.length) {
    const [to, ...rest] = next;
    await call(id, "POST", "/v1/send", {
      to: [to], subject: m.subject, body: m.body, thread_id: m.thread_id, meta: { relay_to: rest },
      needs: rest.length ? "none" : "reply", idempotency_key: `relay-${m.id}`,
    });
    console.error(`sim: ${id} relayed ${m.id} to ${to}`);
  } else if (m.needs === "reply") {
    await call(id, "POST", "/v1/send", {
      to: [m.from], subject: `re: ${m.subject}`, body: `pong from ${id}`, thread_id: m.thread_id, idempotency_key: `reply-${m.id}`,
    });
    console.error(`sim: ${id} replied to ${m.id} from ${m.from}`);
  }
  await call(id, "POST", "/v1/ack", { id: m.id });
}

async function handle(id) {
  const inbox = await call(id, "GET", "/v1/inbox?unread=1");
  for (const m of inbox.messages ?? []) {
    if (!slow[id]) await answer(id, m);
    else setTimeout(() => answer(id, m).catch((e) => console.error(`sim: ${id}: ${e.message}`)), slow[id] * 1000).unref();
  }
}

let front = null;
if (frontMs !== null) {
  front = createServer(async (req, res) => {
    let gone = false;
    res.on("close", () => { gone = true; });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.method === "GET" && req.url.startsWith("/v1/thread/")) await new Promise((r) => setTimeout(r, frontMs));
    if (gone) return;
    const headers = Object.fromEntries(["authorization", "content-type", "user-agent"].filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
    try {
      const up = await fetch(base + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" });
      const body = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" }).end(body);
    } catch {
      if (!gone) res.writeHead(502).end();
    }
  });
  front.listen(0, "127.0.0.1", () => console.log(`front http://127.0.0.1:${front.address().port}`));
}

let running = true;
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { running = false; front?.close(); front?.closeAllConnections(); });
while (running) {
  for (const id of agents) await handle(id).catch((e) => console.error(`sim: ${id}: ${e.message}`));
  await new Promise((r) => setTimeout(r, interval));
}
