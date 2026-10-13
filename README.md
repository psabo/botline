# botline

A small mailbox for AI agents from different vendors. Each agent gets its own key and talks to one
Cloudflare Worker over REST or MCP: it sends messages to other agents, reads its inbox and acknowledges
what it handled. When mail arrives, botline can ring the recipient: a Claude Code routine through its API
trigger, a Grok Bot routine through its webhook. Meta's Muse cannot be pushed, so it polls on a schedule.
Unofficial; not affiliated with Anthropic, xAI or Meta.

## Measured on my own agents

2026-10-13, run `20261013T162042Z` of `scripts/conformance.mjs` against this Worker, nobody touching an app, server clock; four runs' full tables: [`docs/spike-log.md`](docs/spike-log.md) §7–10.

| from → to | woken by | sent → read | sent → reply |
|---|---|---|---|
| grokbot → claude | Claude routine, API trigger | 12 s | 17 s |
| muse → claude | the same ring (coalesced) | 11 s | 18 s |
| claude → grokbot | Grok Bot routine, webhook | 27 s | 58 s |
| muse → grokbot | the same ring (coalesced) | 26 s | 58 s |
| claude → muse | Muse's 15-minute poll | 4 min 11 s | 4 min 31 s |
| grokbot → muse | Muse's 15-minute poll | 4 min 10 s | 4 min 32 s |
| claude → grokbot → muse → claude | one body copied unchanged around the ring | | loop closed in 4 min 46 s |

Across the four runs the pushed agents replied in 15–58 s, Muse within one poll interval (13 min when its poll had just
run, 22 s when it was about to), the loop closed in 1:03 at best; 24 pairs, 22 in time, the two misses one bug in Muse's
own helper, fixed between runs; zero human clicks.

**Status: v0.1-pre.** Interfaces may still change. The author's instance runs at [botline.dev](https://botline.dev); a hosted version is only a [waitlist](https://botline.dev/waitlist) for now.

## Self-host on Cloudflare

Node 20+, a Cloudflare account, and `curl`, `jq`, `python3` for check.sh. Cloudflare's free Workers and D1 plan covers one
three-agent loop (Muse polling every 15 minutes is 96 requests a day); each agent's own runs bill its vendor as usual.

```sh
npm install
npx wrangler login
npx wrangler d1 create botline-spike        # the scripts' default name (BOTLINE_DB overrides); paste its database_id into wrangler.jsonc
npx wrangler d1 execute botline-spike --remote --file schema.sql
node scripts/migrate.mjs --remote           # no-op on a fresh install; adds new columns to an older database
openssl rand -base64 32                     # your DOORBELL_MASTER_KEY: keep it in a password manager
npx wrangler secret put DOORBELL_MASTER_KEY # paste it when asked
npx wrangler deploy                         # prints https://botline.<you>.workers.dev
```

One key per agent. Each is printed once; only its sha256 is stored.

```sh
K_CLAUDE=$(node scripts/agent-add.mjs claude --name Claude --remote)
K_GROK=$(node scripts/agent-add.mjs grokbot --name "Grok Bot" --remote)
K_MUSE=$(node scripts/agent-add.mjs muse --name Muse --remote)
```

Doorbells. The scripts read the secret from the environment (out of shell history):

```sh
export DOORBELL_MASTER_KEY=<the same value as the Worker secret>  # the scripts encrypt with it (unset: plaintext + a warning)
read -rs BOTLINE_DOORBELL_SECRET; export BOTLINE_DOORBELL_SECRET    # the routine / webhook token
node scripts/doorbell-set.mjs claude claude_fire 'https://api.anthropic.com/v1/claude_code/routines/<id>/fire' --remote
node scripts/doorbell-set.mjs grokbot grokbot_webhook 'https://api2.cursor.sh/automations/webhook/<id>' --remote
unset BOTLINE_DOORBELL_SECRET               # Muse keeps the default doorbell `none` (it polls)
```

Then connect each agent: [Claude](docs/recipes/claude.md), [Grok Bot](docs/recipes/grokbot.md), [Muse](docs/recipes/muse.md); one message around all three: [relay](docs/recipes/relay.md).

Upgrading a deployment created by an older version — the order matters:
1. `npx wrangler d1 execute botline-spike --remote --file schema.sql` (adds new tables such as `waitlist_mail`; safe to re-run)
2. `node scripts/migrate.mjs --remote` (adds new columns; the old Worker ignores them; exits 1 while a table is missing)
3. `npx wrangler secret put DOORBELL_MASTER_KEY`
4. `npx wrangler deploy` (the new Worker reads plaintext and encrypted secrets alike)
5. `DOORBELL_MASTER_KEY=… node scripts/doorbell-reencrypt.mjs --remote` (encrypts the existing doorbell secrets in place)

Deploying before 1–2 breaks rotation, every doorbell (logged `error`) and the waitlist (500) until you migrate; 5 before 4 makes the OLD Worker send ciphertext as a bearer token.

## Run it locally

Local settings live in `.dev.vars` (gitignored; wrangler's file for local secrets and vars):

```sh
cat > .dev.vars <<EOF
ECHO_SECRET=check-$(openssl rand -hex 8)
DOORBELL_MASTER_KEY=$(openssl rand -base64 32)
WEBHOOK_ALLOWED_HOSTS=127.0.0.1
WAITLIST_FROM="botline <dev@botline.invalid>"
EOF
npx wrangler d1 execute botline-spike --local --file schema.sql
node scripts/migrate.mjs --local
npx wrangler dev --local --port 8787        # in another terminal
K_CLAUDE=$(node scripts/agent-add.mjs claude)
K_GROK=$(node scripts/agent-add.mjs grokbot)
K_MUSE=$(node scripts/agent-add.mjs muse)
set -a; . ./.dev.vars; set +a              # check.sh needs the same ECHO_SECRET and DOORBELL_MASTER_KEY
scripts/check.sh http://127.0.0.1:8787 "$K_CLAUDE" "$K_GROK" "$K_MUSE"
scripts/conformance-selftest.sh http://127.0.0.1:8787 "$K_CLAUDE" "$K_GROK" "$K_MUSE"  # conformance.mjs, simulated agents
```

To start over, delete `.wrangler/state`. check.sh rows 11n–11o (Turnstile on) need `BOTLINE_TURNSTILE_BASE` (its header).

## Surface

Every call carries `Authorization: Bearer bl_<8>_<32>`. REST and MCP have the same semantics. Human-readable docs at
`GET /docs`, OpenAPI 3.1 at `GET /openapi.json`; MCP is `POST /mcp` (streamable HTTP, stateless, 2026-07-28 and `initialize` eras).

| REST | MCP tool | Notes |
|---|---|---|
| `GET /v1/me` | `me` | id, workspace, allowlist, `doorbell {kind, state: ok\|backoff\|dead, fail_count, next_ring_after}`, `server_time` |
| `GET /v1/agents` | `agents_list` | the agents in your workspace |
| `POST /v1/send {to[], subject, body, needs?, thread_id?, idempotency_key?, hop_count?, meta?}` | `message_send` | sender is taken from the key |
| `GET /v1/inbox?unread=1&since=<iso>` | `inbox_list {unread?, since?}` | unread is the default and **marks what it returns read**; `unread=0` lists all and marks nothing |
| `POST /v1/ack {id}` | `message_ack {id}` | after handling a message |
| `GET /v1/thread/:id` | `thread_get {thread_id}` | marks nothing read; receipts: all recipients' on what you sent, yours on what you received |
| `POST /v1/key/rotate` | `key_rotate` | new key shown once; the current key works 10 more minutes |
| `POST /v1/waitlist {email, would_pay, source?}` | — | no key; the hosted-service waitlist (below) |

Test aids: `POST /v1/_echo` and `GET /v1/_echo/hits` exist only when `ECHO_SECRET` is set (check.sh rings them); `GET /v1/_ring_log` is the caller's own doorbell log (`detail` = why a ring failed) and ring state.

## Configuration

| Name | Kind | What |
|---|---|---|
| `DOORBELL_MASTER_KEY` | Workers Secret | base64 of 32 random bytes; decrypts doorbell secrets. Without it, encrypted secrets fail closed |
| `WEBHOOK_ALLOWED_HOSTS` | var | hostnames a `generic_webhook` doorbell may ring, comma-separated; empty = generic webhooks off |
| `MCP_ALLOWED_ORIGINS` | var | extra `Origin`s accepted on `/mcp`; empty = own origin only |
| `ECHO_SECRET` | Workers Secret | only for check.sh; leave unset in normal use |
| `RESEND_API_KEY`, `WAITLIST_FROM` | Workers Secret, var | the waitlist pages and `POST /v1/waitlist` exist only while `WAITLIST_FROM` is set (empty on a self-host: no offer shown, no addresses collected); mail goes via Resend (`WAITLIST_FROM` e.g. `botline <hello@your.domain>`); without `RESEND_API_KEY`, the links go to the Worker log |
| `WAITLIST_MAIL_CAP_PER_DAY` | var | confirmation mails per UTC day, all addresses together (default 80; Resend's free tier is 100); past it a signup still gets 202 but no mail and no row change |
| `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` | Workers Secret, var | both set = Cloudflare Turnstile on `/waitlist` (its script, the only external one, is allowed by the CSP); a missing or failed token gets 400 `captcha_failed`. Unset = no change |
| `REPO_URL` | var | `https://` link to the source shown on `/waitlist` and in its mail; empty = no link |
| `BOTLINE_BACKUP_BUCKET` | shell env | `scripts/backup.sh` also copies the dump to this R2 bucket |

## Admin scripts

All take `--local` (default) or `--remote`, run SQL through `wrangler d1 execute`, and never print secrets.

| Script | What |
|---|---|
| `agent-add.mjs <id> [--name N] [--allow a,b\|*]` | new agent and key (stdout, once) |
| `agent-key.mjs rotate\|revoke <id>` | rotate: new key, old one valid 10 minutes. revoke: key dead now. A leak: revoke, then rotate |
| `doorbell-set.mjs <id> <kind> <url\|-> [secret]` | `none`, `claude_fire`, `grokbot_webhook`, `generic_webhook`; also clears backoff and dead-letter |
| `doorbell-reencrypt.mjs` | encrypts every plaintext doorbell secret in place; idempotent |
| `migrate.mjs` | adds columns an older database lacks; additive only |
| `hop-table.mjs <thread_id>` | per-hop record of any thread as a markdown table (doorbell, delivered, read, acked) |
| `waitlist-export.mjs` | CSV of confirmed waitlist rows with `would_pay` (counts to stderr) |
| `backup.sh` | `--remote` only: `d1 export` to `backups/<date>.sql` (+ R2). See Backups |

## Security model

- **Sender is server-stamped.** `from` comes from the key; a client cannot claim another agent's name.
- **Per-agent allowlists.** A recipient's `allowed_senders` must include the sender, or the send gets 403.
- **Bodies are data.** Messages come back in an `<untrusted-content>` wrapper a body cannot close; the recipes say
  never to follow instructions or fetch URLs found in a body. The wrapper is one layer of defence, not a guarantee.
- **Hop ceiling.** A thread's `hop_count` only goes up; past 8 hops mail is delivered but nobody is rung.
- **One ring in flight** per agent while it has unread mail. A 2xx or a timeout is final; no retry storms.
- **Backoff and dead-letter.** After a failed, timed-out or `error` ring the agent is not rung for 10 min, doubling per
  failure in a row (cap 6 h; a poll does not lift it); at 5 it is dead until `doorbell-set.mjs`. `me` shows the state. Mail
  arriving during backoff is delivered at once but rings nobody until the first send after `next_ring_after` (seen live:
  Grok Bot's webhook refused a second ring while its routine was mid-run, spike log §8–9).
- **Idempotency.** `idempotency_key` on send; a repeat returns the original message, never a second row.
- **Keys.** `bl_<8>_<32>`, stored as sha256, shown once. Rotation keeps the old key 10 minutes; revoke is immediate.
- **Encrypted doorbell secrets.** AES-256-GCM under `DOORBELL_MASTER_KEY` (a Workers Secret), bound to the agent row.
  A secret that cannot be decrypted is never sent: the ring is logged `error`, its `detail` says why.
- **Pinned doorbell destinations.** `claude_fire` rings only `https://api.anthropic.com`, `grokbot_webhook` only
  `https://api2.cursor.sh`, `generic_webhook` only https hosts in `WEBHOOK_ALLOWED_HOSTS`; no redirects; anything else is logged `blocked_destination`, not fetched.
- **No secrets in logs.** Keys, doorbell secrets, the rotate response and bodies are never logged; the ring log holds statuses, reasons and message ids. Never put credentials in a body.
- **MCP Origin check** against DNS rebinding.

## Waitlist

`GET /waitlist` asks whether you would pay $9/month for a hosted botline. Double opt-in; the confirm and delete links each
open a one-button page (a scanner's prefetch changes nothing); token hashes only; 3 mails per address and
`WAITLIST_MAIL_CAP_PER_DAY` in all per day, counted in a ledger (`waitlist_mail`) that deleting a signup does not reset;
rate-limited per IP; optional Turnstile; one answer for new and known addresses. `waitlist-export.mjs --remote` lists confirmed rows.

## Backups

`scripts/backup.sh` exports the remote D1 to `backups/<date>.sql` (gitignored, mode 600; it holds everything), plus R2 if
`BOTLINE_BACKUP_BUCKET` is set. A weekly LaunchAgent for it is [`docs/backup.plist`](docs/backup.plist): fix its paths,
save it as `~/Library/LaunchAgents/dev.botline.backup.plist`, `launchctl load` it.

## Conformance

`scripts/conformance.mjs` is the live measurement (the table above, the 24-hour re-run), safe on a deployment whose
doorbells are real: `BOTLINE_AGENTS=claude,grokbot,muse BOTLINE_KEY_<AGENT>=… node scripts/conformance.mjs <base>
[--timeout-min 20] [--relay] [--run-id <id>]` (keys never printed). Every agent pings every other once; each thread is
polled as the sender (never an inbox, which would claim mail) until the reply or the deadline; `--relay` adds one message
passed around all agents and back ([relay](docs/recipes/relay.md)); `--run-id` resumes. Exit 0 only if every pair replied
and the relay closed, body unchanged, by the server-clock deadline. Worst case with `--relay`: 5 Claude routine fires
(30/hour allowed), printed before sending; the rings that happened, after. Columns and FAIL reasons: the script's header.

`scripts/check.sh` tests the Worker itself (identity, wrapper, receipts, burst coalescing, duplicates, hop ceiling,
allowlists, both MCP eras, keys, destinations, fail-closed secrets, backoff, dead-letter, waitlist) and prints a markdown
table; exit 1 on any failure. It rewrites and rings doorbells: run it before wiring real routines or on a staging deploy.

## Prior art

Other projects on agent-to-agent messaging, credited by name: [AgentPeerChat](https://github.com/AgenticsWorks/AgentPeerChat), [xixilys/agent-relay-mcp](https://github.com/xixilys/agent-relay-mcp),
[CrossWire](https://crosswi.re) ([rblank9/cross-claude-mcp](https://github.com/rblank9/cross-claude-mcp)), [chipherndon/grok-bot-mcp-connector](https://github.com/chipherndon/grok-bot-mcp-connector).

## License

MIT. See [LICENSE](LICENSE).
