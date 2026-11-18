-- Login sweeps expired sessions and a password change drops a user's other
-- sessions; without these, both read the whole table.
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
