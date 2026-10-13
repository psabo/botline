# Launch checklist — v0.1 (written 2026-10-13 16:45Z)

Plan v2 §3 says: prove it on our own agents, publish the repo, post, and let the waitlist measure whether a hosted
botline is worth building. The proof is done. Everything under "Owner go" publishes something or spends money, so it
waits for Patrick's explicit go, one step at a time. Nothing in this file has been executed.

## Done, no go needed

- **Live proof.** Four conformance runs on the real agents (spike log §7–10): 24 ordered pairs, 22 replied in time; the
  two misses were one bug in Muse's own helper, fixed between runs; the three-hop loop closed twice (1:03 best case,
  4:46 at an ordinary Muse phase). Zero human clicks.
- **README** leads with the measured table and is at or under 200 lines; `docs/launch-2026-10.md` has the hop table and
  the relay table filled; the MCP diagnostic `console.log` is gone (`tsc` clean).
- **Pre-publication scrub of the working tree.** `git grep` for live keys (`bl_<8>_<32>`), routine tokens (`sk-ant-oat01-`),
  the Grok Bot webhook id, the Claude routine id: only `<id>` placeholders. Home paths rewritten to `~/`, the owner email
  replaced by `<owner email>`. `.dev.vars`, `backups/`, `.wrangler/` are gitignored. LICENSE is MIT.
- **Session C** deployed (Worker `15074558…`) and committed (`3d7319d`).

## Still owed before the posts

- **G4, the 24-hour re-run** (≥ 2026-10-14 03:30Z): `conformance.mjs --relay` once more, no human in the loop, with the
  same agents. PASS = launch; FAIL = fix first.
- **Commit the post-C docs** (spike log §6/§8–10, recipes, README, this file, `docs/backup.plist`, `src/mcp.ts`).
- **The two commits in history carry the owner email and home paths** inside `docs/spike-log.md` and the session
  reports, and the commit author is the owner's personal address. Publishing the repo publishes history. Decision:
  squash to one commit under the GitHub noreply address before the first push (the repo has no other clone, so this
  rewrites nothing anyone has). Exact commands below.

## Owner go, in order

1. **Squash and re-author** (after the docs commit, before any push):
   `cd ~/dev/botline && git config user.email "3170598+psabo@users.noreply.github.com" && git checkout --orphan v01 && git add -A && git commit -m "botline v0.1-pre: a mailbox for Claude, Grok Bot and Muse, proven live" && git branch -M main`
   (3170598 is the account's GitHub id, from `gh api user`; the old `main` with the two earlier commits is replaced).
2. **Create the repo and push** (the name `psabo/botline` is free as of 16:40Z):
   `cd ~/dev/botline && gh repo create psabo/botline --public --source . --remote origin --push --description "A small mailbox for AI agents from different vendors (Claude, Grok Bot, Muse): one Cloudflare Worker, REST + MCP, doorbells"`
   Then `REPO_URL` = `https://github.com/psabo/botline` everywhere a placeholder says `{REPO_URL}`.
   **Steps 1 and 2 done 2026-10-13 ~17:25Z:** main = one commit `04d1ca5` under the noreply address, pushed;
   https://github.com/psabo/botline is public, MIT, description set; origin/main == local HEAD.
3. **Waitlist on** (the posts link to `https://botline.dev/waitlist?source=<post>`, filled in the launch copy).
   The sender must be an address on a domain verified in Resend. **Owner decision 2026-10-13 18:40Z: botline gets its
   own domain; it borrows nothing from the owner's other product. `botline.dev` registered through Cloudflare
   ~18:50Z (delegated to the account's nameservers); verified in Resend 18:5xZ; Worker `f0029ab5…` deployed with
   `WAITLIST_FROM = botline <hello@botline.dev>` (still the first key; the send-only key is the swap below).** The
   Worker's root now serves a one-paragraph landing page to browsers (JSON index to API clients). The public `wrangler.jsonc` stays generic (empty vars),
   so this deployment's values go on the deploy command line. Put the Resend key on the clipboard, then, one per message:
   `cd ~/dev/botline && pbpaste | npx wrangler secret put RESEND_API_KEY`
   `cd ~/dev/botline && npx wrangler deploy --var 'WAITLIST_FROM:botline <hello@<the botline domain>>' --var 'REPO_URL:https://github.com/psabo/botline'`
   (every later deploy needs the same two `--var` flags, or the waitlist switches itself off again). Then open
   `/waitlist` once and sign up with your own address to see the double opt-in. Turnstile is optional.
   **Done 2026-10-13 17:45–17:50Z** (run by the coordinator on the owner's explicit permission): secret set from the
   clipboard, Worker version `259d2c94…` deployed with both vars, `/waitlist` 200 with the $9 question, the repo link and
   the privacy sentence; two probe signups with the owner's address → 202, rows stored unconfirmed, ledger 2 mails, the
   Worker logged no Resend error, and Resend's API lists both as **delivered** (17:47:34Z, 17:49:32Z). Owner: click
   Confirm in one of them (or Delete). **Key hygiene:** the key that was used can list emails, so it is not send-only,
   and it passed through a chat transcript — after launch, create a send-only key restricted to the domain, set it the
   same way, and revoke this one in the Resend dashboard. **Swapped 2026-10-13 19:31Z:** a send-only key for
   `botline.dev` is the Worker's `RESEND_API_KEY` (checked: it cannot list domains), and a signup through the Worker
   at 19:31:40Z was delivered with it. The first key (named "SolarDecode" in Resend) stays by the owner's decision
   (19:36Z, "don't delete"); nothing in botline uses it any more. (One earlier `secret put` ran with an empty clipboard and stored junk for two minutes;
   `pbpaste | wrangler secret put NAME` takes the value from the clipboard, and `NAME` is the secret's name.)
   **Deliverability (18:10Z):** both confirmation mails landed in Gmail's Spam; the owner's Confirm click registered
   (row confirmed), so the flow works. DKIM and DMARC are in place (spike log §11); the suspects are the first-time
   sender address and the `workers.dev` links. Two fixes, in order:
   3a. (coordinator) the accepted page and API message now say to look in Spam and name the sender address;
       deployed by the owner 18:25Z as Worker `ca81ff95…` with the same two `--var` flags.
   3b. (owner) botline's own domain: register it (Cloudflare Registrar keeps DNS in the same place), verify it in
       Resend (three DNS records, which Cloudflare DNS can add in one click), then attach it to the Worker as a
       custom domain. No config change; `workers.dev` keeps working. **Done 2026-10-13:** `botline.dev` registered
       ~18:47Z, verified in Resend ~18:55Z, attached to the Worker 19:21Z through the Cloudflare API with wrangler's
       login (the dashboard does the same: Workers & Pages → botline → Settings → Domains & Routes → Add → Custom
       domain), certificate live by 19:24Z; `https://botline.dev/` serves the landing page, `/waitlist` 200; one
       signup from the new host (the owner's address, `source=probe3`, 19:24:52Z) accepted with the sender
       `hello@botline.dev` and links on `botline.dev` (that address was already confirmed, so no mail was due; a
       plus-address signup at 19:26:06Z, `source=probe4`, was sent by Resend and **landed in Gmail's Inbox**, Updates
       tab, not Spam — the two mails from the first-run sender had gone to Spam). The launch copy's waitlist links
       already point at `https://botline.dev/waitlist?source=<post>`. The first-run sender used earlier that day for two probe mails
       was a subdomain of the owner's other product; it is retired and nothing public ever pointed at it.
4. **Recording** (≤ 2 minutes, no audio needed): a terminal running `conformance.mjs --relay` on the left, the three app
   windows on the right; stop when the runner prints `relay closed`. Upload anywhere that gives a plain link; that is
   `{RECORDING_URL}`.
5. **Posts**, from `docs/launch-2026-10.md` with the placeholders filled: Show HN first, 13:00–15:00Z on a weekday; the
   Claude and Grok Bot community posts the same afternoon; the Muse community post and the X thread last. Reply to every
   comment the same day; the honest limits paragraph is the answer to most of them.

## The decision

Launch Wednesday 2026-10-14: G4 run in the morning (I start it at 03:30Z and read it when you are up), docs commit,
squash, repo, waitlist, then Show HN at 14:00Z. If G4 fails, fix first and move the posts to Thursday. The hosted
service is plan phase 2 and the councilled plan gates it on a signal: 25 confirmed waitlist signups or 300 stars,
checked at the time box; nothing of it is built, by design, and the $9/month flat price stays as councilled. The day
the gate holds, phase 2 is five to seven sessions (Stripe Checkout + webhook to `workspace.plan`, hosted deployment,
retention, export and delete). Overrule any of this in one line.
