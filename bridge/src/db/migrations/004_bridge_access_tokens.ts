/**
 * Migration 004: bridge-issued access tokens.
 *
 * The app-facing `Authorization: Bearer` credential stops being the Cloudflare
 * Access JWT (whose ~hours lifetime made the refresh grant useless: it could
 * only re-serve an already-expiring assertion). /auth/token now mints opaque
 * bridge access tokens; the assertion is verified exactly once, at the
 * authorization-code exchange. The .sql file with the identical content lives
 * alongside.
 */
export const MIGRATION_004_SQL = `
CREATE TABLE oauth_access_tokens (
  tokenHash TEXT PRIMARY KEY,
  clientId TEXT NOT NULL REFERENCES oauth_clients(clientId),
  subject TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_oauth_access_tokens_expiresAt ON oauth_access_tokens(expiresAt);
`;
