-- invites.token_hash now holds the SHA-256 of the signup token, not the token itself (ADR 0085).
ALTER TABLE invites RENAME COLUMN token TO token_hash;
-- Every unspent row holds a raw token that matches no lookup any more (D1 has no SHA-256 to rehash it
-- with), so clear them: admins mint new links. Spent rows stay as the audit trail of who used what;
-- nothing reads their value, and a spent token cannot be claimed again.
DELETE FROM invites WHERE used_at IS NULL;
