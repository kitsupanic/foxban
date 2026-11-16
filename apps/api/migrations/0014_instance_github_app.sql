-- Migration number: 0014
-- The instance's one GitHub App (ADR 0064), created by GitHub's app-manifest flow.
-- A single row (id is pinned to 1). The private key, webhook secret and client
-- secret are AES-GCM sealed with the GITHUB_APP_ENCRYPTION_KEY Worker secret;
-- app_id, slug and client_id are public identifiers and stay plain.
CREATE TABLE github_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  client_id TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,
  webhook_secret_enc TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
