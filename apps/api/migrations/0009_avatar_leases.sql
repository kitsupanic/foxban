-- Migration number: 0009 	 2026-09-10T00:00:00.000Z
CREATE TABLE IF NOT EXISTS avatar_leases (
  user_id TEXT NOT NULL,
  version TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, version)
);
