-- GitHub proofs kept on the session that earned them (ADR 0081). The link and reauth starts store a hash of their
-- OAuth state here, with the flow's purpose ('link' | 'reauth'); the callback spends it once, before it expires.
-- A reauth that GitHub approved as the account's own GitHub id leaves `github_reauth_until`, which a password-less
-- account needs, once, to set its first password.
ALTER TABLE sessions ADD COLUMN github_link_state_hash TEXT;
ALTER TABLE sessions ADD COLUMN github_link_expires_at INTEGER;
ALTER TABLE sessions ADD COLUMN github_link_purpose TEXT;
ALTER TABLE sessions ADD COLUMN github_reauth_until INTEGER;
