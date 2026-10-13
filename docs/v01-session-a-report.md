# botline v0.1 session A — report (2026-10-13)

Built in the copy `~/dev/botline-v01` (rsync of the live spike tree at 21:11 local, then
`npm install`). Nothing under `~/dev/botline` was modified. No deploy, no `--remote`, no commit.
All eight deliverables are done.

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| `migrate.mjs --local` on a second local DB built from the OLD spike `schema.sql` (`BOTLINE_PERSIST_TO=<dir>`) | `ALTER TABLE agents ADD COLUMN key_hash_prev TEXT; … prev_valid_until TEXT;` applied; existing rows kept; second run `up to date` |
| `migrate.mjs --local` on a fresh `schema.sql` install | `up to date` (no-op) |
| New `schema.sql` re-run against the migrated spike DB | succeeds (non-destructive) |
| **check.sh, README recipe verbatim** (fresh `.wrangler/state`, `.dev.vars` from the README heredoc, port 8787) | **63/63** (and 63/63 again after the row 8b tolerance fix) |
| check.sh, run A: full `.dev.vars`, fresh DB, port 8799 | 63/63 |
| check.sh, run B: Worker WITHOUT `DOORBELL_MASTER_KEY` (plaintext + `no_master_key` branches) | 63/63 |
| check.sh, run C: the migrated spike-schema DB with spike-era keys (the upgrade path) | 63/63 |
| `doorbell-reencrypt.mjs` on the migrated DB holding a spike-era plaintext secret | `encrypted 1`, then `encrypted 0 … 1 already encrypted`; the ring then authenticated against `/v1/_echo` (`ok 200`, echo +1), so the decrypted value is exact |
| Redirects (manual): generic_webhook to a local server answering 302 → `/v1/_echo` | ring_log `failed` http 302, echo hits +0 (not followed) |
| Vendor pins at ring time (manual): `claude_fire` row forced to `http://127.0.0.1/v1/_echo`; `grokbot_webhook` to `api.cursor.sh` | both `blocked_destination`, echo +0 |
| Echo gating (manual): Worker without `ECHO_SECRET` | `POST /v1/_echo` 404 (with or without bearer), `GET /v1/_echo/hits` 404, `GET /v1/_ring_log` 200 (401 without key) |
| Key material in Worker logs / check.sh output (all runs) | 0 matches for `bl_<8>_<32>` and `enc:v1:` |
| New code against an UN-migrated DB (manual) | current key 200; wrong well-formed key **500** (`no such column: key_hash_prev`); rotate 500. Hence migrate before deploy (below) |

check.sh went from 47 to 63 rows: 16 new rows, plus 7d/7k now expecting 7 tools (with `key_rotate`) instead of 6. No row was removed or loosened.

## 1. `scripts/hop-table.mjs` (new, 34 lines)

`node scripts/hop-table.mjs <thread_id> [--local|--remote]`. One `runQuery` (`--command`, so it also returns rows
in `--remote` mode through `_d1.mjs`'s progress-prefix stripping). The thread id is validated
(`[A-Za-z0-9_-]{1,64}`) before it is quoted into SQL. `doorbell` = the latest `ring_log` row (highest id) for that
recipient whose `message_ids` JSON contains the message (`json_each`), as `status http_status`; `poll` if none.
Wall times are `h:mm:ss` from `created_at`; nulls print `-`; `human clicks` is empty. A summary line goes to
stderr, so stdout is pure markdown. Only `--local` was tested.

Decision: statuses print literally, so a poll-only agent shows `no_doorbell` (its ring_log row exists).
`poll` appears only when no ring_log row names the message at all.

Sample: a three-hop relay built on the run A server (grokbot temporarily had a generic_webhook doorbell to
`/v1/_echo`):

| hop (from -> to) | sent | doorbell | delivered_at | read_at | acked_at | sent->read | sent->acked | human clicks |
|---|---|---|---|---|---|---|---|---|
| 0 claude -> grokbot | 2026-10-13T04:24:39.763Z | ok 200 | 2026-10-13T04:24:39.768Z | 2026-10-13T04:24:41.805Z | 2026-10-13T04:24:42.857Z | 0:00:02 | 0:00:03 |  |
| 1 grokbot -> muse | 2026-10-13T04:24:42.842Z | no_doorbell | - | 2026-10-13T04:24:44.889Z | 2026-10-13T04:24:44.920Z | 0:00:02 | 0:00:02 |  |
| 2 muse -> claude | 2026-10-13T04:24:44.906Z | no_doorbell | - | 2026-10-13T04:24:45.943Z | 2026-10-13T04:24:45.956Z | 0:00:01 | 0:00:01 |  |

A thread check.sh created (final run, row 2f: one message to two recipients):

| hop (from -> to) | sent | doorbell | delivered_at | read_at | acked_at | sent->read | sent->acked | human clicks |
|---|---|---|---|---|---|---|---|---|
| 0 claude -> grokbot | 2026-10-13T04:29:38.394Z | no_doorbell | - | 2026-10-13T04:29:38.419Z | 2026-10-13T04:29:38.434Z | 0:00:00 | 0:00:00 |  |
| 0 claude -> muse | 2026-10-13T04:29:38.394Z | no_doorbell | - | 2026-10-13T04:29:38.451Z | - | 0:00:00 | - |  |

Other check.sh threads render `ok 200` (burst 1), `blocked_destination` (row 9a) and `error` (row 9b).

## 2. Key rotate / revoke

- `schema.sql`: `key_hash_prev TEXT`, `prev_valid_until TEXT` added to `agents` in the CREATE TABLE. The file
  stays the full fresh-install definition and is still safe to re-run.
- `scripts/migrate.mjs` (new): reads `PRAGMA table_info(<table>)` via `runQuery` and applies only the missing
  columns from a data-driven `COLUMNS` map. Additive only. Exits if the table is missing ("apply schema.sql first").
- `scripts/_d1.mjs`: optional `BOTLINE_PERSIST_TO` env adds `--persist-to <dir>` in `--local` mode. That gave the
  migration test its second local DB; check.sh honours the same variable.
- `src/store.ts`:
  - `authenticate()` does an indexed lookup on `key_hash` first. If that misses, it checks
    `key_hash_prev = ? AND prev_valid_until > now`, and a match marks the row `via_prev: true`.
  - `keyRotate()` mints `bl_<8>_<32>` (WebCrypto, unbiased rejection sampling, same alphabet as `agent-add`).
    One UPDATE then sets `key_hash = new` and `key_hash_prev = key_hash`, with grace = now + 10 min. The UPDATE
    is guarded by `key_hash = <the caller's current hash>`, so it is compare-and-set; it returns
    `{ key, previous_valid_until }`.
- REST `POST /v1/key/rotate` (`src/index.ts`) answers with `cache-control: no-store`; MCP tool `key_rotate`
  (no args) is in `TOOLS` and `HANDLERS`. Nothing logs the response. The MCP diagnostic line logs
  method/agent/headers only, which I confirmed by grepping every dev log.
- `scripts/agent-key.mjs rotate|revoke <agent>` (new):
  - `rotate`: new key to stdout once, old key valid 10 minutes.
  - `revoke`: `key_hash` becomes 32 random bytes in hex (nobody holds a preimage), and `key_hash_prev` and
    `prev_valid_until` are cleared.
  - Both read the row back to confirm the change applied before printing anything.
- `src/openapi.ts` (path, 403/409, error codes, DOCS_HTML row) updated. Versions are `0.1.0-pre` via one
  `VERSION` constant in `store.ts` (MCP `SERVER_INFO`, OpenAPI `info.version`, `/docs` heading, `GET /`).
  `package.json` is `0.1.0-pre` too.

Decisions:
- **Only the current key may rotate** (403 `current_key_required` when called with the grace key). Otherwise
  someone holding a leaked old key could rotate during the grace window, get a fresh key and lock the owner out.
- **One previous key at a time.** Rotating again replaces `key_hash_prev`, so the key from two rotations ago
  dies at once (row 8e: newest 200, previous 200, the one before 401).
- **Admin rotate also gives the 10-minute grace.** For a suspected leak: `revoke`, then `rotate`. A rotate after
  a revoke parks the random hash in `key_hash_prev`, which is harmless.
- **No index on `key_hash_prev`.** If `schema.sql` carried `CREATE INDEX … (key_hash_prev)`, re-running it on an
  un-migrated database would fail. The fallback lookup is therefore a scan, run only for keys that are not
  current; `agents` is tiny in Phase 1. Phase 2 should add the index through `migrate.mjs`.
- `GET /` now returns `version: "0.1.0-pre"` in place of `status: "SPIKE"`. `VERSION` lives in `store.ts`
  because exporting a constant from the Worker entry module crashes workerd ("Incorrect type for map entry
  'VERSION'"), which I hit and fixed during the build.

## 3. Encrypted doorbell secrets

- `src/secrets.ts` (new, decrypt only):
  - `openSecret(stored, DOORBELL_MASTER_KEY, aad)` returns `{ok, secret}` or `{ok:false, reason}`.
  - Stored form `enc:v1:<iv_b64>:<ct_b64>`, AES-256-GCM, 12-byte IV, AAD `"<workspace_id>/<agent_id>"`.
  - The master key must be base64 of exactly 32 bytes; the imported CryptoKey is cached per isolate.
- `scripts/_secret.mjs` (new): the Node twin (encrypt side, WebCrypto) plus `masterKeyFromEnv()`, which exits
  on a malformed key.
- `src/doorbell.ts`: the secret is decrypted just before the fetch. Adapters now receive
  `{ url, secret }` (decrypted) and never see the stored form.
- `scripts/doorbell-set.mjs`: encrypts when `DOORBELL_MASTER_KEY` is in its environment; otherwise writes
  plaintext with a one-line stderr warning.
- `scripts/doorbell-reencrypt.mjs` (new): encrypts every plaintext secret in place. It is idempotent: rows
  starting `enc:` are skipped, and each UPDATE is compare-and-set on the exact plaintext it read, sent through
  `_d1.mjs`'s 0600 temp file. It refuses to run without the key.
- `Env` gains `DOORBELL_MASTER_KEY?` and `WEBHOOK_ALLOWED_HOSTS?`. README documents
  `openssl rand -base64 32` and `npx wrangler secret put DOORBELL_MASTER_KEY`.

Decisions:
- **AAD binds a ciphertext to its agent row.** Someone with D1 write access but no Worker secret cannot copy one
  agent's encrypted secret onto another row.
- **Any `enc:` prefix counts as encrypted, not only `enc:v1:`.** A future `enc:v2:` value then fails closed
  instead of being sent as a plaintext bearer. This is slightly stricter than the brief's wording ("a value
  without the `enc:v1:` prefix is plaintext").
- **Fail-closed path.** ring_log status is `error`, and `rings.last_status` is one of `no_master_key`,
  `bad_master_key` or `decrypt_failed`. The lease is released so the next send rings once the config is fixed.
  Nothing is fetched.
- **`GET /v1/_ring_log` now also returns `ring: {last_status, last_at, lease_until}`** for the caller (additive).
  The reason is then visible over HTTP, which check.sh uses.

## 4. `me` and `thread_get`

- `store.me()` adds `server_time` (ISO now).
- `store.thread()` makes one extra query for the receipts of the thread's messages. On messages the caller sent
  it includes every recipient's `{agent, delivered_at, read_at, acked_at}`; on messages it received, only its own.
  REST and MCP share the function. OpenAPI (`receipt` schema, `server_time`) and the tool descriptions are updated.

## 5. Destination allowlist, vendor pins, redirects

- `generic_webhook.allows(url, env)` requires an exact, case-insensitive hostname match in `WEBHOOK_ALLOWED_HOSTS`
  and `https:`. Empty or unset means generic webhooks are off. Otherwise ring_log is `blocked_destination`,
  `rings.last_status` is `blocked_destination`, the lease is released and there is no fetch.
- Vendor adapters were **not** pinned before (they rang whatever `doorbell_url` held). They now are, exact host
  and https only, from the hosts recorded in `docs/spike-log.md`:
  `claude_fire` → `api.anthropic.com` (§3 recipe URL), `grokbot_webhook` → `api2.cursor.sh` (§2d). The host
  constants live in the adapters (`allows` export), so core still holds no vendor logic.
- `doorbell-set.mjs` refuses non-vendor hosts for those two kinds up front and notes the allowlist for
  generic ones.
- The shared helper `postJson` had no `redirect` option, so fetch's default `follow` applied. It now sets
  `redirect: "manual"`, which turns a 3xx into a `failed` ring; verified with a real 302.

Decisions:
- **Plain `http:` is accepted for `localhost` / `127.0.0.1` only** (and only when that host is allowlisted).
  Local check.sh rings `http://127.0.0.1:<port>/v1/_echo`, and a deployed Worker cannot reach loopback anyway.
- **Ports are not restricted; vendor paths are not checked** (host is the security property; `doorbell-set`
  still warns when a claude_fire URL does not end in `/fire`).
- **Destination check comes after the lease claim.** So a burst to a blocked destination logs one
  `blocked_destination` per send that wins the released lease (row 9a sees two), not `coalesced`.

## 6. Test aids

`/v1/_echo` and `/v1/_echo/hits` return 404 (before auth) unless `ECHO_SECRET` is set. With it set, POST still
needs the bearer and hits still need an agent key. `GET /v1/_ring_log` is unchanged apart from the added `ring`
state. `.dev.vars` was already in `.gitignore`; README documents it. The copy contains a `.dev.vars`
(mode 600) with locally generated test values only. Delete it if you like.

## 7. check.sh

New rows: `1b` (me.server_time), `2f`/`2g` (sender sees all receipts, recipient only its own; this also drains
muse before section 3), `3h` (secret stored as `enc:v1` or `plaintext`, matching `DOORBELL_MASTER_KEY` in
check.sh's env), `7w`/`7x`/`7y` (MCP parity for `me` and `thread_get`), `8a`–`8g` (rotate over REST and MCP, grace,
grace key cannot rotate, revoke, rotate after revoke), `9a` (non-allowlisted host: two sends, both
`blocked_destination`, lease released, echo +0), `9b` (an `enc:v1:` value no key opens: `error` +
`no_master_key`/`decrypt_failed`, echo +0). Final count **63/63**.

Decisions:
- **Rotation rows use a throwaway agent** `chk-rot-<ms>` (agent-add, deleted in the EXIT trap), so a
  `--remote` run never rotates the real agents' keys.
- **Row 9a needs an observable blocked host.** It rings an alias of the same local server (127.0.0.1 ↔
  localhost), so a wrongful fetch would show as an echo hit. On a remote base it uses
  `https://botline-check.invalid`, where only the status proves the block.
- **Row 9b passes with or without a master key.** It writes a random `enc:v1:` value directly, so it asserts
  fail-closed either way; the reason is checked against whether check.sh's env has the key.
- **Row 8b's grace window tolerance is ±60 s** for clock skew on remote runs.
- check.sh never prints keys; `$MK` prints only `set`/`unset`.

## 8. LICENSE + README

`LICENSE`: MIT, "Copyright (c) 2026 Patrick Sabo". `README.md` is 166 lines. It covers:
- what botline is, incl. "Muse polls" and "Unofficial; not affiliated with Anthropic, xAI or Meta";
- status v0.1-pre;
- the self-host quick start, including `DOORBELL_MASTER_KEY`, the upgrade path (migrate + reencrypt) and links
  to the three recipes, which were not edited;
- the local run with `.dev.vars`;
- the REST/MCP surface table, configuration table, admin scripts and security model list;
- costs and conformance;
- prior art.

Prior art: AgentPeerChat by name only (no URL in the plans); xixilys/agent-relay-mcp and
chipherndon/grok-bot-mcp-connector linked (both return 200); CrossWire linked to `https://crosswi.re` (the
Appendix A source) with "(cross-claude-mcp)".

Decision: the README keeps the D1 name `botline-spike`, the scripts' default and the live config's name.
Renaming touches `wrangler.jsonc`, `_d1.mjs`, `check.sh` and `package.json` against a live database.

## Before this is merged into the live tree or deployed

1. **Order matters on the live D1:**
   1. `node scripts/migrate.mjs --remote`
   2. `npx wrangler secret put DOORBELL_MASTER_KEY`
   3. `npx wrangler deploy`
   4. only then `DOORBELL_MASTER_KEY=… node scripts/doorbell-reencrypt.mjs --remote`

   Deploying before migrating turns every wrong key into 500 and breaks rotate (verified above). Re-encrypting
   before the deploy would make the old spike code send `Bearer enc:v1:…` to Claude/Grok Bot: its adapters use
   the stored value verbatim.
2. `wrangler.jsonc` now has `WEBHOOK_ALLOWED_HOSTS: ""`. For check.sh against the live Worker, set it to
   `botline.botline.workers.dev`, or rows 3c–3f fail as `blocked_destination`. Also export the same
   `DOORBELL_MASTER_KEY` and `ECHO_SECRET` in check.sh's shell.
3. The live tree moved on after my copy. `docs/spike-log.md` and `docs/recipes/claude.md` were edited there at
   21:24. My copy holds the 21:06 versions, so **keep the live versions** when merging; I did not touch either file.
   The live claude recipe now says the connector "lists all six tools"; there are seven with `key_rotate`.
4. Re-check that the live doorbells match the pins: claude's URL must be `https://api.anthropic.com/…/fire`
   and grokbot's `https://api2.cursor.sh/automations/webhook/…`. Anything else becomes `blocked_destination`
   after deploy.

## Open questions for the coordinator

- Confirm the prior-art URLs I did not use. The GitHub search finds `AgenticsWorks/AgentPeerChat` (created
  2026-10-02, matches the plan) and `rblank9/cross-claude-mcp` (17★, created 2026-03-06, matches "CrossWire
  17★ since 2026-03"). Link them if you confirm them.
- `rings.last_status` is the only place an `error` reason lives, and the next ring overwrites it. Is a
  `ring_log.detail` column worth a migration?
- `src/openapi.ts` hard-codes `servers: [{ url: "https://botline.botline.workers.dev" }]`, so a self-hoster's
  `/openapi.json` points at Patrick's Worker. Derive it from the request URL? (Not changed: out of scope.)
- The MCP `tools/list` `ttlMs` is still 30 s with the spike's "raise it for v0.1" comment; untouched.
- Self-service rotation by whoever holds the current key can lock the owner out. That is inherent; admin
  revoke + rotate recovers. Is that acceptable for v0.1?
- The pins are exact hosts. If Cursor moves Grok Bot webhooks off `api2.cursor.sh`, rings fail closed until the
  adapter constant changes. Prefer a suffix pattern?
