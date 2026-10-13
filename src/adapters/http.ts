// Shared HTTP helper for the webhook-style adapters.
import type { RingPayload, RingResult } from "../doorbell";

export const INSTRUCTION =
  "Call inbox_list(unread) on botline, handle each per the recipe, reply with message_send, then message_ack.";

export const webhookBody = (p: RingPayload) => ({
  source: "botline",
  agent: p.agent,
  unread: p.unread,
  message_ids: p.message_ids,
  instruction: INSTRUCTION,
});

/** Destination pin for the vendor adapters: https and exactly the vendor's host. */
export const httpsHost = (host: string) => (url: URL) => url.protocol === "https:" && url.hostname === host;

/** POST JSON. 2xx = ok; any other status = failed; abort = timeout; network error = failed. Never retries.
 *  Never follows redirects: a 3xx is a failed ring, so the bearer cannot be bounced to a host the pin did not check. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<RingResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    });
    await res.body?.cancel();
    return { status: res.ok ? "ok" : "failed", httpStatus: res.status };
  } catch {
    return { status: signal.aborted ? "timeout" : "failed" };
  }
}
