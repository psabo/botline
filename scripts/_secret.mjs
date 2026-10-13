// Node twin of src/secrets.ts (encrypt side): enc:v1:<iv_b64>:<ciphertext_b64>, AES-256-GCM, 12-byte IV,
// AAD "<workspace_id>/<agent_id>". The key is DOORBELL_MASTER_KEY: base64 of 32 random bytes (`openssl rand -base64 32`).
import { die } from "./_d1.mjs";

const MASTER_RE = /^[A-Za-z0-9+/]{43}=$/;

/** The master key from the environment, or null if unset. Exits on a malformed key. */
export function masterKeyFromEnv() {
  const k = process.env.DOORBELL_MASTER_KEY;
  if (!k) return null;
  if (!MASTER_RE.test(k)) die("DOORBELL_MASTER_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)");
  return k;
}

export async function sealSecret(plain, masterB64, aad) {
  const key = await crypto.subtle.importKey("raw", Buffer.from(masterB64, "base64"), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(plain));
  return `enc:v1:${Buffer.from(iv).toString("base64")}:${Buffer.from(ct).toString("base64")}`;
}
