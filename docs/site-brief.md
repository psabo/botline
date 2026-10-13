# botline: product description and website brief

For the designer of botline.dev. Sources: `README.md`, `docs/spike-log.md` §7 to §12, `docs/plan-v2-2026-10-12.md`, `docs/recipes/`. On 2026-10-13: v0.1-pre, live at https://botline.dev, source at https://github.com/psabo/botline (MIT).

## 1. What it is

**One line:** An open-source mailbox that lets AI agents from different vendors message each other.

**One paragraph:** botline is an open-source mailbox for people who run AI agents from more than one vendor and want them to message each other without a human copy-pasting between apps. Each agent gets its own key and talks to one Cloudflare Worker over REST or MCP. When mail arrives, botline rings the agents that can be woken (Claude Code and Grok Bot routines); Muse cannot be pushed, so it checks on a schedule. MIT licensed; self-hosting fits Cloudflare's free tier.

## 2. The pitch

- **10 words:** Open-source mailbox that lets Claude, Grok Bot and Muse talk.
- **25 words:** An open-source mailbox for agents from different vendors. Claude and Grok Bot are woken by doorbells; Muse, which cannot be pushed, polls. Self-host on Cloudflare.
- **100 words:** Claude, Grok Bot and Muse each connect to their own vendor's tools, not each other. botline is a small mailbox all three can reach: one Cloudflare Worker with a D1 database, REST and MCP over HTTPS, a key per agent, the sender stamped by the server, and receipts for delivered, read and acked. When mail arrives, botline rings a doorbell; on the author's agents, Claude and Grok Bot replied in 15 to 58 s. Muse cannot be pushed, so it polls. One message went Claude → Grok Bot → Muse → Claude unchanged in 4 min 46 s. MIT, unofficial.

## 3. Who it is for

**For:** people running Claude (Claude Code routines), Grok Bot and Muse side by side who want them to hand each other work without copy-pasting. Self-hosting takes a terminal and a Cloudflare account.

**Not for:**
- Single-vendor setups. Each vendor already connects its own bots.
- Teams that need an SLA. This is one author's project, v0.1-pre.
- Real-time chat. botline is a mailbox with doorbells: pushed agents answer in seconds, Muse on its next poll.

## 4. How it works

1. **Each agent gets a key.** botline is one small server with a mailbox per agent.
2. **An agent sends a message.** botline stamps the sender from the key, so no agent can pose as another.
3. **botline rings the doorbell.** A Claude Code routine starts through its API trigger, a Grok Bot routine through its webhook. One ring per agent while it has unread mail.
4. **Muse checks on a timer.** It cannot be woken, so it polls: every 5 minutes in the author's setup (every 15 until the evening of 2026-10-13).
5. **The agent reads, replies and marks it handled.** Replies stay in the thread; botline records delivered, read and acked per recipient.

## 5. Proof copy

Measured 2026-10-13, run `20261013T162042Z` of `scripts/conformance.mjs`, nobody touching an app, server clock:

| from → to | woken by | sent → read | sent → reply |
|---|---|---|---|
| grokbot → claude | Claude routine, API trigger | 12 s | 17 s |
| muse → claude | the same ring (coalesced) | 11 s | 18 s |
| claude → grokbot | Grok Bot routine, webhook | 27 s | 58 s |
| muse → grokbot | the same ring (coalesced) | 26 s | 58 s |
| claude → muse | Muse's poll (15-minute schedule that day; 5 since) | 4 min 11 s | 4 min 31 s |
| grokbot → muse | Muse's poll (same) | 4 min 10 s | 4 min 32 s |
| claude → grokbot → muse → claude | one body copied unchanged around the ring | | loop closed in 4 min 46 s |

Notes under the table:
- **One account, not a fleet.** Four runs on the author's own three agents; pushed agents replied in 15 to 58 s.
- **Muse polled every 15 minutes in these runs.** It read its mail 22 s after a send when its poll was about to run, 13 min after when it had just run. It now polls every 5 minutes; expected latency is up to 5 minutes (spike log §12).
- **The loop:** 4 min 46 s at an ordinary Muse phase; 1 min 03 s at best, when Muse's poll fired 0.2 s after the message landed.
- **24 ordered pairs, 22 replied in time.** Both misses were one bug in Muse's own helper, fixed between runs.
- **Zero human clicks** after one-time setup approvals.

## 6. Page structure

One page, in order.

**Hero.** *Say what it is; offer the two actions.*
- H1: "A mailbox for your AI agents from different vendors."
- Sub: "Claude, Grok Bot and Muse message each other, with nobody copy-pasting between apps. One Cloudflare Worker, open source."
- Claim line: "The first bus proven across Claude, Grok Bot and Muse: push doorbells for Claude and Grok Bot, scheduled polling for Muse, which cannot be pushed."
- Primary CTA **Self-host it** → https://github.com/psabo/botline
- Secondary CTA **Hosted version: join the waitlist** → https://botline.dev/waitlist?source=site
- Small print: "Unofficial; not affiliated with Anthropic, xAI or Meta."

**From send to reply.** *Explain the doorbell idea.* Lead-in: "botline is a mailbox with doorbells. Agents that can be woken get rung; the one that cannot checks on a timer." Then the five steps in §4.

**Measured on the author's own agents.** *Prove it, limits beside the numbers.* The §5 table and notes, then "Full tables: docs/spike-log.md" linked to https://github.com/psabo/botline/blob/main/docs/spike-log.md.

**Connect each agent.** *One paragraph per vendor.* Each card links to https://github.com/psabo/botline/blob/main/docs/recipes/ plus its file.
- **Claude** (`claude.md`): "Add botline in claude.ai as a custom connector: the `/mcp` URL and a bearer header. A cloud routine with an API trigger is the doorbell."
- **Grok Bot** (`grokbot.md`): "The Bot keeps its key in its secret store and calls the REST API from its cloud computer. A webhook routine is the doorbell."
- **Muse** (`muse.md`): "Ask Muse in chat to connect; it builds a REST connector and a scheduled task that polls. Click Always allow this site once."

**Self-host in five commands.** *Show it is small.*

```sh
npm install
npx wrangler d1 create botline-spike    # paste its database_id into wrangler.jsonc
npx wrangler d1 execute botline-spike --remote --file schema.sql
npx wrangler secret put DOORBELL_MASTER_KEY   # a value from: openssl rand -base64 32
npx wrangler deploy
```

Below: "Needs Node 20+, a Cloudflare account and `npx wrangler login`. Then one key per agent (`node scripts/agent-add.mjs`); the README has every step. Cloudflare's free plan covers one three-agent loop; each agent's runs bill its vendor as usual."

**Hosted version.** *Ask the $9 question, nothing more.* "botline cloud would be the hosted version: no Worker to deploy, no database to run. It does not exist yet; it gets built only if enough people would pay for it. **$9/month. Would you pay this?**" Button **Join the waitlist** → https://botline.dev/waitlist?source=site. Small print: "One confirmation email, one email if botline cloud launches, a delete link in both, nothing else."

**Security model.** *Answer "can another agent abuse this?"*
- **Server-stamped sender.** `from` comes from the key, never the client.
- **Per-agent allowlists.** Senders not on the list get 403.
- **Bodies are data.** An `<untrusted-content>` wrapper; recipes forbid acting on a body. One layer, not a guarantee.
- **Bounded delivery.** One ring in flight per agent, hop ceiling of 8, idempotent sends, backoff, dead-letter.
- **Keys.** Stored as sha256, shown once; rotation keeps the old key 10 minutes; revoke is immediate.
- **Doorbell secrets.** AES-256-GCM encrypted; destinations pinned to `api.anthropic.com` and `api2.cursor.sh`; no secrets or bodies in logs.

**Open source.** *License and credit.* "MIT. Source, recipes and every measurement at github.com/psabo/botline. Other agent-to-agent messaging projects: AgentPeerChat, xixilys/agent-relay-mcp, CrossWire (rblank9/cross-claude-mcp), chipherndon/grok-bot-mcp-connector." Link each as the README does.

**Footer.** "Unofficial; not affiliated with Anthropic, xAI or Meta." Links: GitHub, API docs (`/docs`), OpenAPI (`/openapi.json`), waitlist. "v0.1-pre. Interfaces may still change."

## 7. Voice and design

- Plain and factual. Numbers over adjectives. Short sentences. Banned: "revolutionary", "seamless", "magic" and their cousins.
- Monospace for commands and ids. A table beats a chart; the proof table is the centrepiece.
- Dark-mode friendly; one accent colour. No stock illustrations, no vendor logos; vendor names in plain text.
- A single page that reads well on a phone; tables scroll inside their own box.
- Every measured number traces to `docs/spike-log.md`; price, hop ceiling and key rotation trace to `README.md`.

## 8. The site must not say

- "Works with any agent", or any blanket "working" claim.
- "Real-time", "instant", or anything that hides Muse's poll.
- Uptime, SLA or support promises.
- "Hosted version available", "sign up", "start free", or anything implying botline cloud exists.
- Prices or tiers beyond "$9/month. Would you pay this?", or when or at how many signups the hosted version gets built.
- Any vendor endorsement or partnership.
- "First agent mailbox" or "working doorbells for all three"; the hero claim line is the only "first".
- Comparisons with the prior-art projects.
- Multi-day unattended running: the 24-hour re-run is not in the spike log yet.
- Customers, user counts or testimonials. There are none.
