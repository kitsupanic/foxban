-- GitHub signup built its no-reply address with the login's capitals (`1+OctoCat@users.noreply.github.com`), but every
-- email lookup lowercases, so such an account could never sign in by email once it set a password. Lowercase them.
-- The numeric id before the `+` keeps the rewritten addresses unique.
-- An address someone already holds in lowercase is left alone rather than failing the migration on UNIQUE.
UPDATE users SET email = lower(email)
WHERE email LIKE '%@users.noreply.github.com'
  AND NOT EXISTS (SELECT 1 FROM users other WHERE other.email = lower(users.email) AND other.id <> users.id);
