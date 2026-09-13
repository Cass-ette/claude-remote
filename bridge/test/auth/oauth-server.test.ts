import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as jose from "jose";
import Fastify from "fastify";
import {
  AccessJwtVerifier,
  type JwksFetcher,
} from "../../src/auth/access-jwt-verifier.js";
import {
  createOAuthStore,
  isValidRedirectUri,
  registerOAuthRoutes,
  type OAuthStore,
} from "../../src/auth/oauth-server.js";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { createAuditLog, type AuditLog } from "../../src/audit/audit-log.js";

// Same fixture idea as access-jwt-verifier.test.ts: a locally generated RSA
// key pair plays the Access signing key; the JWKS fetcher is stubbed.
const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = "0e9a5b2f7dbf4e1b9a17d8e0c3f2a1b0";
const SUBJECT = "1804534439@qq.com";
const KID = "test-kid-1";
const PUBLIC_HOST = "bridge.example.com";
const FINGERPRINT = "5B:54:BC:BA:A5:1A:12:F4:4D:98:6A:C1:40:BC:14:CB:6A:67:CD:6F:CF:D6:DC:41:4E:78:89:32:9E:EF:6C:1C";

let signingKey: jose.KeyLike;
let verifier: AccessJwtVerifier;
let app: ReturnType<typeof Fastify> | undefined;
let db: SqliteDatabase;
let store: OAuthStore;
let audit: AuditLog;
const tmpDirs: string[] = [];
// Injectable clock for store TTL logic; starts at the real wall clock so the
// signed assertions (verified against jose's real-clock exp check) are valid.
let nowMs = Date.now();

async function signAssertion(expiresInSeconds = 3600): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  return new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: SUBJECT, iat: now, exp: now + expiresInSeconds, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .sign(signingKey);
}

const sha256B64u = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("base64url");
/** Same digest the OAuth store hashes credentials with (oauth-server.ts). */
const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** A syntactically valid RFC 7636 verifier/challenge pair. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = createHash("sha256").update(`verifier-${Math.random()}`).digest("base64url");
  return { verifier, challenge: sha256B64u(verifier) };
}

interface ClientFixture {
  readonly clientId: string;
  readonly redirectUri: string;
}

async function registerClient(): Promise<ClientFixture> {
  const redirectUri = `https://${PUBLIC_HOST}/auth/callback`;
  const res = await app!.inject({
    method: "POST",
    url: "/auth/registration",
    payload: { redirect_uris: [redirectUri], client_name: "test", token_endpoint_auth_method: "none" },
    headers: { "content-type": "application/json" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { client_id: string };
  return { clientId: body.client_id, redirectUri };
}

/** Drive the full code flow; returns the authorize Location and the assertion. */
async function authorizeCode(
  client: ClientFixture,
  state = "st-123",
): Promise<{ location: URL; assertion: string; pkceVerifier: string }> {
  const assertion = await signAssertion();
  const { verifier: pkceVerifier, challenge } = pkce();
  const res = await app!.inject({
    method: "GET",
    url: "/auth/authorize",
    headers: { "cf-access-jwt-assertion": assertion },
    query: {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    },
  });
  expect(res.statusCode).toBe(302);
  return { location: new URL(res.headers.location ?? ""), assertion, pkceVerifier };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-oauth-test-"));
  tmpDirs.push(dir);
  db = openDatabase(join(dir, "bridge.db"));
  migrate(db);
  audit = createAuditLog({ filePath: join(dir, "audit.jsonl"), db, now: () => nowMs });

  const pair = await jose.generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  const publicJwk = await jose.exportJWK(pair.publicKey);
  const fetcher: JwksFetcher = async () => ({
    keys: [{ ...publicJwk, kid: KID, use: "sig", kty: "RSA", alg: "RS256" }],
  });
  verifier = new AccessJwtVerifier({ teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksFetcher: fetcher });

  store = createOAuthStore(db);
  app = Fastify();
  registerOAuthRoutes(app, {
    verifier,
    store,
    publicHost: PUBLIC_HOST,
    audit,
    now: () => nowMs,
    fingerprint: FINGERPRINT,
  });
});

afterAll(async () => {
  await app?.close();
  db.close();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("GET /.well-known/oauth-authorization-server", () => {
  it("serves RFC 8414 metadata pinned to the public host", async () => {
    const res = await app!.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      issuer: `https://${PUBLIC_HOST}`,
      authorization_endpoint: `https://${PUBLIC_HOST}/auth/authorize`,
      token_endpoint: `https://${PUBLIC_HOST}/auth/token`,
      registration_endpoint: `https://${PUBLIC_HOST}/auth/registration`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });
});

describe("isValidRedirectUri", () => {
  it("accepts only https://<publicHost>/auth/callback with nothing extra", () => {
    expect(isValidRedirectUri(`https://${PUBLIC_HOST}/auth/callback`, PUBLIC_HOST)).toBe(true);
    expect(isValidRedirectUri(`https://${PUBLIC_HOST}/auth/callback?x=1`, PUBLIC_HOST)).toBe(false);
    expect(isValidRedirectUri(`https://${PUBLIC_HOST}/auth/callback/`, PUBLIC_HOST)).toBe(false);
    expect(isValidRedirectUri(`https://evil.example.com/auth/callback`, PUBLIC_HOST)).toBe(false);
    expect(isValidRedirectUri(`http://${PUBLIC_HOST}/auth/callback`, PUBLIC_HOST)).toBe(false);
    expect(isValidRedirectUri(`https://${PUBLIC_HOST}:8443/auth/callback`, PUBLIC_HOST)).toBe(false);
    expect(isValidRedirectUri(`https://user@${PUBLIC_HOST}/auth/callback`, PUBLIC_HOST)).toBe(false);
  });
});

describe("POST /auth/registration", () => {
  it("registers a public client and echoes the contract", async () => {
    const client = await registerClient();
    expect(client.clientId.length).toBeGreaterThan(20);
    const stored = store.findClient(client.clientId);
    expect(stored?.redirectUri).toBe(client.redirectUri);
  });

  it("rejects any redirect_uri off the pinned host/path with 400", async () => {
    for (const bad of [
      [`https://evil.example.com/auth/callback`],
      [`http://${PUBLIC_HOST}/auth/callback`],
      [`https://${PUBLIC_HOST}/other`],
      [],
    ]) {
      const res = await app!.inject({
        method: "POST",
        url: "/auth/registration",
        payload: { redirect_uris: bad },
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe("invalid_redirect_uri");
    }
  });
});

describe("GET /auth/authorize", () => {
  it("302s back with code/iss/state for a verified Access session", async () => {
    const client = await registerClient();
    const { location } = await authorizeCode(client);
    expect(location.origin + location.pathname).toBe(client.redirectUri);
    expect(location.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(location.searchParams.get("iss")).toBe(`https://${PUBLIC_HOST}`);
    expect(location.searchParams.get("state")).toBe("st-123");
  });

  it("401s without an Access assertion", async () => {
    const client = await registerClient();
    const { challenge } = pkce();
    const res = await app!.inject({
      method: "GET",
      url: "/auth/authorize",
      query: {
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s (never redirects) on unknown client or mismatched redirect_uri", async () => {
    const client = await registerClient();
    const { challenge } = pkce();
    for (const overrides of [
      { client_id: "nope", redirect_uri: client.redirectUri },
      { client_id: client.clientId, redirect_uri: `https://evil.example.com/auth/callback` },
    ]) {
      const res = await app!.inject({
        method: "GET",
        url: "/auth/authorize",
        headers: { "cf-access-jwt-assertion": await signAssertion() },
        query: {
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          ...overrides,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
  });

  it("rejects plain PKCE and non-code response types", async () => {
    const client = await registerClient();
    const { challenge } = pkce();
    const res = await app!.inject({
      method: "GET",
      url: "/auth/authorize",
      headers: { "cf-access-jwt-assertion": await signAssertion() },
      query: {
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        code_challenge: challenge,
        code_challenge_method: "plain",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /auth/token", () => {
  it("exchanges a code for the Access assertion as the Bearer access_token", async () => {
    const client = await registerClient();
    const { location, assertion, pkceVerifier } = await authorizeCode(client);
    const code = location.searchParams.get("code") ?? "";
    const res = await app!.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        code,
        redirect_uri: client.redirectUri,
        code_verifier: pkceVerifier,
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { access_token: string; token_type: string; expires_in: number; refresh_token: string };
    expect(body.access_token).toBe(assertion);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.refresh_token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("re-serves the same assertion via the refresh token while it is valid", async () => {
    const client = await registerClient();
    const { location, assertion, pkceVerifier } = await authorizeCode(client);
    const exchange = await app!.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        code: location.searchParams.get("code") ?? "",
        redirect_uri: client.redirectUri,
        code_verifier: pkceVerifier,
      }).toString(),
    });
    const issued = exchange.json() as { refresh_token: string };
    const refresh = await app!.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: issued.refresh_token,
      }).toString(),
    });
    expect(refresh.statusCode).toBe(200);
    const body = refresh.json() as { access_token: string; refresh_token: string; expires_in: number };
    expect(body.access_token).toBe(assertion);
    expect(body.refresh_token).toBe(issued.refresh_token);
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it("never lets a code be used twice", async () => {
    const client = await registerClient();
    const { location } = await authorizeCode(client);
    const code = location.searchParams.get("code") ?? "";
    const form = (over: Record<string, string>) =>
      app!.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.clientId,
          code,
          redirect_uri: client.redirectUri,
          code_verifier: "x".repeat(43),
          ...over,
        }).toString(),
      });
    // First exchange with the WRONG verifier fails PKCE but consumes the code.
    const wrong = await form({});
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { error: string }).error).toBe("invalid_grant");
    // Even the right verifier cannot resurrect it.
    const right = await form({});
    expect((right.json() as { error: string }).error).toBe("invalid_grant");
  });

  it("re-serves the assertion on refresh_token and invalidates once it is unusable", async () => {
    const client = await registerClient();
    // Insert a refresh row directly holding an assertion signed by a
    // stranger's key: verification must fail, the row must be deleted.
    const stranger = await jose.generateKeyPair("RS256", { extractable: true });
    const nowSec = Math.floor(nowMs / 1000);
    const bogus = await new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: SUBJECT, exp: nowSec + 999 })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .sign(stranger.privateKey);
    store.insertRefreshToken(
      { clientId: client.clientId, subject: SUBJECT, assertion: bogus, expiresAt: nowMs + 999_000 },
      sha256Hex(bogus),
      nowMs,
    );
    const res = await app!.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: bogus,
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_grant");
    expect(store.findRefreshToken(sha256Hex(bogus))).toBeNull();
  });

  it("rejects unsupported grant types", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/auth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "password", client_id: "x" }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_client");
  });
});

describe("GET /.well-known/assetlinks.json", () => {
  it("declares the configured APK fingerprint", async () => {
    const res = await app!.inject({ method: "GET", url: "/.well-known/assetlinks.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "dev.clauderemote.android",
          sha256_cert_fingerprints: [FINGERPRINT],
        },
      },
    ]);
  });

  it("is absent (404) when no fingerprint is configured", async () => {
    const bare = Fastify();
    registerOAuthRoutes(bare, {
      verifier,
      store: createOAuthStore(db),
      publicHost: PUBLIC_HOST,
      audit,
      now: () => nowMs,
    });
    bare.setNotFoundHandler((_r, reply) => reply.code(404).send({ error: "not_found" }));
    const res = await bare.inject({ method: "GET", url: "/.well-known/assetlinks.json" });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
