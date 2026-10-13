// botline router + auth. REST under /v1, MCP at POST /mcp. Workspace is always 'default' in Phase 1
// (it comes from the authenticated agent row, so every query is already scoped through it).
import { handleMcp, rpcError } from "./mcp";
import { docsHtml, openapi } from "./openapi";
import * as store from "./store";
import { ApiError, isObj, VERSION, type Env } from "./store";
import { handleWaitlist } from "./waitlist";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unauthorized = () => json({ error: "unauthorized", message: "Authorization: Bearer bl_<8>_<32> required" }, 401);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 256 * 1024) throw new ApiError(413, "payload_too_large");
  let v: unknown;
  try { v = JSON.parse(text || "{}"); } catch { throw new ApiError(400, "bad_request", { message: "body must be JSON" }); }
  if (!isObj(v)) throw new ApiError(400, "bad_request", { message: "body must be a JSON object" });
  return v;
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method;

  if (path === "/") return json({ name: "botline", version: VERSION, rest: "/v1", mcp: "/mcp", docs: "/docs", openapi: "/openapi.json" });
  // Public docs: what a connector builder (e.g. Muse's custom connector) reads to use the REST API. The server URL in
  // both is this request's origin, so a self-hosted deployment documents itself.
  if (path === "/openapi.json" && method === "GET") return json(openapi(url.origin));
  if (path === "/docs" && method === "GET")
    return new Response(docsHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
  // Hosted-interest waitlist: public pages and POST /v1/waitlist, no key (src/waitlist.ts).
  const wl = await handleWaitlist(req, env, ctx, url, path);
  if (wl) return wl;

  if (path === "/mcp") {
    // We never push: no GET stream, no sessions to DELETE.
    if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    // DNS-rebinding guard: an Origin header, if present, must be our own (or explicitly allowed).
    const origin = req.headers.get("origin");
    const extra = (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (origin && origin !== url.origin && !extra.includes(origin))
      return rpcError(null, -32600, `Forbidden origin: ${origin}`, 403);
    const me = await store.authenticate(env, req);
    return me ? handleMcp(req, env, ctx, me) : unauthorized();
  }

  // Test doorbell target for check.sh: exists only when ECHO_SECRET is set, and records only rings carrying it.
  if (path === "/v1/_echo" || path === "/v1/_echo/hits") {
    if (!env.ECHO_SECRET) return json({ error: "not_found" }, 404);
    if (path === "/v1/_echo" && method === "POST") {
      if (req.headers.get("authorization") !== `Bearer ${env.ECHO_SECRET}`) return unauthorized();
      return json(await store.echoRecord(env, req));
    }
  }
  if (!path.startsWith("/v1/")) return json({ error: "not_found" }, 404);

  const me = await store.authenticate(env, req);
  if (!me) return unauthorized();

  switch (`${method} ${path}`) {
    case "GET /v1/me":
      return json(await store.me(env, me));
    case "GET /v1/agents":
      return json(await store.agentsList(env, me));
    case "POST /v1/send": {
      const r = await store.send(env, me, await readJson(req), (p) => ctx.waitUntil(p));
      return json(r, r.duplicate ? 200 : 201);
    }
    case "GET /v1/inbox": // unread defaults to true (same as MCP); unread=0 lists all
      return json(await store.inbox(env, me, { unread: url.searchParams.get("unread") !== "0", since: url.searchParams.get("since") }));
    case "POST /v1/ack":
      return json(await store.ack(env, me, await readJson(req)));
    case "POST /v1/key/rotate": // the new key is in this body once; never log it
      return new Response(JSON.stringify(await store.keyRotate(env, me)), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    case "GET /v1/_echo/hits":
      return json(await store.echoHits(env));
    case "GET /v1/_ring_log":
      return json(await store.ringLog(env, me));
  }
  if (method === "GET" && path.startsWith("/v1/thread/"))
    return json(await store.thread(env, me, decodeURIComponent(path.slice("/v1/thread/".length))));
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, ...e.detail }, e.status);
      console.error("unhandled", e);
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
