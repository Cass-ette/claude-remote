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
 * PKCE verifier. The Access assertion itself IS the access_token: the app
 * then presents it as `Authorization: Bearer` on /api/v1 and the WS
 * endpoint, whose Access edge policies are bypassed (origin-side
 * verification via AccessJwtVerifier — the same JWT the edge would have
 * injected). A refresh token re-serves the assertion while it is still
 * valid; once Cloudflare expires it the device must re-run the flow.
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
import { extractRawAssertion, type AccessJwtVerifier, type VerifiedAccessIdentity } from "./access-jwt-verifier.js";
import type { SqliteDatabase } from "../db/database.js";
import type { AuditLog } from "../audit/audit-log.js";

/** Authorization-code lifetime (single use): five minutes. */
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
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
  };
}

export interface OAuthRoutesDeps {
  /** Verified Access identity source; null only in local-only mode (routes answer 503). */
  readonly verifier: AccessJwtVerifier | null;
  readonly store: OAuthStore;
  /** BRIDGE_PUBLIC_HOST — issuer host and redirect-uri pin. */
  readonly publicHost: string;
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

/** RFC 6749 §5.2 error response. */
function oauthError(status: number, error: string, description?: string): { status: number; body: Record<string, string> } {
  return { status, body: description === undefined ? { error } : { error, error_description: description } };
}

/**
 * The only acceptable redirect_uri: https, exactly the public host, exactly
 * /auth/callback, no userinfo/query/fragment (no open-redirect surface).
 */
export function isValidRedirectUri(redirectUri: string, publicHost: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname.toLowerCase() === publicHost.toLowerCase() &&
    url.port === "" &&
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

/** Verify the request's Access assertion; null → uniform 401-style outcome. */
async function requireAccess(
  deps: OAuthRoutesDeps,
  request: FastifyRequest,
): Promise<{ identity: VerifiedAccessIdentity; assertion: string } | { status: 401 }> {
  if (deps.verifier === null) return { status: 401 };
  try {
    const identity = await deps.verifier.verifyRequest(request.headers);
    return { identity, assertion: extractRawAssertion(request.headers) };
  } catch {
    return { status: 401 };
  }
}

/** Seconds until the verified assertion expires (min 1). */
function expiresInSeconds(identity: VerifiedAccessIdentity, now: number): number {
  return Math.max(1, Math.ceil((Date.parse(identity.expiresAt) - now) / 1000));
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRoutesDeps): void {
  const issuer = `https://${deps.publicHost}`;
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

  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint: registrationEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: grantTypes,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  }));

  app.post("/auth/registration", async (request, reply) => {
    const body = (request.body ?? {}) as FormBody;
    const redirectUris = body.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length !== 1 ||
      typeof redirectUris[0] !== "string" ||
      !isValidRedirectUri(redirectUris[0], deps.publicHost)
    ) {
      deps.audit.write({ operationType: "oauth.registration", resultCode: "invalid_redirect_uri" });
      return reply.code(400).send({
        error: "invalid_redirect_uri",
        error_description: `redirect_uris must be exactly [https://${deps.publicHost}${OAUTH_REDIRECT_PATH}]`,
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
    if (deps.verifier === null) {
      return reply.code(503).send({ error: "temporarily_unavailable" });
    }
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
      let identity: VerifiedAccessIdentity;
      try {
        identity = await deps.verifier.verifyAssertion(row.assertion);
      } catch {
        // The Access assertion expired inside the 5-minute code window.
        return badGrant("invalid_grant", "the Access assertion behind this code is no longer valid");
      }
      const refreshToken = randomToken();
      deps.store.insertRefreshToken(
        {
          clientId: client.clientId,
          subject: row.subject,
          assertion: row.assertion,
          expiresAt: Date.parse(identity.expiresAt),
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
        access_token: row.assertion,
        token_type: "Bearer",
        expires_in: expiresInSeconds(identity, deps.now()),
        refresh_token: refreshToken,
      });
    }
    if (grantType === "refresh_token") {
      const refreshToken = formString(body, "refresh_token");
      if (refreshToken === null) {
        return badGrant("invalid_request", "refresh_token is required");
      }
      const row = deps.store.findRefreshToken(sha256Hex(refreshToken));
      if (row === null || row.clientId !== client.clientId) {
        return badGrant("invalid_grant", "refresh token is unknown");
      }
      let identity: VerifiedAccessIdentity;
      try {
        identity = await deps.verifier.verifyAssertion(row.assertion);
      } catch {
        deps.store.deleteRefreshToken(sha256Hex(refreshToken));
        deps.audit.write({
          operationType: "oauth.token",
          accessSubject: row.subject,
          resultCode: "invalid_grant",
        });
        return badGrant("invalid_grant", "the Access assertion behind this refresh token is no longer valid");
      }
      deps.audit.write({
        operationType: "oauth.token",
        accessSubject: row.subject,
        resultCode: "ok",
      });
      return reply.code(200).send({
        access_token: row.assertion,
        token_type: "Bearer",
        expires_in: expiresInSeconds(identity, deps.now()),
        refresh_token: refreshToken,
      });
    }
    return badGrant("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
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
