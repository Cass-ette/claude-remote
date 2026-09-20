/**
 * Bridge OAuth authorization server (revised spec §10.2).
 *
 * Cloudflare Access exposes NO OAuth authorization endpoint (the original
 * spec assumed a "Managed OAuth" that does not exist: the team domain's
 * OIDC discovery carries only issuer+jwks, and every SaaS-OAuth path 404s).
 * The revision keeps Cloudflare Access as the identity provider — the human
 * still authenticates with email One-time PIN at the Access edge — while the
 * Bridge itself becomes a minimal OAuth 2.0 authorization server:
 *
 *   GET  /.well-known/oauth-authorization-server  RFC 8414 metadata
 *   POST /auth/registration                       RFC 7591 public client
 *   GET  /auth/authorize                          PKCE S256 authorization
 *                                                code, BEHIND Access
 *   POST /auth/token                              code exchange / refresh
 *   GET  /.well-known/assetlinks.json             Android App Links
 *
 * Flow: the app discovers metadata, dynamically registers a public client
 * (redirect_uri pinned to https://<publicHost>/auth/callback), and opens the
 * system browser at /auth/authorize. The Access edge challenges the human
 * (email OTP) and injects Cf-Access-Jwt-Assertion at the origin; the Bridge
 * verifies that assertion, mints a 5-minute single-use authorization code
 * bound to (client, redirect_uri, PKCE challenge, subject, the raw
 * assertion), and 302s back to the https redirect URI. The Android App Link
 * delivers the code to the app, which exchanges it at /auth/token with the
 * PKCE verifier. The Bridge then mints its OWN opaque access token (7 days,
 * stored hashed) plus a refresh token (30 days); the app presents the access
 * token as `Authorization: Bearer` on /api/v1 and the WS endpoint (verified
 * by createBridgeAccessVerifier — a hash lookup, not a JWT). The Access
 * assertion is verified exactly once, at the code exchange; the refresh
 * grant re-mints access tokens without touching the assertion, so sessions
 * survive the assertion's ~hours lifetime. Once the refresh token itself
 * expires the device must re-run the flow.
 *
 * SECURITY INVARIANTS:
 * - Codes and refresh tokens are stored HASHED (sha256 hex) exactly like
 *   pairing tokens and device sessions; the raw value appears exactly once,
 *   in the response to the holder. The raw assertion is persisted only in
 *   the code/refresh rows (0600 database in the 0700 data dir) because the
 *   token endpoint must hand it back; it is never logged or audited.
 * - redirect_uri is validated against the EXACT registered string and pinned
 *   to https://<publicHost>/auth/callback at registration; error responses
 *   NEVER redirect — no open-redirect surface.
 * - Authorization codes are single-use (atomic UPDATE guard) and expire in
 *   five minutes; PKCE S256 is mandatory (plain is rejected).
 * - Dynamic registration is open but capped (single-owner deployment);
 *   public clients carry no secret, so a leaked client_id grants nothing.
 * - Local-only mode (verifier null) never serves these routes; main.ts does
 *   not register them without both a verifier and BRIDGE_PUBLIC_HOST.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  extractRawAssertion,
  InvalidAssertionError,
  type AccessIdentitySource,
  type AccessJwtVerifier,
  type VerifiedAccessIdentity,
} from "./access-jwt-verifier.js";
import type { SqliteDatabase } from "../db/database.js";
import type { AuditLog } from "../audit/audit-log.js";

/** Authorization-code lifetime (single use): five minutes. */
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
/** Bridge-issued access token lifetime: seven days. */
export const BRIDGE_ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Refresh token lifetime: thirty days (longer than the access token, so an
 * idle app can always mint a fresh access token; past it, re-run the flow). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Dynamic-registration cap; a single-owner deployment needs far fewer. */
const MAX_OAUTH_CLIENTS = 64;
/** Android application whose App Link verification assetlinks.json declares. */
export const ANDROID_PACKAGE_NAME = "dev.clauderemote.android";
/** The one redirect path the registrar accepts under the public host. */
export const OAUTH_REDIRECT_PATH = "/auth/callback";

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const randomToken = (): string => randomBytes(32).toString("base64url");

export interface OAuthClientRow {
  readonly clientId: string;
  readonly redirectUri: string;
}

export interface OAuthCodeRow {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly subject: string;
  readonly assertion: string;
  readonly codeChallenge: string;
}

export interface OAuthRefreshRow {
  readonly clientId: string;
  readonly subject: string;
  readonly assertion: string;
  readonly expiresAt: number;
}

export interface OAuthStore {
  /**
   * Register a public client. Returns "capacity" once the client table is
   * full (open registration is capped, not purged — rows never expire and
   * never hold secrets).
   */
  registerClient(redirectUri: string, now: number): OAuthClientRow | "capacity";
  findClient(clientId: string): OAuthClientRow | undefined;
  /** Insert a fresh authorization code bound to its validation context. */
  insertCode(row: OAuthCodeRow, codeHash: string, expiresAt: number, now: number): void;
  /**
   * Atomically consume an unconsumed, unexpired code (single use); returns
   * null for unknown, already-consumed, or expired codes. Expired rows are
   * deleted opportunistically.
   */
  consumeCode(codeHash: string, now: number): OAuthCodeRow | null;
  insertRefreshToken(row: OAuthRefreshRow, tokenHash: string, now: number): void;
  findRefreshToken(tokenHash: string): OAuthRefreshRow | null;
  deleteRefreshToken(tokenHash: string): void;
  /** Insert a freshly minted bridge access token (hash-stored). */
  insertAccessToken(row: OAuthAccessTokenRow, tokenHash: string, now: number): void;
  /** Resolve an unexpired bridge access token; null for unknown/expired. */
  findAccessToken(tokenHash: string, now: number): { subject: string; expiresAt: number } | null;
}

export interface OAuthAccessTokenRow {
  readonly clientId: string;
  readonly subject: string;
  readonly expiresAt: number;
}

export function createOAuthStore(db: SqliteDatabase): OAuthStore {
  const countClients = db.prepare("SELECT COUNT(*) AS n FROM oauth_clients");
  const insertClient = db.prepare(
    "INSERT INTO oauth_clients (clientId, redirectUri, createdAt) VALUES (?, ?, ?)",
  );
  const selectClient = db.prepare("SELECT clientId, redirectUri FROM oauth_clients WHERE clientId = ?");
  const insertCode = db.prepare(
    `INSERT INTO oauth_codes (codeHash, clientId, redirectUri, subject, assertion, codeChallenge, expiresAt, consumedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const selectCode = db.prepare("SELECT * FROM oauth_codes WHERE codeHash = ?");
  const deleteCode = db.prepare("DELETE FROM oauth_codes WHERE codeHash = ?");
  const consumeCodeStmt = db.prepare(
    "UPDATE oauth_codes SET consumedAt = ? WHERE codeHash = ? AND consumedAt IS NULL",
  );
  const insertRefresh = db.prepare(
    `INSERT INTO oauth_refresh_tokens (tokenHash, clientId, subject, assertion, expiresAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectRefresh = db.prepare(
    "SELECT clientId, subject, assertion, expiresAt FROM oauth_refresh_tokens WHERE tokenHash = ?",
  );
  const deleteRefresh = db.prepare("DELETE FROM oauth_refresh_tokens WHERE tokenHash = ?");
  const insertAccess = db.prepare(
    `INSERT INTO oauth_access_tokens (tokenHash, clientId, subject, expiresAt, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const selectAccess = db.prepare(
    "SELECT subject, expiresAt FROM oauth_access_tokens WHERE tokenHash = ? AND expiresAt > ?",
  );
  const deleteExpiredAccess = db.prepare("DELETE FROM oauth_access_tokens WHERE expiresAt <= ?");

  return {
    registerClient(redirectUri, now) {
      const n = (countClients.get() as { n: number }).n;
      if (n >= MAX_OAUTH_CLIENTS) return "capacity";
      const client: OAuthClientRow = { clientId: randomToken(), redirectUri };
      insertClient.run(client.clientId, client.redirectUri, now);
      return client;
    },
    findClient(clientId) {
      return (selectClient.get(clientId) as OAuthClientRow | undefined) ?? undefined;
    },
    insertCode(row, codeHash, expiresAt, now) {
      insertCode.run(
        codeHash,
        row.clientId,
        row.redirectUri,
        row.subject,
        row.assertion,
        row.codeChallenge,
        expiresAt,
        now,
      );
    },
    consumeCode(codeHash, now) {
      const row = selectCode.get(codeHash) as
        | (OAuthCodeRow & { codeHash: string; expiresAt: number; consumedAt: number | null })
        | undefined;
      if (row === undefined || row.consumedAt !== null) return null;
      if (row.expiresAt <= now) {
        deleteCode.run(codeHash);
        return null;
      }
      const result = consumeCodeStmt.run(now, codeHash);
      if (result.changes !== 1) return null;
      const { codeHash: _hash, expiresAt: _exp, consumedAt: _used, ...payload } = row;
      return payload;
    },
    insertRefreshToken(row, tokenHash, now) {
      insertRefresh.run(tokenHash, row.clientId, row.subject, row.assertion, row.expiresAt, now);
    },
    findRefreshToken(tokenHash) {
      return (selectRefresh.get(tokenHash) as OAuthRefreshRow | undefined) ?? null;
    },
    deleteRefreshToken(tokenHash) {
      deleteRefresh.run(tokenHash);
    },
    insertAccessToken(row, tokenHash, now) {
      deleteExpiredAccess.run(now);
      insertAccess.run(tokenHash, row.clientId, row.subject, row.expiresAt, now);
    },
    findAccessToken(tokenHash, now) {
      return (selectAccess.get(tokenHash, now) as { subject: string; expiresAt: number } | undefined) ?? null;
    },
  };
}

export interface OAuthRoutesDeps {
  /** Verified Access identity source; null only in local-only mode (routes answer 503). */
  readonly verifier: AccessJwtVerifier | null;
  readonly store: OAuthStore;
  /** BRIDGE_PUBLIC_HOST — issuer host and redirect-uri pin. */
  readonly publicHost: string;
  /** BRIDGE_PUBLIC_SCHEME — OAuth endpoint URL scheme (http or https). */
  readonly publicScheme: "http" | "https";
  /** §10.6 audit sink (token/assertion values never reach it). */
  readonly audit: AuditLog;
  readonly now: () => number;
  /**
   * APK signing SHA-256 (colon-separated uppercase). When set the registrar
   * also serves /.well-known/assetlinks.json.
   */
  readonly fingerprint?: string | undefined;
}

interface FormBody {
  [key: string]: unknown;
}

function formString(body: FormBody, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function queryParam(request: FastifyRequest, key: string): string | null {
  // No instanceof guard: Fastify's parsed query object has a null prototype.
  const value = (request.query as FormBody | undefined)?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Static bounce page served at the redirect path (see route comment). */
const CALLBACK_BOUNCE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>登录完成</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #1a1c1e; color: #e3e2e6; font-family: system-ui, sans-serif; }
  main { text-align: center; padding: 2rem; max-width: 30rem; }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  p { color: #c4c6cf; font-size: .9rem; line-height: 1.5; margin: 0 0 1.5rem; }
  a.open { display: inline-block; padding: .8rem 2.2rem; border-radius: 999px;
           background: #9ec6ff; color: #00325b; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
  <h1>登录完成</h1>
  <p>浏览器没有自动返回 App。点击下面的按钮回到 Claude Remote 完成登录。</p>
  <a class="open" id="open" href="#">打开 App</a>
</main>
<script>
(() => {
  // Chromium Custom Tabs honor App Links on 302 redirects inconsistently (Edge
  // keeps https navigations in-browser even on a user-gesture tap). An
  // intent:// URL naming the package forces the handoff in every Chromium
  // browser; the fallback keeps the same page when the app is missing.
  const u = new URL(location.href);
  document.getElementById("open").href =
    "intent://" + u.host + u.pathname + u.search +
    "#Intent;scheme=https;package=${ANDROID_PACKAGE_NAME};S.browser_fallbackUrl=" +
    encodeURIComponent(location.href) + ";end";
})();
</script>
</body>
</html>`;

/** RFC 6749 §5.2 error response. */
function oauthError(status: number, error: string, description?: string): { status: number; body: Record<string, string> } {
  return { status, body: description === undefined ? { error } : { error, error_description: description } };
}

/**
 * The acceptable redirect_uri:
 * - For HTTPS: exactly the public host with /auth/callback path
 * - For HTTP (testing mode): also accept claude-remote://callback custom scheme
 * No userinfo/query/fragment allowed (no open-redirect surface).
 */
export function isValidRedirectUri(
  redirectUri: string,
  publicHost: string,
  publicScheme: "http" | "https",
): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }

  // For HTTP mode, also accept custom scheme
  if (publicScheme === "http" && url.protocol === "claude-remote:" && url.hostname === "callback") {
    return (
      url.pathname === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }

  // publicHost may include port (e.g., "example.com:8888")
  // Split it to compare hostname and port separately
  const colonIndex = publicHost.indexOf(":");
  const expectedHostname = colonIndex >= 0 ? publicHost.slice(0, colonIndex) : publicHost;
  const expectedPort = colonIndex >= 0 ? publicHost.slice(colonIndex + 1) : "";
  const actualPort = url.port || (url.protocol === "https:" ? "443" : "80");
  const expectedPortNormalized = expectedPort || (publicScheme === "https" ? "443" : "80");

  return (
    url.protocol === `${publicScheme}:` &&
    url.hostname.toLowerCase() === expectedHostname.toLowerCase() &&
    actualPort === expectedPortNormalized &&
    url.pathname === OAUTH_REDIRECT_PATH &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

/** PKCE S256 code_challenge: base64url, 43–128 chars (RFC 7636 §4.2). */
function isValidCodeChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9\-_]{43,128}$/.test(challenge);
}

/** Verify the request's Access assertion; null → self-hosted mode (default identity). */
async function requireAccess(
  deps: OAuthRoutesDeps,
  request: FastifyRequest,
): Promise<{ identity: VerifiedAccessIdentity; assertion: string } | { status: 401 }> {
  if (deps.verifier === null) {
    // Self-hosted mode: no edge verification, use default identity
    return {
      identity: {
        subject: "self-hosted-user",
        audience: "bridge",
        expiresAt: new Date(Date.now() + 86400000).toISOString(), // 24h from now
      },
      assertion: "self-hosted-mode",
    };
  }
  try {
    const identity = await deps.verifier.verifyRequest(request.headers);
    return { identity, assertion: extractRawAssertion(request.headers) };
  } catch {
    return { status: 401 };
  }
}

/** Mint and persist a bridge access token bound to (client, subject). */
function mintAccessToken(
  store: OAuthStore,
  clientId: string,
  subject: string,
  now: number,
): { accessToken: string; expiresAt: number } {
  const accessToken = randomToken();
  const expiresAt = now + BRIDGE_ACCESS_TOKEN_TTL_MS;
  store.insertAccessToken({ clientId, subject, expiresAt }, sha256Hex(accessToken), now);
  return { accessToken, expiresAt };
}

export interface BridgeAccessVerifierDeps {
  readonly store: OAuthStore;
  readonly now: () => number;
}

/**
 * The app-facing `Authorization: Bearer` verifier: resolves the presented
 * bridge-issued opaque access token by SHA-256 hash lookup (expired rows are
 * invisible). Throws the same Missing/InvalidAssertionError contract as
 * AccessJwtVerifier, so /api/v1 and the WS endpoint map failures to uniform
 * 401s unchanged. Raw Cloudflare assertions are NOT accepted here — they are
 * only ever verified at /auth/authorize and the code exchange.
 */
export function createBridgeAccessVerifier(deps: BridgeAccessVerifierDeps): AccessIdentitySource {
  return {
    async verifyRequest(headers): Promise<VerifiedAccessIdentity> {
      const raw = extractRawAssertion(headers);
      const row = deps.store.findAccessToken(sha256Hex(raw), deps.now());
      if (row === null) {
        throw new InvalidAssertionError("signature", "bridge access token is unknown, expired, or revoked");
      }
      return {
        subject: row.subject,
        audience: "bridge",
        expiresAt: new Date(row.expiresAt).toISOString(),
      };
    },
  };
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRoutesDeps): void {
  const issuer = `${deps.publicScheme}://${deps.publicHost}`;
  const authorizationEndpoint = `${issuer}/auth/authorize`;
  const tokenEndpoint = `${issuer}/auth/token`;
  const registrationEndpoint = `${issuer}/auth/registration`;
  const grantTypes = ["authorization_code", "refresh_token"] as const;

  // RFC 6749 token requests are form-urlencoded; Fastify 5 does not parse
  // that content type out of the box.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  const discoveryMetadata = {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint: registrationEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: grantTypes,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };

  app.get("/.well-known/oauth-authorization-server", async () => discoveryMetadata);

  // OpenID Connect Discovery (for compatibility with AppAuth and other OIDC clients)
  app.get("/.well-known/openid-configuration", async () => discoveryMetadata);

  app.post("/auth/registration", async (request, reply) => {
    const body = (request.body ?? {}) as FormBody;
    const redirectUris = body.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length !== 1 ||
      typeof redirectUris[0] !== "string" ||
      !isValidRedirectUri(redirectUris[0], deps.publicHost, deps.publicScheme)
    ) {
      deps.audit.write({ operationType: "oauth.registration", resultCode: "invalid_redirect_uri" });
      return reply.code(400).send({
        error: "invalid_redirect_uri",
        error_description: `redirect_uris must be exactly [${deps.publicScheme}://${deps.publicHost}${OAUTH_REDIRECT_PATH}]`,
      });
    }
    const client = deps.store.registerClient(redirectUris[0], deps.now());
    if (client === "capacity") {
      deps.audit.write({ operationType: "oauth.registration", resultCode: "capacity" });
      return reply.code(503).send({ error: "temporarily_unavailable" });
    }
    deps.audit.write({
      operationType: "oauth.registration",
      resultCode: "ok",
      committed: true,
    });
    return reply.code(201).send({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(deps.now() / 1000),
      redirect_uris: [client.redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: grantTypes,
      response_types: ["code"],
    });
  });

  app.get("/auth/authorize", async (request, reply) => {
    const access = await requireAccess(deps, request);
    if ("status" in access) {
      deps.audit.write({ operationType: "oauth.authorize", resultCode: "unauthorized" });
      return reply.code(401).send({ error: "unauthorized" });
    }
    const clientId = queryParam(request, "client_id");
    const redirectUri = queryParam(request, "redirect_uri");
    const responseType = queryParam(request, "response_type");
    const codeChallenge = queryParam(request, "code_challenge");
    const challengeMethod = queryParam(request, "code_challenge_method");
    const state = queryParam(request, "state");
    // Errors are NEVER redirected (the redirect target itself failed
    // validation); they answer 400 with the RFC 6749 §4.1.2.1 error code.
    const badRequest = (error: string, description: string) => {
      deps.audit.write({ operationType: "oauth.authorize", resultCode: "bad_request" });
      return reply.code(400).send(oauthError(400, error, description).body);
    };
    if (responseType !== "code") {
      return badRequest("unsupported_response_type", "only response_type=code is supported");
    }
    const client = clientId === null ? undefined : deps.store.findClient(clientId);
    if (client === undefined || redirectUri === null || redirectUri !== client.redirectUri) {
      return badRequest("invalid_request", "unknown client_id or mismatched redirect_uri");
    }
    if (codeChallenge === null || !isValidCodeChallenge(codeChallenge)) {
      return badRequest("invalid_request", "a valid code_challenge (base64url, 43-128 chars) is required");
    }
    if (challengeMethod !== "S256") {
      return badRequest("invalid_request", "code_challenge_method must be S256");
    }
    const code = randomToken();
    deps.store.insertCode(
      {
        clientId: client.clientId,
        redirectUri,
        subject: access.identity.subject,
        assertion: access.assertion,
        codeChallenge,
      },
      sha256Hex(code),
      deps.now() + AUTH_CODE_TTL_MS,
      deps.now(),
    );
    deps.audit.write({
      operationType: "oauth.authorize",
      accessSubject: access.identity.subject,
      resultCode: "ok",
      committed: true,
    });
    const location = new URL(redirectUri);
    location.searchParams.set("code", code);
    location.searchParams.set("iss", issuer);
    if (state !== null) location.searchParams.set("state", state);
    return reply.code(302).redirect(location.toString());
  });

  app.post("/auth/token", async (request, reply) => {
    const body = (request.body ?? {}) as FormBody;
    const grantType = formString(body, "grant_type");
    const badGrant = (error: string, description?: string) => {
      deps.audit.write({ operationType: "oauth.token", resultCode: error });
      const mapped = oauthError(400, error, description);
      return reply.code(mapped.status).send(mapped.body);
    };
    const clientId = formString(body, "client_id");
    const client = clientId === null ? undefined : deps.store.findClient(clientId);
    if (client === undefined) {
      return badGrant("invalid_client", "unknown client_id");
    }
    if (grantType === "authorization_code") {
      const code = formString(body, "code");
      const redirectUri = formString(body, "redirect_uri");
      const verifier = formString(body, "code_verifier");
      if (code === null || redirectUri === null || verifier === null) {
        return badGrant("invalid_request", "code, redirect_uri and code_verifier are required");
      }
      const row = deps.store.consumeCode(sha256Hex(code), deps.now());
      if (row === null || row.clientId !== client.clientId || row.redirectUri !== redirectUri) {
        return badGrant("invalid_grant", "authorization code is unknown, expired, or already used");
      }
      const expectedChallenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
      if (expectedChallenge !== row.codeChallenge) {
        return badGrant("invalid_grant", "PKCE verification failed");
      }
      // The assertion is verified exactly once, here: a code may only be
      // exchanged while its underlying Access session is still live.
      // In self-hosted mode (verifier === null), skip assertion verification.
      if (deps.verifier !== null) {
        try {
          await deps.verifier.verifyAssertion(row.assertion);
        } catch {
          // The Access assertion expired inside the 5-minute code window.
          return badGrant("invalid_grant", "the Access assertion behind this code is no longer valid");
        }
      }
      const { accessToken, expiresAt } = mintAccessToken(deps.store, client.clientId, row.subject, deps.now());
      const refreshToken = randomToken();
      deps.store.insertRefreshToken(
        {
          clientId: client.clientId,
          subject: row.subject,
          assertion: row.assertion,
          expiresAt: deps.now() + REFRESH_TOKEN_TTL_MS,
        },
        sha256Hex(refreshToken),
        deps.now(),
      );
      deps.audit.write({
        operationType: "oauth.token",
        accessSubject: row.subject,
        resultCode: "ok",
        committed: true,
      });
      return reply.code(200).send({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor((expiresAt - deps.now()) / 1000),
        refresh_token: refreshToken,
      });
    }
    if (grantType === "refresh_token") {
      const refreshToken = formString(body, "refresh_token");
      if (refreshToken === null) {
        return badGrant("invalid_request", "refresh_token is required");
      }
      const tokenHash = sha256Hex(refreshToken);
      const row = deps.store.findRefreshToken(tokenHash);
      if (row === null || row.clientId !== client.clientId) {
        return badGrant("invalid_grant", "refresh token is unknown");
      }
      if (row.expiresAt <= deps.now()) {
        deps.store.deleteRefreshToken(tokenHash);
        return badGrant("invalid_grant", "refresh token is expired");
      }
      // No assertion re-verification: the refresh token's own TTL governs, so
      // sessions outlive the Cloudflare Access JWT by weeks.
      const { accessToken, expiresAt } = mintAccessToken(deps.store, client.clientId, row.subject, deps.now());
      deps.audit.write({
        operationType: "oauth.token",
        accessSubject: row.subject,
        resultCode: "ok",
      });
      return reply.code(200).send({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor((expiresAt - deps.now()) / 1000),
        refresh_token: refreshToken,
      });
    }
    return badGrant("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  });

  // Browsers differ on whether a 302 redirect is handed to the verified
  // Android App Link (Chrome does; Edge Custom Tabs do not, and Edge also
  // keeps plain-https taps in-browser). When the browser loads the redirect
  // target itself, this static bounce page offers an intent:// link (built
  // client-side from location) that names the package, forcing the handoff in
  // every Chromium browser and re-delivering code/state verbatim. The page
  // never templates the query server-side (no injection surface).
  app.get(OAUTH_REDIRECT_PATH, async (_request, reply) => {
    return reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(CALLBACK_BOUNCE_HTML);
  });

  if (deps.fingerprint !== undefined) {
    app.get("/.well-known/assetlinks.json", async (_request, reply) => {
      return reply
        .code(200)
        .header("content-type", "application/json")
        .send([
          {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: {
              namespace: "android_app",
              package_name: ANDROID_PACKAGE_NAME,
              sha256_cert_fingerprints: [deps.fingerprint],
            },
          },
        ]);
    });
  }
}
