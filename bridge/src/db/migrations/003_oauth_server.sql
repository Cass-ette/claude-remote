-- Migration 003: bridge OAuth authorization server tables (spec §10.2
-- revision — the Bridge itself is the OAuth authorization server because
-- Cloudflare Access exposes no OAuth authorization endpoint).
--
--   oauth_clients         — RFC 7591 dynamic public client registrations.
--                           Open registration is capped by the store, not the
--                           schema; rows are tiny and never hold secrets
--                           (public clients have no client_secret).
--   oauth_codes           — authorization codes: 5-minute single-use, stored
--                           hashed. Holds the verified CF Access assertion so
--                           /auth/token can hand it back as the access_token;
--                           never logged, deleted on consumption.
--   oauth_refresh_tokens  — refresh tokens: hashed. Hold the same assertion
--                           so a refresh can re-serve it while still valid;
--                           deleted once the assertion expires.

CREATE TABLE oauth_clients (
  clientId TEXT PRIMARY KEY,
  redirectUri TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  codeHash TEXT PRIMARY KEY,
  clientId TEXT NOT NULL REFERENCES oauth_clients(clientId),
  redirectUri TEXT NOT NULL,
  subject TEXT NOT NULL,
  assertion TEXT NOT NULL,
  codeChallenge TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  consumedAt INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE TABLE oauth_refresh_tokens (
  tokenHash TEXT PRIMARY KEY,
  clientId TEXT NOT NULL REFERENCES oauth_clients(clientId),
  subject TEXT NOT NULL,
  assertion TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
