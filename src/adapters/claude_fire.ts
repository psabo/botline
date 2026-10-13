// Claude Code cloud routine API trigger: POST https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire
// Verified 2026-10-13 against platform.claude.com/docs/en/api/claude-code/routines-fire:
// anthropic-version 2023-06-01 required; the beta header is optional and still accepted; body {text} <= 65,536 chars.
import type { Adapter } from "../doorbell";
import { INSTRUCTION, httpsHost, postJson } from "./http";

export const allows = httpsHost("api.anthropic.com");

export const ring: Adapter = (d, p, signal) =>
  postJson(
    d.url,
    {
      authorization: `Bearer ${d.secret ?? ""}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
    },
    { text: `botline: ${p.unread} unread message(s) for agent ${p.agent}. ${INSTRUCTION}` },
    signal,
  );
