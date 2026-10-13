// Ring policy (plan §2 rule 6, §3B.3): hop ceiling, one in-flight ring per agent (lease), terminal on
// 2xx / non-2xx / timeout (never retried by itself). Destination pin + secret decryption fail closed before any fetch.
// Backoff + dead-letter: a ring that ends failed / timeout / error turns the lease into a backoff lease, so no send
// rings the agent again until min(10 min x 2^(fail_count-1), 6 h) has passed; at DEAD_AT consecutive failures every
// ring is logged dead_letter without a fetch until scripts/doorbell-set.mjs resets fail_count. A 2xx resets it.
// Core holds no vendor logic: adapters do (including which destinations they accept).
import type { AgentRow, Env, Message } from "./store";
import { openSecret } from "./secrets";
import * as claude_fire from "./adapters/claude_fire";
import * as generic_webhook from "./adapters/generic_webhook";
import * as grokbot_webhook from "./adapters/grokbot_webhook";
import * as none from "./adapters/none";

export const HOP_CEILING = 8;
const LEASE_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;
export const BACKOFF_BASE_MIN = 10;
export const BACKOFF_CAP_MIN = 6 * 60;
export const DEAD_AT = 5;

export interface RingPayload { agent: string; unread: number; message_ids: string[] }
export interface RingResult { status: "ok" | "failed" | "timeout" | "no_doorbell"; httpStatus?: number }
/** What an adapter rings: the URL and the decrypted secret (adapters never see the stored form). */
export interface Destination { url: string; secret: string | null }
export type Adapter = (dest: Destination, payload: RingPayload, signal: AbortSignal) => Promise<RingResult>;
interface AdapterModule { ring: Adapter; allows: (url: URL, env: Env) => boolean }

const ADAPTERS: Record<string, AdapterModule> = { claude_fire, grokbot_webhook, generic_webhook, none };

const iso = (ms: number) => new Date(ms).toISOString();

/** `detail` is the reason on an error / failed / timeout row (no_master_key, decrypt_failed, http 401, timeout, …). Rows
 *  without one use the pre-`detail` column list, so a Worker deployed before migrate.mjs still logs every other outcome. */
function logStmt(env: Env, ws: string, agent: string, kind: string | null, status: string, ids: string[], http?: number, detail?: string) {
  const v = [ws, agent, kind, status, http ?? null, JSON.stringify(ids), iso(Date.now())];
  return detail
    ? env.DB.prepare("INSERT INTO ring_log (workspace_id, agent, kind, status, http_status, message_ids, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(...v, detail)
    : env.DB.prepare("INSERT INTO ring_log (workspace_id, agent, kind, status, http_status, message_ids, at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(...v);
}

/** Called via ctx.waitUntil after a send commits. Never throws. */
export async function ringRecipients(env: Env, msg: Message): Promise<void> {
  await Promise.all(
    msg.to.map((id) =>
      ringOne(env, msg, id).catch((e) => {
        console.error("ring error", id, e); // the exception itself stays in the Worker log, not in ring_log
        return logStmt(env, msg.workspace_id, id, null, "error", [msg.id], undefined, "exception").run().catch(() => undefined);
      }),
    ),
  );
}

async function ringOne(env: Env, msg: Message, agentId: string): Promise<void> {
  const ws = msg.workspace_id;
  const agent = await env.DB.prepare("SELECT * FROM agents WHERE workspace_id = ? AND id = ?")
    .bind(ws, agentId)
    .first<AgentRow>();
  if (!agent) return;
  const kind = agent.doorbell_kind;
  const log = (status: string, ids = [msg.id], http?: number, detail?: string) => logStmt(env, ws, agentId, kind, status, ids, http, detail);

  // 1. Hop ceiling: deliver, never ring.
  if (msg.hop_count > HOP_CEILING) return void (await log("hop_ceiling").run());
  // 2. Poll-only agent.
  const adapter = ADAPTERS[kind];
  if (kind === "none" || !agent.doorbell_url || !adapter) return void (await log("no_doorbell").run());

  // 3. Coalesce: claim the lease atomically. RETURNING yields a row only if we inserted, or updated an
  //    expired/cleared lease of an agent that is not dead-lettered. Otherwise nothing is fetched, and the log says why:
  //    dead_letter (DEAD_AT failures), backoff (a failure's lease: no ring in flight) or coalesced (a ring in flight).
  const t = Date.now();
  const claimed = await env.DB.prepare(
    `INSERT INTO rings (workspace_id, agent, in_flight_since, lease_until, last_status, last_at)
     VALUES (?1, ?2, ?3, ?4, 'ringing', ?3)
     ON CONFLICT (workspace_id, agent) DO UPDATE SET
       in_flight_since = excluded.in_flight_since, lease_until = excluded.lease_until,
       last_status = 'ringing', last_at = excluded.last_at
     WHERE (rings.lease_until IS NULL OR rings.lease_until <= ?3) AND rings.fail_count < ?5
     RETURNING agent`,
  ).bind(ws, agentId, iso(t), iso(t + LEASE_MS), DEAD_AT).first();
  if (!claimed) {
    const s = await env.DB.prepare("SELECT in_flight_since, fail_count FROM rings WHERE workspace_id = ? AND agent = ?")
      .bind(ws, agentId).first<{ in_flight_since: string | null; fail_count: number }>();
    const why = !s ? "coalesced" : s.fail_count >= DEAD_AT ? "dead_letter" : s.fail_count > 0 && !s.in_flight_since ? "backoff" : "coalesced";
    return void (await log(why).run());
  }

  const unread = await env.DB.prepare(
    `SELECT r.message_id AS id FROM receipts r JOIN messages m ON m.id = r.message_id
     WHERE r.workspace_id = ?1 AND r.agent = ?2 AND r.read_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > ?3)
     ORDER BY m.created_at LIMIT 100`,
  ).bind(ws, agentId, iso(t)).all<{ id: string }>();
  const ids = unread.results.map((r) => r.id);
  if (ids.length === 0) {
    // The agent drained between send and ring: release the lease, wake nobody. Every release below is guarded by
    // in_flight_since = this claim's stamp: an inbox poll may have cleared our lease and a newer ring may own a fresh
    // one, and an unguarded release would let a third ring start while that one is still in flight.
    await env.DB.batch([
      env.DB.prepare("UPDATE rings SET in_flight_since = NULL, lease_until = NULL WHERE workspace_id = ? AND agent = ? AND in_flight_since = ?").bind(ws, agentId, iso(t)),
      log("nothing_unread"),
    ]);
    return;
  }

  // A failed / timeout / error ring: count it and turn our lease into a backoff lease (no ring in flight, so
  // in_flight_since = NULL, which also keeps an inbox poll from lifting it). Guarded like every release: if an inbox
  // poll already cleared our lease and a newer ring owns a fresh one, this write must not touch it (the failure is then
  // not counted). SET expressions read the old row: backoff = min(BASE << old fail_count, CAP) minutes from now.
  // lastStatus goes to rings.last_status (as before); detail goes on this ring_log row, so the reason outlives the next ring.
  const fail = (status: string, lastStatus: string, detail: string, http?: number) => {
    const at = iso(Date.now());
    return env.DB.batch([
      env.DB.prepare(
        `UPDATE rings SET in_flight_since = NULL, fail_count = fail_count + 1, last_status = ?1, last_at = ?2,
           lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || min(?3 << min(fail_count, 20), ?4) || ' minutes')
         WHERE workspace_id = ?5 AND agent = ?6 AND in_flight_since = ?7`,
      ).bind(lastStatus, at, BACKOFF_BASE_MIN, BACKOFF_CAP_MIN, ws, agentId, iso(t)),
      log(status, ids, http, detail),
    ]);
  };

  // 4. Fail closed before any fetch. A destination the adapter does not accept: release the lease (fixing the URL or
  //    the allowlist lets the next send ring; nothing was fetched, so nothing backs off). A secret we cannot decrypt:
  //    an `error` ring, which backs off like a failed one. The reason goes to rings.last_status either way.
  let url: URL | null = null;
  try { url = new URL(agent.doorbell_url); } catch { /* blocked below */ }
  if (!url || !adapter.allows(url, env)) {
    await env.DB.batch([
      env.DB.prepare("UPDATE rings SET in_flight_since = NULL, lease_until = NULL, last_status = ?, last_at = ? WHERE workspace_id = ? AND agent = ? AND in_flight_since = ?")
        .bind("blocked_destination", iso(Date.now()), ws, agentId, iso(t)),
      log("blocked_destination", ids),
    ]);
    return;
  }
  const opened = await openSecret(agent.doorbell_secret, env.DOORBELL_MASTER_KEY, `${ws}/${agentId}`);
  if (!opened.ok) return void (await fail("error", opened.reason, opened.reason));

  // 5. Ring once with a 15 s timeout. Terminal either way. On ok the lease stays until the agent drains or it expires,
  //    and fail_count resets — but only if this ring still owns the row, or the row is idle (an inbox poll cleared our
  //    lease and nothing newer claimed). A newer ring's stamp, or a newer failure's backoff lease, must survive: a slow
  //    2xx from an older ring would otherwise erase a dead-letter state.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: RingResult;
  try {
    res = await adapter.ring({ url: url.toString(), secret: opened.secret }, { agent: agentId, unread: ids.length, message_ids: ids }, ac.signal);
  } finally {
    clearTimeout(timer);
  }
  if (res.status !== "ok") {
    const detail = res.httpStatus ? `http ${res.httpStatus}` : res.status === "failed" ? "network_error" : res.status;
    return void (await fail(res.status, res.status, detail, res.httpStatus));
  }
  const at = iso(Date.now());
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE rings SET last_status = 'ok', last_at = ?1, fail_count = 0 WHERE workspace_id = ?2 AND agent = ?3
         AND (in_flight_since = ?4 OR (in_flight_since IS NULL AND lease_until IS NULL))`,
    ).bind(at, ws, agentId, iso(t)),
    log(res.status, ids, res.httpStatus),
    env.DB.prepare(
      `UPDATE receipts SET delivered_at = ?1 WHERE workspace_id = ?2 AND agent = ?3 AND delivered_at IS NULL
       AND message_id IN (SELECT value FROM json_each(?4))`,
    ).bind(at, ws, agentId, JSON.stringify(ids)),
  ]);
}

/** The doorbell's health as `me` reports it. dead: DEAD_AT consecutive failures (doorbell-set resets). backoff: a
 *  failure's lease is live, so a send now is logged `backoff` and not rung before next_ring_after. ok: otherwise. */
export function doorbellState(kind: string, r: { in_flight_since?: string | null; lease_until?: string | null; fail_count?: number } | null) {
  const fail_count = r?.fail_count ?? 0;
  const backoff = fail_count > 0 && fail_count < DEAD_AT && !r?.in_flight_since && !!r?.lease_until && r.lease_until > iso(Date.now());
  const state = fail_count >= DEAD_AT ? "dead" : backoff ? "backoff" : "ok";
  return { kind, state, fail_count, next_ring_after: backoff ? r!.lease_until! : null };
}
