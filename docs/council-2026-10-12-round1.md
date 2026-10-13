# Council round 1 — botline plan v1 (2026-10-12)

Root: scratchpad `council-botline-v1/` (BRIEF.md + docs/plan-v1-2026-10-12.md). NONCE
BOTLINE-V1-T392AYY2TR. Residue sweep: no files newer than BRIEF.md. No duplicate jobs.

## Ratification (from records, not self-report)

| Leg | Record | Model / effort | cwd = root | nonce | Verdict |
|---|---|---|---|---|---|
| codex | `~/.codex/sessions/2026/10/12/rollout-2026-10-12T16-57-16-01a1328c-…jsonl` `turn_context` | gpt-6.1-sol / high | yes | yes (2 msgs) | SHIP-WITH-FIXES |
| gemini | `~/.gemini-companion/jobs/gemini-20261012235715-6416k.json` | gemini-3.8-flash | yes | yes | SHIP-WITH-FIXES |
| grok | `~/.grok-companion/jobs/grok-20261012235715-x1o7u.json` | grok-4.7 | yes | yes | SHIP-WITH-FIXES |

Quorum 3/3. Codex was scoped to Q1–Q3 (brief); its silence on Q4–Q7 is not a vote.

## Per-finding tally and disposition

| # | Finding | Legs | Verified against plan? | Disposition (v2) |
|---|---|---|---|---|
| 1 | Doorbell coalescing, idempotency, terminal-on-2xx/timeout, hop ceiling missing; 30 fires/h/routine would be exhausted; ambiguity re-rings double-execute | codex 1, gemini 2, grok 3 (3/3) | Yes: v1 §3B left coalescing as a question | Rule 6 + G4 + deliverable 3 |
| 2 | Spike gate too weak: one loop on the author's accounts; G1 lacks zero-click *send*; no second poll, burst, duplicate, or lapsed-approval run; doorbell 2xx ≠ delivery; "<10 min" contradicts 15-min Muse poll | codex 2, gemini Q2, grok 2 (3/3) | Yes: v1 lines 71 vs 83 contradict | G1a/G1b/G4, 24-hour re-run, two-deploy rule, honest latency |
| 3 | Phase 2 gate: OR on stars is a false positive; AND on the stop lets it drift; waitlist forgeable; no willingness-to-pay signal | codex 3, gemini 3, grok 6 (3/3) | Yes | Gate = 25 confirmed intent-to-pay; stop <10 at day 21 regardless of stars; prepaid pilot in the middle band (codex's variant) |
| 4 | Receipts: timestamp arrays without agent id; first lister consumes for all; canary marks read; `delivered_at` on 2xx misread as delivery | grok 4 (certain), gemini Q2, codex 2 (3/3 on semantics) | Yes: v1 line 96–98 | Per-recipient receipt rows; only that agent's key mutates; accepted vs acked columns |
| 5 | Multi-tenancy line: keep `workspace_id` + composite uniqueness + key-scoped loader; drop `MODE` flag, signup, billing from Phase 1 | codex Q1, gemini Q1, grok 5 (3/3) | Yes | Rules 1–2 rewritten |
| 6 | Durable Object per inbox: cut it (gemini: not on the free tier; grok: unnecessary) | gemini 1, grok Q6 (2/2 asked) | DO unnecessary: yes. **Gemini's "certain" free-tier claim is REFUTED**: Cloudflare's pricing page says "Durable Objects are available both on Workers Free and Workers Paid plans" (SQLite backend only on Free; 100k requests/day) — developers.cloudflare.com/durable-objects/platform/pricing, fetched 2026-10-12 | DO removed from v0.1 on grok's reasoning (unnecessary at this scale); the tier argument is not used anywhere |
| 7 | Injection: wrapper insufficient; ship server-stamped `from` + per-agent allowlists; drop attachments; recipes forbid URL fetching; "headline safety feature" overclaims | grok 1 (certain), gemini Q4 (2/2 asked) | Yes | Rule 5, deliverable 4, attachments out |
| 8 | Launch claim: "working doorbells for all three" is false (Muse polls); don't present Grok Bot's undocumented header as supported; don't diminish prior art publicly | gemini 5 (certain), grok Q5 (2/2 asked) | Yes: v1 §1 line overclaimed | Claim text fixed in §1/§3C/§7; "unofficial" and "undocumented; verified on 0.68.1" labels |
| 9 | Economics: free tier (2 agents) can't hold the 3-agent proof; email on $9 costed at Resend free; fan-out/rings/emails unbounded; "break-even is the domain" unsupported | grok 6, gemini Q3, codex 4 (3/3) | Yes | Free = 3 agents, vendor-fixed doorbells; billable units with caps; email metered; cost line rewritten |
| 10 | Canaries on Patrick's personal accounts: shared 30/h budget, false pages, ToS flags; "assurance" overclaims | codex 4, gemini Q3, grok 6 (3/3) | Yes | Dedicated canary workspace + routine; sampled checks; page on 2 consecutive failures |
| 11 | Zero body logging makes support blind (gemini) / bodies become a credential store (grok) | gemini Q3+Q7, grok Q7 (two halves, 1 leg each) | Plausible | Folded cheaply: opt-in debug capture with 24 h TTL; recipes say no secrets in bodies |
| 12 | Key rotation/revoke absent; waitlist data has no terms/delete; no D1 backup; shared CF/Stripe account blast radius | grok Q7 (1 leg) | Plausible, cheap | Rotate/revoke in v0.1; waitlist privacy + delete; weekly D1 export; sub-accounts as owner decision |
| 13 | v0.1 cuts: email adapter, attachments, Deploy button, DO; keep REST+MCP, hashed keys, three doorbells, recipes, waitlist | grok Q6, gemini Q6 (2/2 asked) | — | Adopted; generic webhook kept but off by default and allowlisted (gemini's SSRF point) |
| 14 | Muse may class `message_send` as a sensitive write → no Always → spike passes read but not send | grok 2 | Yes: v1 §1 said so and the gate ignored it | G1b |
| 15 | Free-tier abuse: open relay / SSRF via outbound webhooks + email | gemini 4 (likely) | Plausible | Free = fixed vendor destinations; generic webhook paid + allowlisted; verified email; caps |

Not folded: gemini's Cloudflare shared-egress-IP blocking risk (speculative; noted in risks only).
Deliberately not asked: code-level questions (there is no code); re-derivation of §1 (done on the main loop).

## Blocker call

v2 is fit for the spike. Nothing is owed before 3A except Patrick's owner items in §6. No open
factual items: the one disputed claim (DO free tier) was checked and refuted; the cut stands on
other grounds.
