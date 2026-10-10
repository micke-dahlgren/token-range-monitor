-- Token Range Monitor sync backend: initial schema.
-- All timestamps are milliseconds since the Unix epoch (Date.now()).

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT,
  created_at INTEGER NOT NULL
);

-- One row per sign-in method (google / github) attached to a user.
CREATE TABLE identities (
  provider         TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            TEXT,
  email_verified   INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX identities_email ON identities(email);
CREATE INDEX identities_user ON identities(user_id);

-- A linked Claude Code install. Only the SHA-256 of its bearer token is kept.
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX devices_user ON devices(user_id);

-- Pending device-link codes (10 minute lifetime, one-time).
-- ip_hash: HMAC of the requesting IP, used only for the /v1/link/start rate limit.
CREATE TABLE link_codes (
  code            TEXT PRIMARY KEY,
  poll_token_hash TEXT NOT NULL UNIQUE,
  user_id         TEXT NULL,
  device_name     TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  claimed         INTEGER NOT NULL DEFAULT 0,
  ip_hash         TEXT
);
CREATE INDEX link_codes_ip ON link_codes(ip_hash, created_at);
CREATE INDEX link_codes_expires ON link_codes(expires_at);

-- Phase 2: synced usage-limit lists. account_hash = HMAC(ACCOUNT_HASH_KEY, claude account id);
-- key = the mod's per-session list key without the account prefix (r:<id>, w:<id>, u:<id>).
CREATE TABLE lists (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_hash TEXT NOT NULL,
  key          TEXT NOT NULL,
  kind         TEXT NOT NULL,
  data         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, account_hash, key)
);
CREATE INDEX lists_updated ON lists(user_id, account_hash, updated_at);
