// Doorbell secrets at rest (plan §2 rule 7). Stored form: enc:v1:<iv_b64>:<ciphertext_b64>, AES-256-GCM with a
// 12-byte IV and AAD "<workspace_id>/<agent_id>", so a ciphertext copied onto another agent's row does not decrypt.
// The Worker only decrypts; scripts/_secret.mjs encrypts (keep the two in step). A value without the `enc:` prefix is
// legacy plaintext and is used as is. Anything else fails closed: the ring is not sent.
export type Opened = { ok: true; secret: string | null } | { ok: false; reason: "no_master_key" | "bad_master_key" | "decrypt_failed" };

const MASTER_RE = /^[A-Za-z0-9+/]{43}=$/; // base64 of exactly 32 bytes (`openssl rand -base64 32`)
const ENC_RE = /^enc:v1:([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/;
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let cached: { b64: string; key: CryptoKey } | null = null;
async function masterKey(b64: string): Promise<CryptoKey | null> {
  if (!MASTER_RE.test(b64)) return null;
  if (cached?.b64 !== b64) cached = { b64, key: await crypto.subtle.importKey("raw", unb64(b64), "AES-GCM", false, ["decrypt"]) };
  return cached.key;
}

export async function openSecret(stored: string | null, master: string | undefined, aad: string): Promise<Opened> {
  if (stored === null || !stored.startsWith("enc:")) return { ok: true, secret: stored };
  if (!master) return { ok: false, reason: "no_master_key" };
  const key = await masterKey(master);
  if (!key) return { ok: false, reason: "bad_master_key" };
  const m = ENC_RE.exec(stored);
  if (!m) return { ok: false, reason: "decrypt_failed" };
  try {
    const iv = unb64(m[1]);
    if (iv.length !== 12) return { ok: false, reason: "decrypt_failed" };
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, unb64(m[2]));
    return { ok: true, secret: new TextDecoder().decode(pt) };
  } catch {
    return { ok: false, reason: "decrypt_failed" };
  }
}
