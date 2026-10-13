# botline v0.1 session B — report (2026-10-13)

Built in the copy `~/dev/botline-v01b` (rsync of `botline-v01` at 21:57 local, then `npm install`).
Nothing under `~/dev/botline-v01` was modified (0 files newer than the session start). Nothing under
`~/dev/botline` was written by me; its `docs/spike-log.md` and `.git/` changed at 22:27, which was
someone else (my only commands there were a read-only `git remote -v` / `git log` at ~22:00). No deploy, no
`--remote`, no commit, `~/.config/botline/*` not read, no key material printed. All eight deliverables are done.

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| Fresh local state (`rm -rf .wrangler/state`), `schema.sql`, then `migrate.mjs --local` | `columns up to date (local)`, exit 0 (no-op) |
| `migrate.mjs --local` on a DB built from `~/dev/botline/schema.sql` (spike schema; copied, read-only source; `BOTLINE_PERSIST_TO`) | adds `agents.key_hash_prev`, `agents.prev_valid_until`, `rings.fail_count INTEGER NOT NULL DEFAULT 0`; prints `missing table(s): waitlist -- run … --file schema.sql`, exit 1; after re-running `schema.sql`: `columns up to date`, exit 0; existing agents kept |
| New Worker on that DB **before** migrating (manual) | `me` 200 (`doorbell` reads fail_count 0), wrong well-formed key 401, send 201 but the ring logs `error` (claim needs `fail_count`; nothing fetched), `POST /v1/waitlist` 500. Hence the 5-step upgrade order below |
| **check.sh, final run, README recipe** (fresh state, `.dev.vars` exported, port 8787) | **85/85** (was 63) |
| check.sh run B: Worker without `DOORBELL_MASTER_KEY` (side config, fresh DB) | 85/85 (3h `plaintext`, 9b `no_master_key`, 9c `backoff,error`) |
| check.sh run C: the migrated spike DB | 85/85 |
| Mutation tests (8 mutations, one check.sh run each, src byte-identical afterwards) | every mutation turned its guard row red; table below |
| check.sh cleanup against a missing DB (its own `cleanup`/`d1`/`d1q`, `BOTLINE_DB=no-such-db`) | four `warning: cleanup: …` lines on stderr (muse doorbell, grokbot allowlist, throwaway agent with the exact DELETE to run, waitlist rows); normal runs print none |
| F5 on the migrated spike DB with two plaintext secrets | `encrypted 2 secret(s) [olda, oldb]; 0 already encrypted`; second run `encrypted 0 …; 2 already encrypted`; a ring then authenticated against `/v1/_echo` (`ok 200`, echo +1) |
| `waitlist-export.mjs --local` (row created through the real form post + the logged confirm link + the confirm button) | `final-check@botline-test.invalid,yes,readme,<created>,<confirmed>` and `1 confirmed: yes=1 maybe=0 no=0 (Phase 2 gate: 25 yes)` |
| Manual `GET /waitlist` | 200 `text/html`, CSP / `referrer-policy: no-referrer` / `no-store` / `nosniff`; headless Chrome screenshots at 520 px and 1100 px (dark scheme) render cleanly, no horizontal overflow |
| Rate limit (manual, kept out of check.sh) | 12 rapid bad signups: 10 × 400 then 429 with `retry-after: 60`; a form post gets an HTML 429 |
| Relay recipe commands (agents simulated with curl following the rule) | `hop-table.mjs` prints hops 0–3 (claude→grokbot→muse→claude, then claude's reply); the jq check prints `body unchanged across the loop` |
| Key material in check output and Worker logs (all runs) | 0 matches for `bl_<8>_<32>` and `enc:v1:` |

Mutation tests:

| Mutation | Rows that failed |
|---|---|
| decrypt refusal releases the lease (session A behaviour) | 9c |
| failure write's ownership guard never matches | 9b 9c 9d 10b–10g |
| inbox poll clears any lease (lifts backoff) | 9d |
| claim ignores dead-letter | 10f |
| a 2xx does not reset `fail_count` | 10h |
| re-signup may change a confirmed row | 11g 11h |
| no daily mail cap | 11c |
| GET confirm/delete act by themselves | 11e 11h |

## 1. F5 — `scripts/doorbell-reencrypt.mjs` (39 lines, +24 −10)

The count is read back: after the UPDATE batch the script re-reads the secrets, and a row counts as encrypted only if
it now holds the exact ciphertext this run wrote (random IV, so it is unique). A candidate that changed in between
(e.g. a concurrent `doorbell-set`) is reported as `N skipped, changed during this run (run again) [ids]`. Mode
independent (works for `--remote`, where a `--file` run returns no per-statement counts).

Decision: "already encrypted" is now `startsWith("enc:")` in JS, case-sensitive like the Worker's `openSecret`; the old
SQL `LIKE 'enc:%'` was case-insensitive. Not exercised: the "skipped" branch (needs a concurrent writer).

## 2. F6 — `scripts/check.sh`

- **9c** (after 9b, no inbox poll in between): a second send to muse. See decision 3a: an `error` ring now backs off,
  so the expected outcome is `backoff,error`, fail_count 1, lease ≈ 10 min, echo +0. That still pins the property F6
  asked for (the refusal's own, ownership-guarded write took effect, not the poll): `coalesced,error` would mean the
  refusal left the claim's in-flight lease; `error,error` would mean it released without backing off (mutation-tested).
  The literal "release by refusal" is still proven for `blocked_destination` by 9a (two sends, no poll between, two
  rings).
- **9d**: muse then drains its inbox (2 unread) and the backoff lease is unchanged.
- **Cleanup**: every EXIT-trap step checks its status; the throwaway-agent DELETE is also read back (`COUNT(*) = 0`).
  Failures print `warning: cleanup: …` to stderr (bash 3.2-safe empty-array expansion). The trap also deletes the
  waitlist test rows.
- **2h**: `thread_get` by a non-party (muse on the claude→grokbot thread of 2a) → `404 unknown_thread`.

## 3. Backoff + dead-letter

Files: `schema.sql` (`rings.fail_count`), `scripts/migrate.mjs` (COLUMNS map + missing-table notice), `src/doorbell.ts`
(+63 −27), `src/store.ts` (`me`, inbox, ring log), `src/mcp.ts`, `scripts/doorbell-set.mjs`.

- The claim adds `AND rings.fail_count < 5`. When it does not claim, one read labels the log row: `dead_letter`
  (fail_count ≥ 5), **`backoff`** (fail_count > 0 and no ring in flight) or `coalesced` (a ring in flight). I chose a
  new status `backoff` rather than reusing `coalesced`.
- A ring that ends `failed`, `timeout` or `error` runs one guarded UPDATE: `fail_count + 1`, `in_flight_since = NULL`,
  `lease_until = now + min(10 << old fail_count, 360)` minutes (SQLite `strftime(…, '+N minutes')`, same ISO format as
  the JS stamps), `last_status = reason`, `WHERE … AND in_flight_since = <this claim's stamp>`.
- `ok`: `fail_count = 0` with the status write (that statement never touches the lease, so it carries no guard, like
  session A's status write).
- `blocked_destination` and `nothing_unread` keep session A's guarded release; they do not count.
- Both session A releases keep `AND in_flight_since = ?`; the new failure write carries it too.
- `me` → `doorbell: { kind, state: ok|backoff|dead, fail_count, next_ring_after }` (plus the old `doorbell_kind`).
  `next_ring_after` is the backoff lease end when state is `backoff`, else null. `me` reads `SELECT *` from `rings`, so
  it answers 200 on an un-migrated DB.
- `GET /v1/_ring_log` → `ring` gains `fail_count`.
- `doorbell-set.mjs` (any kind) sets `fail_count = 0` and lifts a backoff lease (`lease_until = NULL` only when
  `in_flight_since IS NULL`; an in-flight lease is left alone), then reads `fail_count` back and dies if it is not 0.

Decisions:
- **3a. `error` backs off (as the brief says), which changes what F6's row can show.** The brief lists `error` among
  the failures; in session A's code the only `error` with a lease is the fail-closed decrypt refusal, so the brief must
  mean it. Consequence: after fixing `DOORBELL_MASTER_KEY` an operator must run `doorbell-set` (or wait out the
  backoff); session A's "fix the config and the next send rings" now holds only for `blocked_destination`.
- **3b. An inbox poll no longer lifts a backoff lease.** It clears only in-flight leases (`in_flight_since IS NOT
  NULL`). Otherwise every poll would cancel the backoff, which the brief's "not re-rung inside the backoff" forbids. A
  poll proves the agent reads its inbox, not that its doorbell works.
- **3c. A failure whose lease was lost is not counted.** If an inbox poll cleared our lease and a newer ring owns a
  fresh one, the guarded write matches nothing: the ring_log row is written, `fail_count` and `last_status` are not.
- **3d. Backoff has no timer.** Rings are send-triggered; mail that arrives during a backoff is rung by the first send
  after the backoff ends (or read on the agent's own poll).
- **3e. The 6 h cap is moot at `DEAD_AT = 5`** (the largest backoff is 160 min, set on the 5th failure, and `dead`
  wins anyway). Kept for the formula; the shift is clamped (`min(fail_count, 20)`) so a hand-edited value cannot
  overflow.
- **3f. The catch-all `ring error` path** (an exception in `ringOne`) is unchanged: it holds no claim stamp, so it does
  not count; any lease it holds expires after 10 minutes as before.
- check.sh simulates elapsed time by moving `rings.lease_until` to 2000-01-01 and seeds `fail_count = 4` / `2` with SQL.

check.sh rows: 10a doorbell-set (wrong secret) resets 9c's backoff; 10b ring answered 401 → `failed 401`, fail_count 1,
state backoff ≈ 10 min; 10c send inside the backoff → `backoff`, no http status, fail_count 1; 10d backoff elapsed →
`failed 401`, fail_count 2, ≈ 20 min; 10e 5th consecutive failure → dead, `next_ring_after` null; 10f dead with no
lease → `dead_letter`, nothing fetched; 10g doorbell-set (right secret) → `ok 200`, fail_count 0, echo +1; 10h
fail_count 2 + elapsed backoff, a 2xx ring resets fail_count by itself.

## 4. Waitlist

Files: `src/waitlist.ts` (new, 237 lines), `src/index.ts` (routes before auth), `schema.sql` (table + two indexes),
`scripts/waitlist-export.mjs` (new, 27 lines), `src/openapi.ts`, `wrangler.jsonc` (`WAITLIST_FROM`, `REPO_URL` vars,
empty).

- `POST /v1/waitlist {email, would_pay, source?}`: JSON → `202 {status:"accepted", message}`; a form post
  (`application/x-www-form-urlencoded`, which the page uses, so the page needs no JavaScript) → an HTML 202 page.
  400 for a bad email / would_pay / source, 413 over 4 KB, 429 from the bucket.
- One `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING`:
  - a new address is inserted;
  - a pending address under today's cap gets the new answer, fresh tokens and one more mail;
  - a confirmed or capped address is left unchanged.
  The response is identical in all cases. The mail goes out in `ctx.waitUntil` after the response, so its timing does
  not tell the cases apart either.
- `GET /waitlist`: what botline is, what the hosted service would be ("does not exist yet; we build it only if
  enough people would pay"), **$9/month**, "Would you pay this?" yes/maybe/no, email, the privacy line verbatim,
  repo link (if `REPO_URL`) and `/docs`, "Unofficial; not affiliated…". `?source=` is carried into a hidden field.
- Mail: Resend `POST https://api.resend.com/emails`, bearer key, `{from, to:[email], subject, text}`,
  `redirect: "manual"`, 10 s timeout. The request shape was checked against resend.com/docs on 2026-10-13. Without
  `RESEND_API_KEY` + `WAITLIST_FROM` (dev mode), or for a reserved test domain, the Worker logs
  `waitlist: confirm link for <domain>: <url>` and a matching `delete link` line. Failures log the domain and status
  only.
- Tokens: 32 random bytes, base64url (43 chars), sha256-hex stored, checked against `^[A-Za-z0-9_-]{43}$` before
  hashing.
- Export: confirmed rows only, RFC 4180 quoting, a leading `'` on cells starting `= + - @`, counts to stderr.

Decisions:
- **4a. Deviation: confirm and delete links open a one-button page; the POST acts.** The brief says GET sets
  `confirmed_at` / deletes. Mail security scanners (Defender Safe Links, Mimecast, Proofpoint) prefetch links. A
  prefetched GET would confirm without the person (inflating the Phase 2 gate) and delete real signups. check.sh
  asserts that GET changes nothing (11e, 11h) and that POST acts. To restore the literal behaviour, make
  `tokenAction` act on GET (about two lines).
- **4b. Two extra columns, `mail_day` and `mail_count`,** hold the "D1 count per email per day" (cap 3 mails per
  address per UTC day) on the waitlist row itself, so one atomic upsert does all of it. No extra table.
- **4c.** Emails are trimmed and lowercased (dedupe). `source` must match `[A-Za-z0-9._:/-]{1,64}`.
- **4d. Reserved domains** (`.test`, `.example`, `.invalid`, `.localhost`, `example.com/.net/.org`) are never mailed.
  check.sh signs up `@botline-check.invalid`, so a `--remote` run never sends real mail; the EXIT trap deletes those
  rows.
- **4e. Rate limit:** a per-isolate bucket per `cf-connecting-ip`, 10 tokens refilling 10/min, map capped at 10,000
  IPs (cleared when full). Only signups consume tokens. One check.sh run uses 7.
- **4f.** Confirm is idempotent (the confirm hash is kept after use); the delete link works before and after
  confirmation.
- **4g. `REPO_URL` var** (not in the brief's env list): no public repo URL exists yet, and I did not want a guessed
  link on the page. Empty means no link.
- **4h.** The pages send CSP `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none';
  frame-ancestors 'none'` and `referrer-policy: no-referrer`, so the token never leaks via Referer.

check.sh rows:
- 11a: signup → 202.
- 11b: the same address in upper case, same day → 202, one row, new answer.
- 11c: third and fourth signups → 202 both; the fourth is capped (mail_count 3, tokens unchanged).
- 11d: bad email / bad would_pay → 400 / 400.
- 11e: GET confirm with a known token (row inserted with `d1`) → one-button page, no-referrer, `confirmed_at` still null.
- 11f: POST confirm → set.
- 11g: signing up a confirmed address → 202, answer and tokens unchanged.
- 11h: GET delete (page only, row still there) / POST delete → row gone.
- 11i: used delete link / malformed token → 404 / 404.
- 11j: `GET /waitlist?source=check` shows the price, question and privacy line, and carries the source.

## 5. Backup — `scripts/backup.sh` (new, 23 lines; not run)

- `npx wrangler d1 export "$DB" --remote --output backups/<UTC date>.sql --skip-confirmation`, with `umask 077`, the
  directory at 700 and the file at 600.
- It fails if the dump is empty.
- With `BOTLINE_BACKUP_BUCKET` set: `npx wrangler r2 object put "$BUCKET/<date>.sql" --file … --remote
  --content-type application/sql`. I pass `--remote` explicitly: in wrangler 4, `r2 object` has `--local`/`--remote`
  flags and I did not rely on its default.
- Flags were checked with `--help` on wrangler 4.149.0.
- `backups/` is added to `.gitignore`.
- The README has a weekly launchd plist (Sunday 03:00, PATH + bucket in `EnvironmentVariables`, stderr to
  `backups/backup.log`).

## 6. OpenAPI / docs origin

`openapi(origin)` and `docsHtml(origin)` replace the `OPENAPI` / `DOCS_HTML` constants; `servers[0].url` and the curl
examples use `new URL(req.url).origin` (HTML-escaped). check.sh 1c asserts both equal the base URL.

## 7. MCP cache TTL

`CACHE.ttlMs` 30 000 → 300 000 with a new comment; check.sh 7k now asserts `ttlMs=300000` (it only checked presence).
The `me` tool description also changed (doorbell state), so `tools/list` differs from session A.

## 8. Docs

- `README.md` is 199 lines (plan: under 200). It covers:
  - the 5-step upgrade order;
  - the relay link;
  - the `me` doorbell fields and the waitlist row in the surface table;
  - config rows for `RESEND_API_KEY`/`WAITLIST_FROM`, `REPO_URL` and `BOTLINE_BACKUP_BUCKET`;
  - the scripts `waitlist-export` and `backup.sh`, and doorbell-set's reset;
  - a backoff/dead-letter security bullet;
  - Waitlist and Backups sections;
  - a tightened Conformance section.

  To fit, some existing prose was shortened; no facts were dropped.
- `src/openapi.ts`:
  - adds `POST /v1/waitlist`, `GET /waitlist` and GET/POST for `/waitlist/confirm` and `/waitlist/delete`, all with
    `security: []`;
  - adds `me.doorbell`;
  - adds the error codes `payload_too_large` and `rate_limited`;
  - `/docs` gains a doorbell note and a "Hosted waitlist" line.
- `docs/recipes/relay.md` (new, 93 lines):
  - the rule verbatim, with "last hop" defined and "`body`, not `body_wrapped`" spelled out;
  - the exact paragraph for Claude's routine (MCP tool names), Grok Bot's routine and Muse's scheduled task (REST),
    with the chat line that installs each;
  - the start command (`curl` as claude, `meta.relay_to: ["muse","claude"]`) and the expected 4-hop table (hop 3 is
    Claude's normal reply, because the last hop carries `needs: reply`);
  - `node scripts/hop-table.mjs "$T" --remote`, a jq body-unchanged check, and safety notes (a relayed `from` is the
    relayer, so the allowlist sees the relayer; chain length; idempotency).
- Recipes `claude.md`, `grokbot.md`, `muse.md` and `docs/spike-log.md` are untouched (keep the live versions).

## Not done / not verified

- Resend was never called: no real key, and I did not send a fake one to a third party. Only the docs-derived request
  shape stands behind the mail path.
- `backup.sh`, `waitlist-export.mjs --remote` and `migrate.mjs --remote` (its `sqlite_master` query) were not run
  against D1 remote.
- No real Workers/D1 concurrency: the ownership guards are verified by reading and by single-threaded mutation tests.
- The F5 "skipped" branch was not exercised.
- The relay recipe was not run on the real agents (simulated with curl).

## Before merging or deploying (coordinator)

1. **Upgrade order is now five steps** (README):
   1. re-run `schema.sql --remote` (creates `waitlist`);
   2. `migrate.mjs --remote` (adds `rings.fail_count`; exit 1 while a table is missing);
   3. `secret put DOORBELL_MASTER_KEY`;
   4. `deploy`;
   5. `doorbell-reencrypt`.

   Deploying before steps 1–2 makes every ring `error` (nothing sent) and the waitlist 500. Session A's report said
   four steps; this supersedes it.
2. Live behaviour change: a failing Claude/Grok Bot doorbell now stops ringing for 10 min, then doubling, and is
   dead after 5 failures in a row until `doorbell-set`. A spike-era secret that fails to decrypt also backs off.
3. `check.sh --remote` drives **muse's** doorbell through backoff and dead-letter and restores it to `none` on exit
   (as before). It writes and deletes waitlist rows `@botline-check.invalid`, and needs `ECHO_SECRET`,
   `DOORBELL_MASTER_KEY` and `WEBHOOK_ALLOWED_HOSTS` as in session A. Expect 85 rows.
4. Before announcing the waitlist:
   - set `WAITLIST_FROM` (a Resend-verified domain) and `REPO_URL` in `wrangler.jsonc`;
   - `wrangler secret put RESEND_API_KEY`;
   - otherwise confirm links only reach Workers Logs.
5. The live tree's `docs/spike-log.md` changed at 22:27 (not by me): keep the live version when merging.

## Open questions

- Is 3a (an `error` refusal backs off, so F6's row asserts `backoff,error` rather than a second refusal) what you
  want? The alternative is to treat config refusals like `blocked_destination` (release, no count), which makes 9c
  `error,error`. That is about five lines.
- Is 4a (one-button confirm/delete pages instead of GET-acts) acceptable?
- The privacy line promises "nothing else", but the plan's go-to-market emails the confirmed waitlist first.
  Should it add "and one email if botline cloud launches" before the page goes live?
- Self-hosted deployments also serve `/waitlist` (Patrick's $9 offer, into their own D1). Gate it behind a var?
- There is no global daily mail cap (Resend's free tier is 100/day) and no Turnstile; a distributed signup flood is
  limited only per IP per isolate and per address.
- Waitlist tokens in `?t=` reach Workers Logs (observability is on): the same class as SolarDecode's `/report/`
  token-in-access-log defect. With the one-button pages, a log reader can confirm or delete waitlist rows, nothing more.
- Unconfirmed waitlist rows are never purged. Add a 30-day purge?
- `doorbell-set` during an in-flight ring that then fails leaves a fresh 10-min backoff from the old config's failure
  (3c/3d edge).
