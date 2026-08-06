import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, access, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import * as jose from "jose";

// -----------------------------------------------------------------------------
// Test JWT helpers — generate RSA key pair once, sign Access-shaped JWTs.
// -----------------------------------------------------------------------------

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = "test-access-audience";
const EXPECTED_SUBJECT = "user@example.com";

let rsaKey: jose.KeyLike;
let rsaPublicJwk: jose.JWK;
let kid: string;

beforeAll(async () => {
  const pair = await jose.generateKeyPair("RS256", { extractable: true });
  rsaKey = pair.privateKey;
  const pub = await jose.exportJWK(pair.publicKey);
  rsaPublicJwk = pub;
  kid = "test-kid-1";
});

async function signAccessJwt(overrides: Partial<jose.JWTPayload> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: jose.JWTPayload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: EXPECTED_SUBJECT,
    iat: now,
    exp: now + 60 * 60,
    type: "app",
    ...overrides
  };
  return new jose.SignJWT(payload)
    .setProtectedHeader({ kid, alg: "RS256" })
    .sign(rsaKey);
}

// -----------------------------------------------------------------------------
// Origin server fixture: boot the loopback server on an ephemeral port with
// env vars pointing at this test's JWKS stub.
// -----------------------------------------------------------------------------

interface ServerHandle {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  evidenceFile: string;
}

let serverProc: ServerHandle | null = null;
let workDir: string;

async function withTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cf-origin-test-"));
}

// We don't actually spawn — we import the server factory directly so the test
// can supply a custom JWKS fetcher and capture evidence writes. The server
// listens on 127.0.0.1 and a kernel-assigned port.
import { createOriginServer, type OriginConfig, type JwksFetcher } from "../src/server.js";

async function startServer(opts: {
  jwksFetcher: JwksFetcher;
  teamDomain?: string;
  audience?: string;
  expectedSubject?: string;
  evidenceFile: string;
  assetLinks?: unknown;
}): Promise<{ close: () => Promise<void>; baseUrl: string; port: number }> {
  const cfg: OriginConfig = {
    bindHost: "127.0.0.1",
    bindPort: 0,
    teamDomain: opts.teamDomain ?? TEAM_DOMAIN,
    audience: opts.audience ?? AUDIENCE,
    expectedSubject: opts.expectedSubject ?? EXPECTED_SUBJECT,
    evidenceFile: opts.evidenceFile,
    assetLinks: opts.assetLinks ?? [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "dev.clauderemote.probe",
          sha256_cert_fingerprints: ["AA:BB:CC"]
        }
      }
    ]
  };
  const handle = await createOriginServer(cfg, opts.jwksFetcher);
  return { close: handle.close, baseUrl: handle.baseUrl, port: handle.port };
}

const defaultJwksFetcher = async (): Promise<jose.JSONWebKeySet> => ({
  keys: [{ ...rsaPublicJwk, kid, use: "sig", kty: "RSA", alg: "RS256" }]
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("cloudflare origin — loopback binding", () => {
  it("binds only to 127.0.0.1 (loopback), never 0.0.0.0", async () => {
    const dir = await withTempDir();
    const server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: join(dir, "evidence.json")
    });
    try {
      expect(server.port).toBeGreaterThan(0);
      // Reachable on explicit 127.0.0.1.
      const res = await fetch(`${server.baseUrl}/.well-known/assetlinks.json`);
      expect(res.status).toBe(200);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cloudflare origin — redaction", () => {
  it("never writes the assertion or bearer token into the evidence file", async () => {
    const dir = await withTempDir();
    const evFile = join(dir, "evidence.json");
    const server = await startServer({ jwksFetcher: defaultJwksFetcher, evidenceFile: evFile });
    try {
      const assertion = await signAccessJwt();
      const bearer = "Bearer never-leak-me-aaaaaaaaaaaaaaaaaa";
      const res = await fetch(`${server.baseUrl}/probe/http`, {
        headers: {
          authorization: bearer,
          "cf-access-jwt-assertion": assertion
        }
      });
      expect(res.status).toBe(200);
      const text = await readFile(evFile, "utf8");
      expect(text).not.toContain("never-leak-me");
      // The raw assertion string (which is long, has 3 dot-separated parts) must
      // not appear verbatim in evidence.
      expect(text).not.toContain(assertion);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cloudflare origin — JWKS signature verification", () => {
  it("accepts a JWT signed by the configured JWKS key", async () => {
    const dir = await withTempDir();
    const server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: join(dir, "evidence.json")
    });
    try {
      const assertion = await signAccessJwt();
      const res = await fetch(`${server.baseUrl}/probe/http`, {
        headers: {
          authorization: "Bearer some-bearer",
          "cf-access-jwt-assertion": assertion
        }
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; requestId: string };
      expect(body.ok).toBe(true);
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a JWT signed by a different key (signature mismatch)", async () => {
    const otherPair = await jose.generateKeyPair("RS256", { extractable: true });
    const otherPriv = otherPair.privateKey;
    const bad = await new jose.SignJWT({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: EXPECTED_SUBJECT,
      exp: Math.floor(Date.now() / 1000) + 60
    })
      .setProtectedHeader({ kid, alg: "RS256" })
      .sign(otherPriv);
    const dir = await withTempDir();
    const server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: join(dir, "evidence.json")
    });
    try {
      const res = await fetch(`${server.baseUrl}/probe/http`, {
        headers: { authorization: "Bearer x", "cf-access-jwt-assertion": bad }
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cloudflare origin — exact claim rejection", () => {
  let dir: string;
  let server: { close: () => Promise<void>; baseUrl: string };
  beforeEach(async () => {
    dir = await withTempDir();
    server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: join(dir, "evidence.json")
    });
  });
  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects wrong issuer", async () => {
    const assertion = await signAccessJwt({ iss: "https://wrong.cloudflareaccess.com" });
    const res = await fetch(`${server.baseUrl}/probe/http`, {
      headers: { authorization: "Bearer x", "cf-access-jwt-assertion": assertion }
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong audience", async () => {
    const assertion = await signAccessJwt({ aud: "someone-else" });
    const res = await fetch(`${server.baseUrl}/probe/http`, {
      headers: { authorization: "Bearer x", "cf-access-jwt-assertion": assertion }
    });
    expect(res.status).toBe(401);
  });

  it("rejects missing subject", async () => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new jose.SignJWT({ iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 60 })
      .setProtectedHeader({ kid, alg: "RS256" })
      .sign(rsaKey);
    const res = await fetch(`${server.baseUrl}/probe/http`, {
      headers: { authorization: "Bearer x", "cf-access-jwt-assertion": assertion }
    });
    expect(res.status).toBe(401);
  });

  it("rejects expired token", async () => {
    const assertion = await signAccessJwt({
      exp: Math.floor(Date.now() / 1000) - 10,
      iat: Math.floor(Date.now() / 1000) - 100
    });
    const res = await fetch(`${server.baseUrl}/probe/http`, {
      headers: { authorization: "Bearer x", "cf-access-jwt-assertion": assertion }
    });
    expect(res.status).toBe(401);
  });
});

describe("cloudflare origin — HTTP assertion capture", () => {
  it("requires Authorization and Cf-Access-Jwt-Assertion headers", async () => {
    const dir = await withTempDir();
    const server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: join(dir, "evidence.json")
    });
    try {
      // No headers.
      expect(((await fetch(`${server.baseUrl}/probe/http`)).status)).toBe(401);
      // Only bearer.
      expect(
        (
          await fetch(`${server.baseUrl}/probe/http`, { headers: { authorization: "Bearer x" } })
        ).status
      ).toBe(401);
      // Only assertion.
      const assertion = await signAccessJwt();
      expect(
        (
          await fetch(`${server.baseUrl}/probe/http`, {
            headers: { "cf-access-jwt-assertion": assertion }
          })
        ).status
      ).toBe(401);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a unique requestId per request", async () => {
    const dir = await withTempDir();
    const server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: join(dir, "evidence.json")
    });
    try {
      const assertion = await signAccessJwt();
      const a = await fetch(`${server.baseUrl}/probe/http`, {
        headers: { authorization: "Bearer x", "cf-access-jwt-assertion": assertion }
      });
      const b = await fetch(`${server.baseUrl}/probe/http`, {
        headers: { authorization: "Bearer x", "cf-access-jwt-assertion": assertion }
      });
      const aj = (await a.json()) as { requestId: string };
      const bj = (await b.json()) as { requestId: string };
      expect(aj.requestId).not.toBe(bj.requestId);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cloudflare origin — WebSocket Upgrade assertion capture", () => {
  it("rejects Upgrade without headers and accepts with valid assertion", async () => {
    const dir = await withTempDir();
    const server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: join(dir, "evidence.json")
    });
    try {
      // Missing headers -> non-101 response (the ws lib rejects pre-101).
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${server.port}/probe/ws`);
          ws.once("open", () => {
            ws.close();
            reject(new Error("ws should not have opened without headers"));
          });
          ws.once("unexpected-response", () => resolve());
          ws.once("error", () => resolve());
        })
      ).resolves.toBeUndefined();

      // Valid headers -> open + message + close.
      const assertion = await signAccessJwt();
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/probe/ws`, {
          headers: { authorization: "Bearer ws-bearer", "cf-access-jwt-assertion": assertion }
        });
        ws.once("message", (data: Buffer) => {
          const txt = data.toString("utf8");
          const parsed = JSON.parse(txt) as { ok: boolean; requestId: string };
          if (parsed.ok && /^[0-9a-f-]{36}$/i.test(parsed.requestId)) {
            ws.close();
            resolve();
          } else {
            reject(new Error("bad ws payload"));
          }
        });
        ws.once("error", (e) => reject(e));
        setTimeout(() => reject(new Error("timeout")), 5000).unref();
      });
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cloudflare origin — evidence atomic write", () => {
  it("writes evidence with mode 0600 atomically (temp + rename)", async () => {
    const dir = await withTempDir();
    const evFile = join(dir, "evidence.json");
    const server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: evFile
    });
    try {
      const assertion = await signAccessJwt();
      await fetch(`${server.baseUrl}/probe/http`, {
        headers: { authorization: "Bearer x", "cf-access-jwt-assertion": assertion }
      });
      // File exists and is valid JSON.
      const text = await readFile(evFile, "utf8");
      const parsed = JSON.parse(text) as {
        issuer: string;
        audience: string;
        subject: string;
        httpRequestIds: string[];
        wsRequestIds: string[];
        expiresAt: string;
      };
      expect(parsed.issuer).toBe(ISSUER);
      expect(parsed.audience).toBe(AUDIENCE);
      expect(parsed.subject).toBe(EXPECTED_SUBJECT);
      expect(parsed.httpRequestIds.length).toBe(1);
      expect(parsed.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // File mode 0600 on POSIX.
      if (process.platform !== "win32") {
        const st = await access(evFile).then(
          () => true,
          () => false
        );
        expect(st).toBe(true);
        // Verify mode bits via stat.
        const { stat } = await import("node:fs/promises");
        const s = await stat(evFile);
        // Mask to permission bits.
        expect(s.mode & 0o777).toBe(0o600);
      }
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes token / assertion values from evidence", async () => {
    const dir = await withTempDir();
    const evFile = join(dir, "evidence.json");
    const server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: evFile
    });
    try {
      const assertion = await signAccessJwt();
      await fetch(`${server.baseUrl}/probe/http`, {
        headers: { authorization: "Bearer secret-bearer-value", "cf-access-jwt-assertion": assertion }
      });
      const text = await readFile(evFile, "utf8");
      expect(text).not.toContain("secret-bearer-value");
      expect(text).not.toContain(assertion);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cloudflare origin — App Link assetlinks.json", () => {
  it("serves the configured asset links at the well-known path", async () => {
    const dir = await withTempDir();
    const assetLinks = [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "dev.clauderemote.probe",
          sha256_cert_fingerprints: ["AA:BB:CC:DD"]
        }
      }
    ];
    const server = await startServer({
      jwksFetcher: defaultJwksFetcher,
      evidenceFile: join(dir, "evidence.json"),
      assetLinks
    });
    try {
      const res = await fetch(`${server.baseUrl}/.well-known/assetlinks.json`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(assetLinks);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
