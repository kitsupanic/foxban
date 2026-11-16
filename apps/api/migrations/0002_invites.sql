-- Migration number: 0002 	 2026-08-31T00:00:00.000Z
-- Single-use signup invites. A row is minted by an admin and consumed by the
-- signup it authorizes: `used_at IS NULL` is the "still spendable" predicate,
-- so consuming is one conditional UPDATE rather than a read-then-write.
CREATE TABLE invites(
  token TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);
