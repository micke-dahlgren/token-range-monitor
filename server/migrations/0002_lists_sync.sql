-- Phase 2: the /v1/lists sync API, device expiry and retention.

-- Which device last wrote a list (informational; not a foreign key, because an
-- expired device is deleted while its lists live on until they age out).
ALTER TABLE lists ADD COLUMN device_id TEXT;

-- GET /v1/lists pages through (updated_at, key) for one user + account.
DROP INDEX IF EXISTS lists_updated;
CREATE INDEX lists_sync ON lists(user_id, account_hash, updated_at, key);

-- No index on lists(updated_at) alone: in D1 every index holding a written
-- column costs an extra row write per list upsert, while the daily retention
-- purge can instead walk the table by rowid (a scan of reads once a day).

-- The daily cron deletes devices unused for 90 days.
CREATE INDEX devices_last_seen ON devices(last_seen_at);
