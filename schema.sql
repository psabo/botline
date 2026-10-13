-- botline schema (v0.1-pre). Every table carries workspace_id (Phase 1 always 'default').
-- The full fresh-install definition. Idempotent and non-destructive: safe to re-run against a live database.
-- An existing database also needs `node scripts/migrate.mjs` (adds columns that CREATE IF NOT EXISTS cannot).

CREATE TABLE IF NOT EXISTS agents (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,                 -- sha256 hex of the bearer key
  key_hash_prev TEXT,                            -- the key before the last rotation, accepted until prev_valid_until
  prev_valid_until TEXT,
  allowed_senders TEXT NOT NULL DEFAULT '*',     -- '*' or JSON array of agent ids ('[]' = nobody)
  doorbell_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (doorbell_kind IN ('none','claude_fire','grokbot_webhook','generic_webhook')),
  doorbell_url TEXT,
  doorbell_secret TEXT,                          -- enc:v1:<iv>:<ct> (AES-256-GCM, DOORBELL_MASTER_KEY) or legacy plaintext
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  hop_count INTEGER NOT NULL DEFAULT 0,
  from_agent TEXT NOT NULL,
  to_agents TEXT NOT NULL,                       -- JSON array
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  needs TEXT NOT NULL DEFAULT 'none' CHECK (needs IN ('reply','ack','none')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  meta TEXT,                                     -- JSON object
  UNIQUE (workspace_id, from_agent, idempotency_key)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (workspace_id, thread_id, created_at);

CREATE TABLE IF NOT EXISTS receipts (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  message_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  delivered_at TEXT,                             -- doorbell accepted (2xx)
  read_at TEXT,                                  -- agent fetched it via inbox
  acked_at TEXT,                                 -- agent acked it
  PRIMARY KEY (workspace_id, message_id, agent)
);
CREATE INDEX IF NOT EXISTS receipts_unread ON receipts (workspace_id, agent, read_at);

CREATE TABLE IF NOT EXISTS rings (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  agent TEXT NOT NULL,
  in_flight_since TEXT,
  lease_until TEXT,
  last_status TEXT,
  last_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,         -- consecutive failed/timeout/error rings; 5 = dead-lettered until doorbell-set
  PRIMARY KEY (workspace_id, agent)
);

CREATE TABLE IF NOT EXISTS ring_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  agent TEXT NOT NULL,
  kind TEXT,
  status TEXT NOT NULL,          -- ok | failed | timeout | coalesced | no_doorbell | hop_ceiling | nothing_unread
                                 -- | blocked_destination | error (reason in detail and rings.last_status)
                                 -- | backoff (not rung: inside the backoff after a failure) | dead_letter (not rung: 5 failures)
  http_status INTEGER,
  message_ids TEXT,              -- JSON array
  at TEXT NOT NULL,
  detail TEXT                    -- reason on error/failed/timeout rows: no_master_key | bad_master_key | decrypt_failed
                                 -- | http <status> | timeout | network_error | exception (NULL otherwise)
);

CREATE TABLE IF NOT EXISTS echo_hits (         -- test doorbell target (POST /v1/_echo; only when ECHO_SECRET is set)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  at TEXT NOT NULL,
  auth_present INTEGER NOT NULL,
  body TEXT
);

-- Hosted-interest waitlist (plan §2 rule 8): double opt-in. Only token hashes are stored. (A database created before
-- waitlist_mail may still have mail_day / mail_count columns here; nothing reads them now.)
CREATE TABLE IF NOT EXISTS waitlist (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  email TEXT NOT NULL,                           -- lowercased
  would_pay TEXT NOT NULL CHECK (would_pay IN ('yes','no','maybe')),
  source TEXT,
  created_at TEXT NOT NULL,
  confirm_token_hash TEXT,                       -- sha256 hex of the token in the confirmation link
  confirmed_at TEXT,
  delete_token_hash TEXT,                        -- sha256 hex of the token in the delete link
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX IF NOT EXISTS waitlist_confirm ON waitlist (confirm_token_hash);
CREATE INDEX IF NOT EXISTS waitlist_delete ON waitlist (delete_token_hash);

-- Confirmation mails sent, per UTC day and address: the ledger both mail caps read (3 per address, and
-- WAITLIST_MAIL_CAP_PER_DAY in all). Deleting a signup does not touch it, so sign up, delete, sign up again cannot reset
-- either cap. Days older than 2 are purged on signup.
CREATE TABLE IF NOT EXISTS waitlist_mail (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  day TEXT NOT NULL,                             -- YYYY-MM-DD (UTC)
  email_hash TEXT NOT NULL,                      -- sha256 hex of the lowercased address
  count INTEGER NOT NULL DEFAULT 0,              -- confirmation mails to that address on that day
  PRIMARY KEY (workspace_id, day, email_hash)
);
