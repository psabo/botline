// Grok Bot routine with a webhook trigger: POST + Authorization: Bearer <key>. 200 = run started, not delivered.
// Host as recorded 2026-10-13 (docs/spike-log.md §2d): https://api2.cursor.sh/automations/webhook/<id>.
import type { Adapter } from "../doorbell";
import { httpsHost, postJson, webhookBody } from "./http";

export const allows = httpsHost("api2.cursor.sh");

export const ring: Adapter = (d, p, signal) =>
  postJson(d.url, { authorization: `Bearer ${d.secret ?? ""}` }, webhookBody(p), signal);
