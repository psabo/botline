# botline v0.1 session C — report (2026-10-13)

Built in the copy `~/dev/botline-v01c` (rsync of the live tree at 23:04:34 local / 06:04Z, then
`npm install`; `.dev.vars` copied from `botline-v01b`). I wrote nothing in `~/dev/botline`,
`botline-v01` or `botline-v01b`. My only access there was reading (rsync source, `cp` of `schema.sql` /
`package-lock.json` into the scratchpad or the copy, `diff`).

Someone else changed files in the live tree during the session:
- Before my rsync, and so already in my base: `src/doorbell.ts`, `src/waitlist.ts`, `wrangler.jsonc`, `README.md`,
  `scripts/check.sh`, `scripts/backup.sh` and the council doc (22:57–23:02).
- After it, docs only: `docs/launch-2026-10.md` (new), `docs/recipes/relay.md` (a status note; the rule is unchanged),
  `docs/spike-log.md` and `docs/recipes/muse.md`. None of them is a file I changed.

Ground rules held:
- No deploy, no `--remote`, no commit.
- `~/.config/botline/*` was not read, and no key material was printed.
- No vendor endpoint was contacted. I read three Cloudflare Turnstile documentation pages (developers.cloudflare.com:
  server-side validation, CSP, client rendering) to check the siteverify contract; siteverify itself was never called.

All five deliverables are done.

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean (12 `src/` files checked, confirmed with `--listFiles`) |
| Fresh local state: `schema.sql`, then `migrate.mjs --local` | `columns up to date (local)`, exit 0 |
| `migrate.mjs --local` on a DB built from `botline-v01/schema.sql` (session A; `BOTLINE_PERSIST_TO`) | applies exactly `ALTER TABLE rings ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;` and `ALTER TABLE ring_log ADD COLUMN detail TEXT;`; prints `missing table(s): waitlist -- run: …`, exit 1. Second run: `columns up to date`, still exit 1. After re-running `schema.sql`: up to date, exit 0 |
| **check.sh**, README recipe, fresh state, port 8787 | **88/88** without the Turnstile twin (summary line: `turnstile-on rows: skipped`); **90/90** with `BOTLINE_TURNSTILE_BASE` (twin on 8788, started with the command in check.sh's header). The two runs went back to back on one server. Was 85 |
| **conformance-selftest.sh**, same server | **11/11**, about 30 s (output below) |
| Mutation tests (5; each file restored byte-identical, sha256 checked) | each turned exactly its guard rows red (table below) |
| New Worker on an UN-migrated session-B DB (live tree's `schema.sql`, no `ring_log.detail`) | `no_doorbell`, `coalesced` and `ok 200` rows still log; `_ring_log` answers 200 with `detail: null`. A failing (401) ring loses its row and its fail count: the batch rolls back on `table ring_log has no column named detail`, which the Worker log shows, and the in-flight lease stays 10 min. So migrate before deploy, as the README already orders |
| conformance.mjs edge paths | no args / one agent / a missing key / swapped keys (`the key in BOTLINE_KEY_CLAUDE authenticates as 'grokbot'`) / `--timeout-min 0`: all exit 2. A two-agent `--relay` exits 0. Ctrl-C prints the partial table, says `no reply before the interrupt`, exits 1 |
| Key material in check/self-test output and Worker logs | 0 matches for `bl_<8>_<32>`, `enc:v1:`, or the `.dev.vars` values of `ECHO_SECRET` / `DOORBELL_MASTER_KEY` |

| Mutation | Rows that failed |
|---|---|
| M1 global cap check disabled | 11l 11m |
| M2 Turnstile check skipped on POST | 11o |
| M3 `detail` never passed to the ring log | 9b 10b |
| M4 conformance.mjs sends without an idempotency key | self-test 2 (messages 16 → 28 on resume) |
| M5 conformance.mjs also reads the recipient's inbox (ALLOWED widened) | self-test 1a 1c 1d 2 3b 3c (3c: muse's pings claimed, 0 left) |

## 1. `scripts/conformance.mjs` (new, 244 lines) + self-test

Usage:

```sh
BOTLINE_AGENTS=claude,grokbot,muse BOTLINE_KEY_CLAUDE=… BOTLINE_KEY_GROKBOT=… BOTLINE_KEY_MUSE=… \
  node scripts/conformance.mjs <base-url> [--timeout-min N] [--relay] [--poll-sec S] [--run-id ID]
```

What it does:
- **Keys.** `BOTLINE_KEY_<ID>` is the id upper-cased with `-` mapped to `_`; colliding names are refused. Keys are
  format-checked and never printed.
- **Preflight.** `GET /v1/me` per key. The script stops (exit 2) if a key authenticates as another agent. It records
  each agent's `me.doorbell` kind and state, and warns if one is `backoff` or `dead`.
- **Safety by construction.** Every request goes through one `api()` function with an allowlist of four calls:
  `GET /v1/me`, `POST /v1/send`, `GET /v1/thread/:id`, `GET /v1/_ring_log`. Anything else throws before a byte is
  sent. Redirects are not followed; 20 s timeout per request; a descriptive `User-Agent` (Muse's recipe notes
  Cloudflare rejects bare clients).
- **Pings.** For every ordered pair: subject `conformance ping <run id> A->B`, `needs: reply`, idempotency key
  `conf-<run id>-A-B`. Polling is `GET /v1/thread/<id>` as the sender every `--poll-sec` (default 15) until a message
  from B appears or the timeout (default 20 min). After that, replied-but-unacked pings get up to two more polls, inside
  the timeout, so the `acked` column fills in.
- **Relay** (`--relay`), per `docs/recipes/relay.md`:
  - One message from `agents[0]` to `agents[1]` with `meta.relay_to = agents[2..] + [agents[0]]`, `needs: none`,
    key `conf-<run id>-relay`, body `conformance relay <run id>: copy me unchanged`.
  - It polls the thread as `agents[0]`. The loop is closed when the hop from the last agent to the first is acked by
    the first.
  - At the end it reads the thread once as every agent (each sees only its own hops) and merges by id, preferring the
    sender's view (which has every recipient's receipt).
  - It prints hop-table-style rows and checks that every route hop exists with the body unchanged.
- **Final reads.** One `GET /v1/_ring_log` per agent (read-only) fills the `ring` column.
- **Output.** stdout gets the §3A table:
  `run | hop | doorbell before | ring | sent | ring accepted | read | acked | replied | wall time | human clicks`.
  `ring accepted`, `read` and `acked` are h:mm:ss after `sent`; `ring accepted` is `-` for a `none` agent. Then a
  verdict line per pair and a result line. Progress goes to stderr.
- **Exit codes.** 0 only if every pair replied and, with `--relay`, the loop closed with the body unchanged. 1
  otherwise. 2 on usage or preflight errors.

Decisions:
- **1a. All pings go out together, grouped by recipient, 0.5 s apart; they are not sent one pair at a time.** This is
  what normally gives one ring per recipient: the second ping to an agent usually arrives while the first ring's lease
  is held and coalesces. It is a race, not a guarantee (round 3, F2): if the agent polls between the two sends, the
  poll clears the lease and the second ping rings again, one ring per ping. The run then takes about as long as the
  slowest leg (Muse's poll), not the sum of six legs. Sequential sends would ring each agent twice and could take over
  an hour with Muse at 15 min.
- **1b. The replies are ordinary mail to the sending agent, and they ring it.** Avoiding that would require the script
  to read inboxes, which is forbidden. On live agents each agent sees its own pings (normally one ring, one per ping if
  it polls between them), plus up to N-1 replies that its recipe just acks (`needs: none`). The same holds for the relay's last hop and Claude's reply to it. The
  self-test shows this in action: relay hop 0 is logged `coalesced` because muse's reply to grokbot's ping had rung
  grokbot 0.36 s earlier.
- **1c. The `ring` column comes from the recipient's own `GET /v1/_ring_log`.** The brief's source,
  `receipt.delivered_at`, cannot tell a coalesced ping from a poll agent, so `ring accepted` still comes from
  `delivered_at` and the ring log is added beside it. The endpoint is read-only (SELECTs) and only shows the caller's
  own log.
- **1d. `--run-id` resumes a run.** Same idempotency keys, so nothing is re-sent (self-test row 2: 16 messages before
  and after). `--poll-sec` exists for the self-test; the README documents 15 s.
- **1e. Times are the server's** (`created_at` and the receipts), never the local clock. Wall time is ping
  `created_at` to reply `created_at`.
- **1f. A pair counts as replied when any message from B appears in the ping's thread.** The ping always starts a new
  thread, so nothing else can be from B there. An unacked ping does not fail a pair; its verdict notes it.
- **1g. Human clicks are left blank to fill in** (as in hop-table). The spike log's "MCP era seen" column is dropped:
  the API cannot observe it.

### Self-test: `scripts/conformance-selftest.sh` (new, 88 lines) + `scripts/conformance-sim.mjs` (new, 55 lines)

I made it a separate script, not check.sh rows. It runs about 30 s, needs a background simulator, and tests the
script rather than the Worker. Its signature is the same as check.sh's.

- It refuses non-local bases, because the simulator reads inboxes.
- It points grokbot's doorbell at `<base>/v1/_echo` for the duration, so `ring accepted` and `ok 200` get exercised,
  and resets it to `none` on exit.
- The simulator polls each agent every 500 ms, applies the relay rule, replies in-thread to `needs: reply` with
  `reply-<id>`, and acks. `--silent a,b` agents are never touched.

Rows:

| Row | Run | Asserts |
|---|---|---|
| 0 | setup | grokbot's doorbell set to `<base>/v1/_echo` |
| 1a–1e | everyone simulated, `--relay` | exit 0; 6 PASS / 0 FAIL; relay PASS with the body unchanged; hop rows 0–3 in route order; a grokbot ping shows `ok 200` with an accepted time, and the 4 poll-agent pings show `no_doorbell` / `-` |
| 2 | same run id again | exit 0, 6 PASS, relay PASS, 16 messages before and after |
| 3a–3c | muse silent, 15 s timeout | exit 1; 4 PASS and the two pings to muse FAIL as `never read`; muse's two pings still unread afterwards (conformance.mjs claimed nothing) |
| 4 | all outputs | no key in any output |

Final self-test output (verbatim):

```
| step | expected | actual | result |
|---|---|---|---|
| 0 grokbot's doorbell -> <base>/v1/_echo for the test | ok | ok | PASS |
| 1a all agents simulated, --relay: exit code | 0 | 0 | PASS |
| 1b verdicts | 6 PASS 0 FAIL | 6 PASS 0 FAIL | PASS |
| 1c relay verdict | PASS body-unchanged | PASS body-unchanged | PASS |
| 1d relay table: hops 0-3 (claude -> grokbot -> muse -> claude, then claude's reply to muse) | 0 claude -> grokbot,1 grokbot -> muse,2 muse -> claude,3 claude -> muse | 0 claude -> grokbot,1 grokbot -> muse,2 muse -> claude,3 claude -> muse | PASS |
| 1e pings to grokbot (doorbell): ring ok 200 with an accepted time on >= 1; pings to the poll agents: no_doorbell, - | yes 4 | yes 4 | PASS |
| 2 the same --run-id again: exit 0, 6 PASS, relay PASS, message count unchanged (16) | 0 6 PASS 16 16 | 0 6 PASS 16 16 | PASS |
| 3a muse silent, 15 s timeout: exit code | 1 | 1 | PASS |
| 3b verdicts: 4 PASS; claude -> muse and grokbot -> muse FAIL, never read | 4 2 claude,grokbot | 4 2 claude,grokbot | PASS |
| 3c muse's two pings are still unread (nothing claimed them) | 2 | 2 | PASS |
| 4 no key in any output (bl_<8>_<32>) | 0 | 0 | PASS |

steps: 11  failed: 0  base: http://127.0.0.1:8787  run: selftest-20261013T064512Z  at: 2026-10-13T06:45:41Z

## botline conformance run selftest-20261013T064512Z

Base `http://127.0.0.1:8787`, started 2026-10-13T06:45:12.447Z, timeout 2 min, thread polls every 2 s. Doorbells before the run: claude none, grokbot generic_webhook, muse none. Times are the server's; accepted, read and acked are measured from sent; wall time is sent to the reply. Human clicks: fill in by hand.

| run | hop | doorbell before | ring | sent | ring accepted | read | acked | replied | wall time | human clicks |
|---|---|---|---|---|---|---|---|---|---|---|
| selftest-20261013T064512Z | grokbot -> claude | none | no_doorbell | 06:45:12Z | - | 0:00:01 | 0:00:01 | 06:45:12Z | 0:00:01 |  |
| selftest-20261013T064512Z | muse -> claude | none | no_doorbell | 06:45:12Z | - | 0:00:01 | 0:00:01 | 06:45:13Z | 0:00:01 |  |
| selftest-20261013T064512Z | claude -> grokbot | generic_webhook | ok 200 | 06:45:13Z | 0:00:00 | 0:00:00 | 0:00:00 | 06:45:13Z | 0:00:00 |  |
| selftest-20261013T064512Z | muse -> grokbot | generic_webhook | ok 200 | 06:45:14Z | 0:00:00 | 0:00:00 | 0:00:00 | 06:45:14Z | 0:00:00 |  |
| selftest-20261013T064512Z | claude -> muse | none | no_doorbell | 06:45:14Z | - | 0:00:00 | 0:00:00 | 06:45:14Z | 0:00:00 |  |
| selftest-20261013T064512Z | grokbot -> muse | none | no_doorbell | 06:45:15Z | - | 0:00:00 | 0:00:00 | 06:45:15Z | 0:00:00 |  |

- grokbot -> claude: PASS: replied after 0:00:01 (poll agent)
- muse -> claude: PASS: replied after 0:00:01 (poll agent)
- claude -> grokbot: PASS: replied after 0:00:00 (doorbell ok 200, accepted after 0:00:00)
- muse -> grokbot: PASS: replied after 0:00:00 (doorbell ok 200, accepted after 0:00:00)
- claude -> muse: PASS: replied after 0:00:00 (poll agent)
- grokbot -> muse: PASS: replied after 0:00:00 (poll agent)

### Relay selftest-20261013T064512Z: claude -> grokbot -> muse -> claude (thread `thr_01m4t046ms245e0xnk08sxv7je`)

| hop (from -> to) | sent | doorbell | delivered_at | read_at | acked_at | sent->read | sent->acked | human clicks |
|---|---|---|---|---|---|---|---|---|
| 0 claude -> grokbot | 2026-10-13T06:45:15.545Z | coalesced | - | 2026-10-13T06:45:15.679Z | 2026-10-13T06:45:15.693Z | 0:00:00 | 0:00:00 |  |
| 1 grokbot -> muse | 2026-10-13T06:45:15.690Z | no_doorbell | - | 2026-10-13T06:45:15.696Z | 2026-10-13T06:45:15.704Z | 0:00:00 | 0:00:00 |  |
| 2 muse -> claude | 2026-10-13T06:45:15.701Z | no_doorbell | - | 2026-10-13T06:45:16.211Z | 2026-10-13T06:45:16.232Z | 0:00:01 | 0:00:01 |  |
| 3 claude -> muse | 2026-10-13T06:45:16.225Z | no_doorbell | - | 2026-10-13T06:45:16.242Z | 2026-10-13T06:45:16.247Z | 0:00:00 | 0:00:00 |  |

- relay: PASS: loop closed after 0:00:01 (claude acked the last hop); body unchanged across 3 relay hops

Result: 6/6 pairs replied; relay closed. PASS.
```

## 2. Global daily mail cap — `src/waitlist.ts`, `src/store.ts` (Env), `wrangler.jsonc`, `src/openapi.ts`

Superseded in round 3 (F3): both caps now read the `waitlist_mail` ledger, not `SUM(mail_count)`. See "Round-3 folds".

- `WAITLIST_MAIL_CAP_PER_DAY`: a var, `"80"` in `wrangler.jsonc`. Anything that is not 0–999999 falls back to 80;
  `0` means no mail at all.
- One query: `SELECT COALESCE(SUM(mail_count), 0) FROM waitlist WHERE workspace_id = 'default' AND mail_day = ?today`.
- Over the cap: log `waitlist: daily cap reached (<n> of <cap> mails on <day>); no mail and no row change for a
  <domain> address`, and answer the usual 202 (form and JSON alike).

Decisions:
- **2a. Deviation in placement: the query runs in `signup()`, BEFORE the upsert, not inside the deferred mail
  function.** At "send time" the upsert has already rotated the address's tokens. A pending person who re-submits on
  a capped day would then lose the link they already hold and get no new one until tomorrow. Checked first, a capped
  signup changes nothing: a pending row keeps its answer, tokens and `mail_count`, and a new address is not stored (it
  could never confirm). The condition is `sum >= cap`, so exactly `cap` mails go out per day. Because `mail_count` is
  only bumped by signups that trigger a mail, the sum is today's mails (one per address-day bump).
  - Response timing still carries no per-address signal: the query runs for every signup, and the cap is global.
  - Literal "at send time" is about four lines: move the block into `sendConfirmation`, test `> cap`, and keep the
    upsert.
- **2b. The cap applies in dev mode too** (no Resend key, or a reserved domain), so check.sh can observe it.
  `@botline-check.invalid` rows count toward a day's sum while they exist; check.sh's EXIT trap deletes them.
- **2c. Soft cap:** concurrent signups can each read `cap - 1` and pass, so a burst may go a few over. There is no
  index on `mail_day`; the table is small.

check.sh rows:
- 11l: seeds a filler row (`mail_day` today, `mail_count` = `${WAITLIST_MAIL_CAP_PER_DAY:-80}`) plus a pending row with
  known tokens. Re-signing the pending address keeps `maybe 1 same-token`; a fresh address gets 202 and no row.
- 11m: the filler is deleted; the same fresh address is stored with `mail_count` 1.
- The log line was seen in the dev log: `waitlist: daily cap reached (84 of 80 mails on 2026-10-13); …`.

## 3. Optional Turnstile — `src/waitlist.ts`, `src/store.ts` (Env), `wrangler.jsonc` (`TURNSTILE_SITE_KEY: ""`), `src/openapi.ts`

Turnstile is on only when BOTH `TURNSTILE_SECRET` (a secret) and `TURNSTILE_SITE_KEY` (a var) are set. Either one
alone means off.

- **`GET /waitlist` with it on:**
  - adds `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>` and
    `<div class="cf-turnstile" data-sitekey="…">` (escaped) before the button;
  - adds the privacy line "The bot check is Cloudflare Turnstile.";
  - sends CSP `default-src 'none'; script-src https://challenges.cloudflare.com; frame-src
    https://challenges.cloudflare.com; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors
    'none'`.

  Every other page keeps the strict CSP. Cloudflare's CSP page lists exactly `script-src` and `frame-src` (no
  `connect-src` outside pre-clearance mode).
- **`POST /v1/waitlist` order:**
  1. rate-limit bucket;
  2. body;
  3. **field validation** (a typo does not spend the visitor's one-use token);
  4. Turnstile;
  5. signup.

  The token is read from `cf-turnstile-response`, the form field the widget injects; JSON uses the same key.
- **Siteverify call.** `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, form body
  `secret`, `response`, `remoteip` (= `cf-connecting-ip`, when present), `redirect: "manual"`, 10 s abort covering
  the body read.
- **Fails closed** on a missing token, a token over 2048 chars (the documented maximum), non-2xx, non-JSON,
  `success !== true`, timeout or network error. Result: 400 `{error: "captcha_failed", message}` on JSON, or the
  HTML "Check the form" page with status 400 on a form post.
- **Logs.** Only the status or Cloudflare's `error-codes`; never the token or the secret.

Decisions:
- **3a. The set-mode rows need a second Worker.** check.sh drives one deployment, and with Turnstile on every
  token-less signup in 11a–11m would fail. So rows 11n–11o run against `BOTLINE_TURNSTILE_BASE`: a twin with
  Turnstile on, started locally with `--var` and its own `--persist-to` (the command is in check.sh's header). It
  needs no tables; neither row reaches D1 or siteverify.
  - Unset: the rows are skipped (not counted), and both stderr and the summary line say so. That is 88 rows without
    the twin, 90 with it.
  - Row 11k (Turnstile off: no external script, strict CSP) always runs.
- **3b. Hostname / action are not checked** in the siteverify answer (Cloudflare calls them optional), and there is
  no idempotency key (no retries).
- **"Set + valid token" was verified by reading only.** The real siteverify was never called and no test secret was
  used: `captchaOk` → `success === true` → `signup` is the same code path the 202 rows exercise.

## 4. `ring_log.detail` — `schema.sql`, `scripts/migrate.mjs`, `src/doorbell.ts`, `src/store.ts`

- `ring_log.detail TEXT` (nullable): in `schema.sql`, and in migrate's COLUMNS map as `ring_log: { detail: "TEXT" }`.
- Values:

  | Ring outcome | `detail` |
  |---|---|
  | `openSecret` refusal (`error`) | `no_master_key`, `bad_master_key` or `decrypt_failed` |
  | adapter non-2xx (`failed`) | `http <status>` |
  | `timeout` | `timeout` |
  | network failure (`failed`) | `network_error` |
  | the catch-all `ring error` path | `exception` (the exception itself stays in the Worker log) |
  | every other row | NULL |

- `rings.last_status` is unchanged, so 9a's and 9b's `last_status` assertions still hold.
- `GET /v1/_ring_log` now returns `detail` on every entry. It uses `SELECT *` and maps to the old field list plus
  `detail ?? null`, so it also answers on an un-migrated DB.

Decision:
- **4a. `logStmt` uses the pre-`detail` column list when there is no detail.** A Worker deployed before
  `migrate.mjs` still logs ok / coalesced / no_doorbell / backoff rows (verified on a session-B DB). Only failure
  rows need the column. Without it, the failure batch rolls back, so the failure is neither logged nor counted, and
  the 10-minute in-flight lease holds. The README's upgrade order (migrate is step 2, deploy step 4) already prevents
  this.

check.sh rows:
- 9b now expects `ok error <reason> detail=<reason> 0`: `decrypt_failed` with the master key set, `no_master_key`
  without.
- 10b now expects `failed 401 detail=http 401 1 backoff ~10m`.

## 5. README (199 lines; was 200 by `wc -l`)

- **Conformance** is rewritten around `conformance.mjs`:
  - what it does, and that it is safe on a live deployment and why;
  - the env and flags, the exit code, and how to read each column;
  - FAIL lines;
  - check.sh restated as the Worker's own suite ("rewrites and rings doorbells; staging or before wiring").
- **Configuration** gains rows for `WAITLIST_MAIL_CAP_PER_DAY` and `TURNSTILE_SECRET` / `TURNSTILE_SITE_KEY`.
- `ring_log.detail` appears in Test aids, the encrypted-secrets bullet and the no-secrets-in-logs bullet ("statuses,
  reasons and message ids").
- **Waitlist** mentions both new limits.
- **Run it locally** gains the self-test line and a pointer to check.sh's header for the Turnstile twin.

To fit, with no fact dropped:
- the Costs section moved into the self-host prerequisites;
- the `d1 create` comment became one line;
- the doorbell-encryption sentence became a code comment;
- the plist was compacted to 6 lines (still a valid plist);
- Prior art became one paragraph;
- the hop-table detail moved to its admin-table row;
- the check.sh admin row moved into the Conformance section;
- the list after "the order matters:" no longer has a blank line before it (CommonMark allows a list starting at
  `1.` to interrupt a paragraph).

Two small wording drops: "Human-readable docs … both the 2026-07-28 and the older `initialize` protocol eras" became
"2026-07-28 and `initialize` eras", and "(the free plan is enough)" became the free-plan sentence. check.sh's first
comment line now calls it the Worker test suite and points to conformance.mjs for live agents.

## Files

| File | Change |
|---|---|
| `scripts/conformance.mjs` | new, 244 lines |
| `scripts/conformance-selftest.sh` | new, 88 lines |
| `scripts/conformance-sim.mjs` | new, 55 lines |
| `scripts/check.sh` | +54 −9 (443 lines): 9b, 10b, 11k–11o, header |
| `src/waitlist.ts` | +63 −12 (294) |
| `src/doorbell.ts` | +19 −12 (176) |
| `src/store.ts` | +10 −5 (323) |
| `src/openapi.ts` | +5 −3 (270) |
| `schema.sql` | +4 −2 (100) |
| `scripts/migrate.mjs` | +1 (35) |
| `wrangler.jsonc` | +7 −3 (38) |
| `README.md` | +46 −47 (199) |
| `docs/v01-session-c-report.md` | this file |

`package-lock.json`: `npm install` had bumped its root `version` from `0.0.1-spike` to `0.1.0-pre` (it was stale
against `package.json`). I restored the live file so the diff stays clean. This is an observation, not a change.

## Not done / not verified

- Turnstile with a real or test site key (no siteverify call, no browser render of the widget); the valid-token path
  is verified by reading only.
- Resend and the cap against real mail; real Workers/D1 concurrency for the soft cap.
- `conformance.mjs` against real agents or the live Worker (by rule), and against a remote deploy at all. Its
  `User-Agent` and 20 s timeouts are untested beyond local.
- `migrate.mjs --remote` (the new `ring_log.detail` ALTER) was not run anywhere remote.

## Before merging / deploying (coordinator)

1. **Merge set:**
   - the 3 new scripts;
   - `scripts/check.sh`, `scripts/migrate.mjs`;
   - `src/{doorbell,store,waitlist,openapi}.ts`;
   - `schema.sql`, `wrangler.jsonc`, `README.md`;
   - this report.

   Keep the live tree's `docs/spike-log.md`, `docs/recipes/{muse,relay}.md` and `docs/launch-2026-10.md`: they
   changed after my rsync and I did not touch them.
2. **Live upgrade order** (corrected in round 3: `waitlist_mail` is a new table, so `schema.sql` is now required):
   1. `npx wrangler d1 execute botline-spike --remote --file schema.sql` (adds `waitlist_mail`; safe to re-run);
   2. `node scripts/migrate.mjs --remote`, BEFORE `deploy` (adds `ring_log.detail`; exits 1 while a table is missing);
   3. `npx wrangler deploy`.

   Optional: `wrangler secret put TURNSTILE_SECRET` plus a non-empty `TURNSTILE_SITE_KEY`, both together, and only
   once a Turnstile widget exists for the hostname.
3. **Behaviour visible on live:**
   - `_ring_log` entries gain `detail`.
   - Waitlist signups past 80 mails a day are silently dropped (202). With `WAITLIST_FROM` empty on live, the waitlist
     is still off.
4. **Run `conformance.mjs` on live.** Each agent is rung for its pings (normally once; once per ping if it polls
   between the two sends) plus once per reply to the pings it "sent" (the script sends as every agent). Claude's routine
   budget is 30 fires/h. Worst case for a 3-agent `--relay` run, 2 + 2 + 1 = 5 fires of the Claude routine (corrected in
   round 3; it said "about 4"):
   - 2 for its two pings (normally 1: they coalesce unless Claude polls between them);
   - 1 for each of the 2 replies to the pings sent with its key;
   - 1 for the relay's closing hop.

   The script prints this bound before sending and counts the rings that happened at the end.
5. **Council focus:**
   - the placement deviation in 2a;
   - 1b/1c (replies ring the senders; the read-only `_ring_log` use);
   - the skip-when-unset design of the Turnstile rows (3a);
   - 4a's conditional INSERT.

## Open questions

- 2a: is "a capped signup changes nothing (no row for a new address)" right, or should a new address be stored
  without a mail so it can be re-sent tomorrow? The current choice stores less PII.
- **Cap loophole: closed in round 3 (F3).** Deleting a row (via its delete link, or the 30-day purge) lowered the
  day's sum and the address's own count. Both caps now read the `waitlist_mail` ledger, which deletion does not touch.
- Should `conformance.mjs` also assert the plan's G4 items (burst, duplicate, second poll) on live? I left them to
  check.sh, because a burst on live agents is exactly what the brief forbids.
- The Turnstile page needs JavaScript (the no-JS form no longer works once Turnstile is on). Is that acceptable for
  the launch page?


## Round-3 folds (F1–F3)

Folded in the same copy on 2026-10-13 (tests 07:31–07:49Z). Same ground rules: no deploy, no `--remote`, no commit,
`~/.config/botline/*` not read, no key printed. I read nothing in `~/dev/botline` except `schema.sql`,
which I copied into the scratchpad as the read-only source for the A+B migrate check (sha256 `f7d70ebc…3d31d40`).
The tests ran on a fresh state dir, `.wrangler/r3` (`BOTLINE_PERSIST_TO`), with `wrangler dev` on port 8797. The
copy's earlier `.wrangler/state` was left untouched. All three dev servers (8797, 8798, 8799) were stopped at the end;
`.wrangler/r3` remains.

### Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean (12 `src/` files); `node --check` on both .mjs files clean |
| Fresh state: `schema.sql`, then `migrate.mjs --local` | `columns up to date (local)`, exit 0 |
| `migrate.mjs --local` on a DB built from the live `botline/schema.sql` (A+B) | run 1: applies `ALTER TABLE ring_log ADD COLUMN detail TEXT;` and prints `missing table(s): waitlist_mail -- run: …`, exit 1. Run 2: `columns up to date`, still exit 1. After this copy's `schema.sql`: up to date, exit 0. `waitlist` keeps `mail_day`/`mail_count`, and nothing fails on them |
| New Worker on that upgraded A+B DB (second `wrangler dev`, port 8798, since stopped) | 4 signups of one address: `202 202 202 202`, ledger 3, 3 confirm links logged; the leftover columns untouched (`mail_day` NULL, `mail_count` 0); delete with the link, then sign up again: `202`, no row, ledger still 3 |
| **check.sh** | **89/89** without the Turnstile twin (88 + new 11p); **91/91** with `BOTLINE_TURNSTILE_BASE` (twin on 8799, since stopped) |
| **conformance-selftest.sh** | **16/16**, 60 s (was 11/11: +1f, +1g, +4a–4c; the no-key row is now 5, was 4) |
| Mutation tests (each file restored byte-identical, sha256 checked) | each turned only its guard rows red (table below) |
| Key material in my outputs (21 files, 291 KB: check/self-test outputs and Worker logs) | 0 matches for `bl_<8>_<32>`, the three local keys, `ECHO_SECRET`, `DOORBELL_MASTER_KEY` and `enc:v1:` |

| Mutation | Rows that failed |
|---|---|
| R1 the pre-fix `conformance.mjs` (session-C round-1 file) under the new self-test | 1f 1g (no ring output) and **4a 4b 4c**: exit 0, `6 0` verdicts, `claude -> muse: PASS: replied after 0:00:20` on a 15 s timeout, 63 s wall |
| R2 `inTime` accepts any observed reply | 4a 4b (exit 0, 6 PASS) |
| R3 no per-poll deadline check and no cut to the time left | 4c (64 s) |
| R4 the ledger upsert never inserts (`WHERE 0 AND EXISTS …`) | 11c 11m 11p |
| R5 the delete link also deletes the address's ledger rows (the F3 bug itself) | 11p only (`202 1 1`: a new row and the count reset to 1) |

### F1: conformance.mjs could pass after its own deadline

`scripts/conformance.mjs`:
- **The deadline is checked before every poll.** `over()` is checked before each `pollPair`/`pollRelay`, in both the
  main loop and the ack-grace loop, and labeled breaks leave both loops at once. Ctrl-C sets the same flag.
- **Each poll gets only the time left.** `api()` now takes an abort budget, and a poll uses `min(20 s, deadline - now)`.
  A poll cut short reports `cut off at the deadline`, not `timeout`.
- **A reply counts only if the server stamped it by the deadline.** That is `created_at <= deadline`, and the same
  rule applies to the relay's closing `acked_at`. A later reply fails its pair as `replied late: <span> (after the
  <timeout> timeout)`. The table marks it `(late)`. A late relay prints `loop closed late: …`. The result line counts
  late replies separately (`4/6 pairs replied by the deadline (2 more replied late)`).
- **One final read after the loop, all requests in parallel.** It covers every pair and the relay still waiting, each
  agent's ring log, and the relay thread as every agent. Each request has the normal 20 s budget, so the run ends at
  most one request after the deadline (28 s in total in self-test row 4c, for a 15 s timeout with 10 s reads).

Decisions:
- **F1a. The deadline is compared on the server's clock.** The preflight `GET /v1/me` records `server_time` minus the
  local midpoint of the request. The deadline instant is printed in the header as `deadline <iso>, server clock`. If
  `server_time` is missing, the script warns and compares on the local clock.
- **F1b. Why there is a final read.** The last nap ends exactly at the deadline. Under the new guard, that last round
  would never start, so a reply that came in during the final poll interval would be missed. The final read restores
  that round. Its findings are judged by server timestamp, not by when they were seen, so a reply after the deadline
  can fill the table but cannot flip the verdict. After Ctrl-C the final read still runs; it can only add replies
  stamped by the deadline.
- **F1c. The self-test needed injected latency.** A late agent alone (`--slow muse=19`) passes on the pre-fix script
  as well: local requests are fast, so the old loop also stopped at about 15 s. `conformance-sim.mjs` therefore gained
  a slow front (`--front-delay-ms 10000`): a 127.0.0.1 forwarder on a free port, printed to stdout, that holds each
  `GET /v1/thread/*` for 10 s. Case 4 points `conformance.mjs` at that front.
  - On the pre-fix script, one round of six 10 s polls took 60 s and saw muse's replies (R1).
  - On the new script, the first poll finishes, the second is cut at the deadline, and the final read finds muse's
    replies stamped about 3 s after the deadline. The verdict is FAIL, `replied late`.
  - R2 and R3 show that the timestamp rule and the deadline guard are each needed.

The late-reply self-test, verbatim (the final run's table, then run 4):

```
| step | expected | actual | result |
|---|---|---|---|
| 0 grokbot's doorbell -> <base>/v1/_echo for the test | ok | ok | PASS |
| 1a all agents simulated, --relay: exit code | 0 | 0 | PASS |
| 1b verdicts | 6 PASS 0 FAIL | 6 PASS 0 FAIL | PASS |
| 1c relay verdict | PASS body-unchanged | PASS body-unchanged | PASS |
| 1d relay table: hops 0-3 (claude -> grokbot -> muse -> claude, then claude's reply to muse) | 0 claude -> grokbot,1 grokbot -> muse,2 muse -> claude,3 claude -> muse | 0 claude -> grokbot,1 grokbot -> muse,2 muse -> claude,3 claude -> muse | PASS |
| 1e pings to grokbot (doorbell): ring ok 200 with an accepted time on >= 1; pings to the poll agents: no_doorbell, - | yes 4 | yes 4 | PASS |
| 1f rings per recipient: claude, muse (no doorbell) 0; grokbot 1-5, equal to its ring_log rows for the run's threads | 0 0 in-range equal | 0 0 in-range equal | PASS |
| 1g the note before sending states grokbot's worst case (2 + 2 + 1) | stated | stated | PASS |
| 2 the same --run-id again: exit 0, 6 PASS, relay PASS, message count unchanged (16) | 0 6 PASS 16 16 | 0 6 PASS 16 16 | PASS |
| 3a muse silent, 15 s timeout: exit code | 1 | 1 | PASS |
| 3b verdicts: 4 PASS; claude -> muse and grokbot -> muse FAIL, never read | 4 2 claude,grokbot | 4 2 claude,grokbot | PASS |
| 3c muse's two pings are still unread (nothing claimed them) | 2 | 2 | PASS |
| 4a slow server (thread reads +10 s), muse answers after 19 s, 15 s timeout: exit code | 1 | 1 | PASS |
| 4b verdicts: 4 PASS; claude -> muse and grokbot -> muse FAIL, replied late | 4 2 claude,grokbot | 4 2 claude,grokbot | PASS |
| 4c wall time within the timeout + 30 s (took 28 s) | <= 45 s | <= 45 s | PASS |
| 5 no key in any output (bl_<8>_<32>) | 0 | 0 | PASS |

steps: 16  failed: 0  base: http://127.0.0.1:8797  run: selftest-20261013T074503Z  at: 2026-10-13T07:46:02Z

## botline conformance run selftest-20261013T074503Z-late

Base `http://127.0.0.1:60511`, started 2026-10-13T07:45:33.840Z, timeout 15 s (deadline 2026-10-13T07:45:51.949Z, server clock), thread polls every 2 s. Doorbells before the run: claude none, grokbot generic_webhook, muse none. Times are the server's; accepted, read and acked are measured from sent; wall time is sent to the reply; a reply stamped after the deadline is marked late and fails its pair. Human clicks: fill in by hand.

| run | hop | doorbell before | ring | sent | ring accepted | read | acked | replied | wall time | human clicks |
|---|---|---|---|---|---|---|---|---|---|---|
| selftest-20261013T074503Z-late | grokbot -> claude | none | no_doorbell | 07:45:33Z | - | 0:00:00 | 0:00:00 | 07:45:34Z | 0:00:00 |  |
| selftest-20261013T074503Z-late | muse -> claude | none | no_doorbell | 07:45:34Z | - | 0:00:00 | 0:00:00 | 07:45:34Z | 0:00:00 |  |
| selftest-20261013T074503Z-late | claude -> grokbot | generic_webhook | ok 200 | 07:45:34Z | 0:00:00 | 0:00:00 | 0:00:00 | 07:45:35Z | 0:00:00 |  |
| selftest-20261013T074503Z-late | muse -> grokbot | generic_webhook | ok 200 | 07:45:35Z | 0:00:00 | 0:00:00 | 0:00:00 | 07:45:35Z | 0:00:00 |  |
| selftest-20261013T074503Z-late | claude -> muse | none | no_doorbell | 07:45:35Z | - | 0:00:00 | 0:00:20 | 07:45:55Z (late) | 0:00:20 |  |
| selftest-20261013T074503Z-late | grokbot -> muse | none | no_doorbell | 07:45:36Z | - | 0:00:01 | 0:00:20 | 07:45:55Z (late) | 0:00:20 |  |

- grokbot -> claude: PASS: replied after 0:00:00 (poll agent)
- muse -> claude: PASS: replied after 0:00:00 (poll agent)
- claude -> grokbot: PASS: replied after 0:00:00 (doorbell ok 200, accepted after 0:00:00)
- muse -> grokbot: PASS: replied after 0:00:00 (doorbell ok 200, accepted after 0:00:00)
- claude -> muse: FAIL: replied late: 0:00:20 (after the 15 s timeout); poll agent
- grokbot -> muse: FAIL: replied late: 0:00:20 (after the 15 s timeout); poll agent

### Doorbell rings selftest-20261013T074503Z-late

Each agent's own ring-log rows that name a message of this run (pings, replies, relay hops). A ring fetched the doorbell (ok, failed, timeout); the other rows rang nothing. Normally one ring per recipient for its pings (one per ping if it polled between two sends), plus one per reply to its own pings and per relay hop it received; worst case as stated before the run.

| agent | doorbell before | rings | rows that rang nothing | worst case |
|---|---|---|---|---|
| claude | none | 0 | no_doorbell 3 | - |
| grokbot | generic_webhook | 3 (ok 3) | - | 4 |
| muse | none | 0 | no_doorbell 4 | - |

Result: 4/6 pairs replied by the deadline (2 more replied late). FAIL.
```

### F2: "one ring per recipient" was a race, not a guarantee

- **The claims now state the bound.** It reads: normally one ring per recipient; if the agent polls between the two
  sends, one ring per ping; worst case for a three-agent run with `--relay`, 2 + 2 + 1 = 5 fires of the Claude
  routine, under its 30/hour cap. It appears in:
  - the script's header comment;
  - the README Conformance section;
  - this report: 1a, 1b, and coordinator item 4, which said "about 4".
- **The script prints a note before sending.** It states the rule and each doorbell agent's worst case, e.g.
  `Worst case for this run: grokbot (generic_webhook) 5 rings.`, and adds "a Claude routine allows 30 fires per hour"
  when a `claude_fire` agent is present. The worst case per agent is `2(N-1)`, plus `1` with `--relay`, plus `1` more
  for the last agent (the first agent's reply to the closing hop).
- **The output counts the rings that happened.** A new `### Doorbell rings` table, one row per agent, counts the
  agent's own `_ring_log` rows whose `message_ids` include a message of this run (the pings, the replies seen and the
  relay messages):
  - `rings` counts the rows that fetched the doorbell (`ok`, `failed`, `timeout`);
  - the rows that rang nothing are tallied by status beside it;
  - a last column shows the worst case.
- **Self-test.** Row 1f checks that claude and muse ring 0 and grokbot rings 1–5, equal to an independent D1 count
  (`ring_log` × `json_each(message_ids)` × the run's threads). Row 1g checks the note.

The race happened in the final self-test: both pings to grokbot rang (`ok 200` on `claude -> grokbot` and
`muse -> grokbot`), because the simulator polls every 0.5 s:

```
### Doorbell rings selftest-20261013T074503Z

Each agent's own ring-log rows that name a message of this run (pings, replies, relay hops). A ring fetched the doorbell (ok, failed, timeout); the other rows rang nothing. Normally one ring per recipient for its pings (one per ping if it polled between two sends), plus one per reply to its own pings and per relay hop it received; worst case as stated before the run.

| agent | doorbell before | rings | rows that rang nothing | worst case |
|---|---|---|---|---|
| claude | none | 0 | no_doorbell 5 | - |
| grokbot | generic_webhook | 4 (ok 4) | coalesced 1 | 5 |
| muse | none | 0 | no_doorbell 6 | - |
```

Limits:
- `_ring_log` returns an agent's last 100 rows, so on a busy agent a long run's early rows can drop out.
- A ring lists every unread message, so a ring set off by unrelated mail is counted if it also names a run message
  that was still unread. On a dedicated three-agent deployment this is the honest count.

### F3: delete reset both mail caps

- **`schema.sql`**:
  - adds `waitlist_mail (workspace_id, day, email_hash, count)`, with primary key `(workspace_id, day, email_hash)`;
  - removes `mail_day`/`mail_count` from `waitlist`'s CREATE TABLE. Nothing reads them now; a comment says older
    databases may still have them.
- **`scripts/migrate.mjs`: unchanged.** Its required-tables list is already read from `schema.sql`'s
  `CREATE TABLE IF NOT EXISTS` lines, so `waitlist_mail` is required automatically (verified above). It does not look
  at extra columns.
- **`src/waitlist.ts` `signup()`**:
  - **Purge.** One `batch`: the 30-day purge of unconfirmed rows plus `DELETE FROM waitlist_mail WHERE day < today-2`.
  - **Cap check, before the upsert.** One read of the ledger gives today's total and this address's count
    (`email_hash` = sha256 of the trimmed, lowercased address). Total >= `WAITLIST_MAIL_CAP_PER_DAY` logs the cap line
    and returns; this address's count >= 3 returns quietly. Either way the answer is 202, with no mail, no row, and no
    token rotated.
  - **Write, one `batch`.** Two statements:
    - the signup upsert, now `INSERT … SELECT … WHERE <the address's ledger count> < 3 ON CONFLICT … DO UPDATE …
      WHERE confirmed_at IS NULL RETURNING email`;
    - the ledger upsert (`count + 1`), which runs only `WHERE EXISTS` a row holding this signup's new confirm-token
      hash, i.e. only when the upsert took effect and a mail is going out.
  - The mail is sent iff the first statement returned a row.
- **README**: the Waitlist sentence ("The mail counts live in their own ledger (`waitlist_mail`, per day and address
  hash), which deleting a signup does not reset.") and upgrade step 1 now name `waitlist_mail`.
- **check.sh**:
  - 11c, 11l and 11m read the ledger instead of `mail_count`. Every expected value and meaning is unchanged; 11l's
    filler is now a ledger row.
  - The EXIT trap also deletes the ledger rows of every check address (`WLH`). Without that, each run would leave about
    9 counted mails toward the 80-a-day cap, and about the tenth run of a day would go red.
  - New row **11p**: sign up `check-del-…@botline-check.invalid`, set a known `delete_token_hash` with `d1`, then POST
    the delete link, three times. A fourth signup gets 202, no row, and the ledger still says 3.
  - 11p runs after 11a–11m have used the per-IP bucket (10 signups, +1 every 6 s). On the first run it got
    `202 202 429`. It now waits out a 429 (7 s, at most 3 times); a 429 is the rate limiter, not what 11p tests.

Decisions:
- **F3a. The per-address cap is enforced in the INSERT itself.** Before round 3 it was atomic in the upsert's `WHERE`.
  A pre-read alone would have let two concurrent signups both take an address's last mail. The INSERT re-reads the
  ledger, and the two statements share one D1 batch (a transaction). The global cap stays soft, as before.
- **F3b. The ledger write depends on the new confirm-token hash.** It is the one fact that proves this signup's upsert
  applied. So a confirmed address (no change, no mail) and a capped address never count a mail.

### Files (round 3)

| File | Change (vs. the round-1 copy) |
|---|---|
| `scripts/conformance.mjs` | +129 −56 (317 lines) |
| `scripts/conformance-sim.mjs` | +55 −18 (92): `--slow`, `--front-delay-ms` |
| `scripts/conformance-selftest.sh` | +37 −8 (117): rows 1f 1g 4a–4c, key row 4 → 5, prints run 4 |
| `scripts/check.sh` | +42 −19 (466): 11c 11l 11m, cleanup, 11p |
| `src/waitlist.ts` | +45 −25 (314) |
| `schema.sql` | +13 −4 (109) |
| `README.md` | +16 −9 (206) |
| `scripts/migrate.mjs`, `src/openapi.ts` | unchanged (openapi already says "at most 3 confirmation mails per address per day", now true across deletes) |
| `docs/v01-session-c-report.md` | 1a, 1b, §2 note, coordinator items 2 and 4, the cap-loophole question; this section |

### For the coordinator

1. **Live upgrade order changed:** `schema.sql`, then `migrate.mjs --remote`, then deploy (item 2 above). `migrate.mjs`
   exits 1 until `waitlist_mail` exists. A Worker deployed without the table answers 500 on `POST /v1/waitlist` while
   `WAITLIST_FROM` is set (it is empty on live today, so the waitlist is off there).
2. **Privacy wording to decide.** The delete page says "Your address and your answer are gone from the waitlist". That
   is still true of the `waitlist` row, but the ledger keeps a sha256 of the address for up to 3 days for the caps. An
   email hash can be reversed by guessing. Like the 30-day purge, the 2-day purge only runs on a signup. Either accept
   this as abuse-limit bookkeeping, or add a clause to the page or `PRIVACY`.
3. **Verify:**
   - 11p's 429 wait (7 s per retry, at most 3 retries per signup, and only when the bucket is empty);
   - that the slow front in `conformance-sim.mjs` stays local-only (it inherits the sim's 127.0.0.1 base check and
     binds 127.0.0.1);
   - the server-clock deadline (F1a) on a remote run, which is untested beyond local.

Observation, not acted on: the `ring` column (`ringFor`) shows the newest ring-log row that names a ping. If a later
ring still listed that ping as unread, the column shows that ring instead of the ping's own one. This is pre-existing;
using the oldest matching row would show how the ping itself was rung.
