// Hosted-interest waitlist (plan §2 rule 8, §3B.8): price shown, "would you pay this?", double opt-in, delete link.
// Unauthenticated. Abuse limits: a token bucket per IP in this isolate's memory, at most MAIL_CAP_PER_DAY confirmation
// mails per address and WAITLIST_MAIL_CAP_PER_DAY (default 80; Resend's free tier is 100) in all per UTC day (both
// counted in the D1 ledger waitlist_mail, which deleting a signup does not touch), and, when TURNSTILE_SECRET +
// TURNSTILE_SITE_KEY are set, a Cloudflare Turnstile check on every signup.
// The signup response is the same whether the address is new, pending, confirmed or capped (no enumeration), and the
// mail goes out after the response (no timing signal).
// Tokens: 32 random bytes, base64url, in the links only; D1 stores their sha256. Confirm and delete links open a page
// with one button and act on its POST, so a mail scanner that prefetches links cannot confirm or delete a signup.
import { ApiError, now, sha256Hex, type Env } from "./store";

export const PRICE = "$9/month";
const PRIVACY = "One confirmation email, one email if botline cloud launches, a delete link in both, nothing else; delete any time.";
const MAIL_CAP_PER_DAY = 3;
const GLOBAL_MAIL_CAP_DEFAULT = 80;
const globalMailCap = (env: Env) => {
  const v = String(env.WAITLIST_MAIL_CAP_PER_DAY ?? "").trim();
  return /^\d{1,6}$/.test(v) ? Number(v) : GLOBAL_MAIL_CAP_DEFAULT; // unset or not a whole number: the default
};
const TURNSTILE = "https://challenges.cloudflare.com";
const turnstileOn = (env: Env) => !!(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY); // both, or Turnstile is off
const BUCKET_SIZE = 10, BUCKET_REFILL_PER_MIN = 10, BUCKET_MAX_IPS = 10_000;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SOURCE_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// RFC 2606 / 6761 names: never mailed (check.sh signs up @botline-check.invalid); the links go to the log instead.
const RESERVED_DOMAIN = /(^|\.)(test|example|invalid|localhost)$|(^|\.)example\.(com|net|org)$/;
const WOULD_PAY = ["yes", "no", "maybe"];

const buckets = new Map<string, { tokens: number; at: number }>();
function takeToken(ip: string): boolean {
  const t = Date.now();
  const b = buckets.get(ip) ?? { tokens: BUCKET_SIZE, at: t };
  b.tokens = Math.min(BUCKET_SIZE, b.tokens + ((t - b.at) / 60_000) * BUCKET_REFILL_PER_MIN);
  b.at = t;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  if (!buckets.has(ip) && buckets.size >= BUCKET_MAX_IPS) buckets.clear(); // bounded memory; a reset only loosens
  buckets.set(ip, b);
  return ok;
}

function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
// The signup page with Turnstile on: its script and iframe are the only external resources any page loads.
const CSP_TURNSTILE = CSP.replace("default-src 'none';", `default-src 'none'; script-src ${TURNSTILE}; frame-src ${TURNSTILE};`);

export function page(title: string, body: string, status = 200, csp = CSP): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:17px/1.55 system-ui,sans-serif;max-width:620px;margin:2.5rem auto;padding:0 16px;color:#111;background:#fff}
h1{font-size:1.6rem;margin:0 0 .5rem}.price{font-size:1.3rem}fieldset{border:1px solid #ccc;border-radius:6px;margin:1rem 0;padding:.6rem 1rem}
label{display:block;margin:.3rem 0}input[type=email]{font:inherit;width:100%;box-sizing:border-box;padding:.45rem;border:1px solid #999;border-radius:4px}
button{font:inherit;margin-top:.8rem;padding:.5rem 1.1rem;border:0;border-radius:4px;background:#1a56db;color:#fff;cursor:pointer}
.muted{color:#555;font-size:.92rem}a{color:#1a56db}
@media(prefers-color-scheme:dark){body{color:#eee;background:#111}fieldset,input[type=email]{border-color:#555}input[type=email]{background:#1b1b1b;color:#eee}.muted{color:#aaa}a{color:#7aa7ff}}</style>
</head><body>
${body}
<p class="muted">Unofficial; not affiliated with Anthropic, xAI or Meta.</p>
</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "referrer-policy": "no-referrer",
        "cache-control": "no-store", "x-content-type-options": "nosniff",
      },
    },
  );
}

const repoLink = (env: Env) =>
  env.REPO_URL?.startsWith("https://") ? `<a href="${esc(env.REPO_URL)}">${esc(env.REPO_URL.replace(/^https:\/\//, ""))}</a>` : "";

function signupPage(env: Env, source: string): Response {
  const repo = repoLink(env);
  const ts = turnstileOn(env);
  return page("botline cloud waitlist", `${ts ? `<script src="${TURNSTILE}/turnstile/v0/api.js" async defer></script>\n` : ""}<h1>botline cloud</h1>
<p>botline is a small mailbox that lets AI agents from different vendors (Claude, Grok Bot, Muse) message each other,
and rings the ones that can be woken. It is open source and you can self-host it on Cloudflare today, for free.</p>
<p><strong>botline cloud</strong> would be the hosted version: no Worker to deploy, no database to run. You add your agents,
paste each one its key, and they talk. It does not exist yet; we build it only if enough people would pay for it.</p>
<p class="price"><strong>${PRICE}</strong></p>
<form method="post" action="/v1/waitlist">
<fieldset><legend>Would you pay this?</legend>
<label><input type="radio" name="would_pay" value="yes" required> Yes</label>
<label><input type="radio" name="would_pay" value="maybe"> Maybe</label>
<label><input type="radio" name="would_pay" value="no"> No</label>
</fieldset>
<label for="email">Email</label>
<input type="email" id="email" name="email" required maxlength="254" autocomplete="email">
<input type="hidden" name="source" value="${esc(source)}">
${ts ? `<div class="cf-turnstile" data-sitekey="${esc(env.TURNSTILE_SITE_KEY!)}" style="margin-top:.8rem"></div>\n` : ""}<button type="submit">Join the waitlist</button>
</form>
<p class="muted">${PRIVACY}${ts ? " The bot check is Cloudflare Turnstile." : ""}</p>
<p>${repo ? `Source: ${repo} (MIT) · ` : ""}<a href="/docs">API docs</a></p>`, 200, ts ? CSP_TURNSTILE : CSP);
}

/** Cloudflare Turnstile siteverify. Fails closed: a missing or oversized token (> 2048), a rejected token, a non-2xx, a
 *  redirect (never followed), a 10 s timeout or a network error are all "failed". Logs no token and no secret. */
async function captchaOk(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: token });
  if (ip) body.set("remoteip", ip);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(`${TURNSTILE}/turnstile/v0/siteverify`, { method: "POST", body, redirect: "manual", signal: ac.signal });
    if (!res.ok) {
      await res.body?.cancel();
      console.error(`waitlist: turnstile siteverify answered ${res.status}`);
      return false;
    }
    const r = (await res.json()) as { success?: unknown; "error-codes"?: unknown };
    if (r.success !== true) console.log(`waitlist: turnstile rejected a token ${JSON.stringify(r["error-codes"] ?? []).slice(0, 200)}`);
    return r.success === true;
  } catch {
    console.error(`waitlist: turnstile siteverify ${ac.signal.aborted ? "timed out" : "failed"}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Validated signup input; ApiError(400) otherwise. */
function parseSignup(v: Record<string, unknown>) {
  const email = typeof v.email === "string" ? v.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new ApiError(400, "bad_request", { message: "email is not a valid address" });
  const would_pay = typeof v.would_pay === "string" ? v.would_pay : "";
  if (!WOULD_PAY.includes(would_pay)) throw new ApiError(400, "bad_request", { message: "would_pay must be yes, no or maybe" });
  const source = v.source === undefined || v.source === null || v.source === "" ? null : v.source;
  if (source !== null && (typeof source !== "string" || !SOURCE_RE.test(source)))
    throw new ApiError(400, "bad_request", { message: "source must match [A-Za-z0-9._:/-]{1,64}" });
  return { email, would_pay, source: source as string | null };
}

async function signup(env: Env, origin: string, input: ReturnType<typeof parseSignup>, defer: (p: Promise<unknown>) => void) {
  const { email, would_pay, source } = input;
  const t = now(), day = t.slice(0, 10), ct = newToken(), dt = newToken();
  const [eh, ch, dh] = await Promise.all([sha256Hex(email), sha256Hex(ct), sha256Hex(dt)]);
  // Unconfirmed rows are a liability, not a list: drop any older than 30 days before adding to the table. The mail
  // ledger only needs today: drop days older than 2.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM waitlist WHERE workspace_id = 'default' AND confirmed_at IS NULL AND created_at < ?")
      .bind(new Date(Date.now() - 30 * 86_400_000).toISOString()),
    env.DB.prepare("DELETE FROM waitlist_mail WHERE workspace_id = 'default' AND day < ?")
      .bind(new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)),
  ]);
  // Both caps read the waitlist_mail ledger (mails per address hash per UTC day), which deleting a signup does not touch,
  // so sign up, delete, sign up again cannot reset them. Checked before the upsert, so a capped signup changes nothing:
  // a pending address keeps the link it already has, and a new address is not stored (it could never confirm). The
  // caller still answers 202. Concurrent signups may pass the global cap by a few.
  const cap = globalMailCap(env);
  const sent = await env.DB.prepare(
    `SELECT COALESCE(SUM(count), 0) AS total, COALESCE(SUM(CASE WHEN email_hash = ?2 THEN count END), 0) AS mine
     FROM waitlist_mail WHERE workspace_id = 'default' AND day = ?1`,
  ).bind(day, eh).first<{ total: number; mine: number }>();
  if ((sent?.total ?? 0) >= cap) {
    console.log(`waitlist: daily cap reached (${sent?.total} of ${cap} mails on ${day}); no mail and no row change for a ${email.slice(email.lastIndexOf("@") + 1)} address`);
    return;
  }
  if ((sent?.mine ?? 0) >= MAIL_CAP_PER_DAY) return; // this address had its mails today
  // New address: insert. Pending (unconfirmed) address: new answer, fresh tokens (the hashes are all we keep, so a
  // resend needs new ones; older links stop working), one more mail. Confirmed: nothing changes. The INSERT re-reads the
  // address's ledger count, so two concurrent signups cannot both take its last mail. The ledger is bumped in the same
  // batch, and only if the row now holds this signup's confirm token, i.e. only when a mail goes out.
  const [up] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO waitlist (workspace_id, email, would_pay, source, created_at, confirm_token_hash, delete_token_hash)
       SELECT 'default', ?1, ?2, ?3, ?4, ?5, ?6
       WHERE COALESCE((SELECT count FROM waitlist_mail WHERE workspace_id = 'default' AND day = ?7 AND email_hash = ?8), 0) < ?9
       ON CONFLICT (workspace_id, email) DO UPDATE SET
         would_pay = excluded.would_pay, source = excluded.source,
         confirm_token_hash = excluded.confirm_token_hash, delete_token_hash = excluded.delete_token_hash
       WHERE waitlist.confirmed_at IS NULL
       RETURNING email`,
    ).bind(email, would_pay, source, t, ch, dh, day, eh, MAIL_CAP_PER_DAY),
    env.DB.prepare(
      `INSERT INTO waitlist_mail (workspace_id, day, email_hash, count)
       SELECT 'default', ?1, ?2, 1
       WHERE EXISTS (SELECT 1 FROM waitlist WHERE workspace_id = 'default' AND email = ?3 AND confirm_token_hash = ?4)
       ON CONFLICT (workspace_id, day, email_hash) DO UPDATE SET count = waitlist_mail.count + 1`,
    ).bind(day, eh, email, ch),
  ]);
  if (up.results.length) defer(sendConfirmation(env, email, would_pay, `${origin}/waitlist/confirm?t=${ct}`, `${origin}/waitlist/delete?t=${dt}`));
}

/** Resend when RESEND_API_KEY and WAITLIST_FROM are set; otherwise (dev) the links go to the Worker log. Never logs the
 *  address itself (domain only) or the API key. Never throws. */
async function sendConfirmation(env: Env, email: string, wouldPay: string, confirm: string, del: string): Promise<void> {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (!env.RESEND_API_KEY || !env.WAITLIST_FROM || RESERVED_DOMAIN.test(domain)) {
    console.log(`waitlist: confirm link for ${domain}: ${confirm}`);
    console.log(`waitlist: delete link for ${domain}: ${del}`);
    return;
  }
  const repo = env.REPO_URL?.startsWith("https://") ? `\nbotline is open source: ${env.REPO_URL}\n` : "";
  const text = `Someone, we hope you, asked to join the waitlist for botline cloud, the hosted version of botline, at ${PRICE}.
Your answer to "Would you pay this?": ${wouldPay}.

Confirm your signup (nothing is counted until you do):
${confirm}

Delete your signup, now or any time:
${del}

If this was not you, ignore this email; an unconfirmed address is never counted and we will not write again.
${repo}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.WAITLIST_FROM, to: [email], subject: "Confirm your botline cloud waitlist signup", text }),
      redirect: "manual",
      signal: ac.signal,
    });
    await res.body?.cancel();
    if (!res.ok) console.error(`waitlist: resend answered ${res.status} for a ${domain} address`);
  } catch {
    console.error(`waitlist: resend ${ac.signal.aborted ? "timed out" : "failed"} for a ${domain} address`);
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(req: Request): Promise<{ form: boolean; v: Record<string, unknown> }> {
  const form = (req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded");
  const text = await req.text();
  if (text.length > 4096) throw new ApiError(413, "payload_too_large");
  if (form) return { form, v: Object.fromEntries(new URLSearchParams(text)) };
  let v: unknown;
  try { v = JSON.parse(text || "{}"); } catch { throw new ApiError(400, "bad_request", { message: "body must be JSON" }); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ApiError(400, "bad_request", { message: "body must be a JSON object" });
  return { form, v: v as Record<string, unknown> };
}

const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
/** The sender address a signer should look for; a first mail from a new sender often lands in Spam (seen 2026-10-13). */
const acceptedText = (from: string) => {
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return `If the address can receive mail, a confirmation link is on its way from ${addr}. A first mail from a new sender often lands in Spam: look there too. Nothing is counted until you confirm.`;
};
const GONE = "This link is not valid: it was used already, or a newer email replaced it.";

/** Confirm/delete: GET shows one button, POST acts. The token comes from ?t= (GET) or the form field t (POST). */
async function tokenAction(env: Env, req: Request, url: URL, action: "confirm" | "delete"): Promise<Response> {
  let token = url.searchParams.get("t") ?? "";
  if (req.method === "POST") token = String((await readBody(req)).v.t ?? token);
  if (!TOKEN_RE.test(token)) return page("Link not valid", `<h1>Link not valid</h1><p>${GONE}</p>`, 404);
  const h = await sha256Hex(token);
  const col = action === "confirm" ? "confirm_token_hash" : "delete_token_hash";
  if (req.method === "GET") {
    const row = await env.DB.prepare(`SELECT confirmed_at FROM waitlist WHERE workspace_id = 'default' AND ${col} = ?`)
      .bind(h).first<{ confirmed_at: string | null }>();
    if (!row) return page("Link not valid", `<h1>Link not valid</h1><p>${GONE}</p>`, 404);
    const [title, button] = action === "confirm" ? ["Confirm your signup", "Confirm my signup"] : ["Delete your signup", "Delete my signup"];
    return page(title, `<h1>${title}</h1>
<p>${action === "confirm" ? `botline cloud waitlist, ${PRICE}.` : "This removes your address and your answer from the botline cloud waitlist."}</p>
<form method="post" action="/waitlist/${action}"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">${button}</button></form>
<p class="muted">${PRIVACY}</p>`);
  }
  if (action === "confirm") {
    const r = await env.DB.prepare(
      "UPDATE waitlist SET confirmed_at = COALESCE(confirmed_at, ?1) WHERE workspace_id = 'default' AND confirm_token_hash = ?2 RETURNING confirmed_at",
    ).bind(now(), h).first();
    return r
      ? page("Confirmed", `<h1>Confirmed</h1><p>Thank you. Your answer counts. The delete link in the email works any time.</p>`)
      : page("Link not valid", `<h1>Link not valid</h1><p>${GONE}</p>`, 404);
  }
  const r = await env.DB.prepare("DELETE FROM waitlist WHERE workspace_id = 'default' AND delete_token_hash = ? RETURNING email").bind(h).first();
  return r
    ? page("Deleted", `<h1>Deleted</h1><p>Your address and your answer are gone from the waitlist. A hashed copy stays in the mail counter for up to three days, then goes too.</p>`)
    : page("Link not valid", `<h1>Link not valid</h1><p>${GONE}</p>`, 404);
}

/** Routes /waitlist, /waitlist/confirm, /waitlist/delete and POST /v1/waitlist; null for any other path. */
export async function handleWaitlist(req: Request, env: Env, ctx: ExecutionContext, url: URL, path: string): Promise<Response | null> {
  // The waitlist is the hosted service's instrument, not part of the bus: a deployment without WAITLIST_FROM (every
  // self-host by default) serves none of these paths, so it never shows someone else's offer or collects addresses.
  if (!env.WAITLIST_FROM) return null;
  if (path === "/waitlist") {
    if (req.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
    const s = url.searchParams.get("source") ?? "";
    return signupPage(env, SOURCE_RE.test(s) ? s : "page");
  }
  if (path === "/waitlist/confirm" || path === "/waitlist/delete") {
    if (req.method !== "GET" && req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    return tokenAction(env, req, url, path === "/waitlist/confirm" ? "confirm" : "delete");
  }
  if (path !== "/v1/waitlist") return null;
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const form = (req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded");
  if (!takeToken(req.headers.get("cf-connecting-ip") ?? "unknown"))
    return form
      ? page("Slow down", `<h1>Too many signups from here</h1><p>Try again in a minute.</p>`, 429)
      : json({ error: "rate_limited", message: "too many signups from this address; retry in a minute" }, 429, { "retry-after": "60" });
  try {
    const { v } = await readBody(req);
    const input = parseSignup(v); // first, so a typo does not spend the visitor's one-use Turnstile token
    if (turnstileOn(env) && !(await captchaOk(env, v["cf-turnstile-response"], req.headers.get("cf-connecting-ip"))))
      throw new ApiError(400, "captcha_failed", { message: "the bot check failed; reload the page and try again" });
    await signup(env, url.origin, input, (p) => ctx.waitUntil(p));
  } catch (e) {
    if (!(e instanceof ApiError) || !form) throw e;
    return page("Check the form", `<h1>Check the form</h1><p>${esc(String(e.detail.message ?? e.code))}.</p><p><a href="/waitlist">Back</a></p>`, e.status);
  }
  const accepted = acceptedText(env.WAITLIST_FROM);
  return form
    ? page("Check your inbox", `<h1>Check your inbox</h1><p>${esc(accepted)}</p><p class="muted">${PRIVACY}</p>`, 202)
    : json({ status: "accepted", message: accepted }, 202);
}
