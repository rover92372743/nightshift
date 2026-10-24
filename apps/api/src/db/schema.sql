-- Docket schema. Applied idempotently on boot (see db/index.ts).
-- Money is stored as integer micro-credits everywhere. Never floats.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('session','key','node')),
  label       TEXT,
  api_key_hash TEXT UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  delta_micro INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('grant','charge','earn','payout','refund')),
  ref         TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account_id, created_at);

CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  class           TEXT NOT NULL CHECK (class IN ('browser','native','cloud','external')),
  label           TEXT NOT NULL,
  public_key      TEXT NOT NULL UNIQUE,
  capabilities    TEXT NOT NULL,            -- JSON NodeCapabilities
  status          TEXT NOT NULL DEFAULT 'online',
  last_seen       INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  jobs_done       INTEGER NOT NULL DEFAULT 0,
  jobs_failed     INTEGER NOT NULL DEFAULT 0,
  units_verified  INTEGER NOT NULL DEFAULT 0,
  earned_micro    INTEGER NOT NULL DEFAULT 0,
  online_ms_24h   INTEGER NOT NULL DEFAULT 0,
  uptime_day      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS nodes_status ON nodes(status, last_seen);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  status           TEXT NOT NULL,
  requester_id     TEXT NOT NULL REFERENCES accounts(id),
  input            TEXT NOT NULL,           -- JSON JobInput
  input_hash       TEXT NOT NULL,
  output           TEXT,                    -- JSON JobOutput
  node_id          TEXT REFERENCES nodes(id),
  lease_expires_at INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  price_micro      INTEGER NOT NULL,
  cost_micro       INTEGER,
  created_at       INTEGER NOT NULL,
  assigned_at      INTEGER,
  started_at       INTEGER,
  finished_at      INTEGER,
  error            TEXT,
  scrubbed         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS jobs_requester ON jobs(requester_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_node ON jobs(node_id, finished_at);

CREATE TABLE IF NOT EXISTS receipts (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  body        TEXT NOT NULL,                -- canonical JSON ReceiptBody
  node_sig    TEXT NOT NULL,
  router_sig  TEXT NOT NULL,
  node_key    TEXT NOT NULL,
  router_key  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  amount_micro INTEGER NOT NULL,
  rail         TEXT NOT NULL,               -- 'credits' | 'usdc' | 'sol'
  address      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  tx_ref       TEXT,
  created_at   INTEGER NOT NULL,
  settled_at   INTEGER
);

CREATE TABLE IF NOT EXISTS quotes (
  id          TEXT PRIMARY KEY,
  company     TEXT NOT NULL,
  email       TEXT NOT NULL,
  need        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
