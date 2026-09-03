import { beforeAll, describe, expect, it } from "vitest";
import * as jose from "jose";
import {
  AccessJwtVerifier,
  InvalidAssertionError,
  MissingAssertionError,
  type JwksFetcher,
  type VerifiedAccessIdentity,
} from "../../src/auth/access-jwt-verifier.js";

// -----------------------------------------------------------------------------
// Fixtures: a locally generated RSA key pair plays the role of the team's
// Cloudflare Access signing key. The injectable JWKS fetcher returns a "fake
// JWKS" containing its public half.
// -----------------------------------------------------------------------------

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = "0e9a5b2f7dbf4e1b9a17d8e0c3f2a1b0";
const SUBJECT = "user@example.com";
const KID = "test-kid-1";
const OTHER_KID = "some-other-kid";

let signingKey: jose.KeyLike;
let publicJwk: jose.JWK;

beforeAll(async () => {
  const pair = await jose.generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = await jose.exportJWK(pair.publicKey);
});

/** Like Partial<JWTPayload> but allows explicitly overriding with undefined. */
type PayloadOverrides = {
  [K in keyof jose.JWTPayload]?: jose.JWTPayload[K] | undefined;
};

interface SignOptions {
  payload?: PayloadOverrides;
  header?: { kid?: string; alg?: string };
  key?: jose.KeyLike | Uint8Array;
}

/** Sign an Access-shaped JWT (iss/aud/sub/iat/exp/type/common_name). */
async function signAccessJwt(opts: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // Overrides may explicitly set claims to undefined (JSON serialization
  // drops those keys), hence the cast.
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: SUBJECT,
    iat: now,
    exp: now + 60 * 60,
    type: "app",
    // Cloudflare includes common_name (email); the verifier must IGNORE it
    // (spec §10.3: `sub` is the identity).
    common_name: "anything@example.com",
    ...opts.payload,
  } as jose.JWTPayload;
  const header = { alg: "RS256" as const, kid: KID, ...opts.header };
  const key = opts.key ?? signingKey;
  return new jose.SignJWT(payload).setProtectedHeader(header).sign(key);
}

function jwksWithKids(...kids: string[]): jose.JSONWebKeySet {
  return {
    keys: kids.map((kid) => ({ ...publicJwk, kid, use: "sig", kty: "RSA", alg: "RS256" })),
  };
}

/**
 * Programmable JWKS fetcher. Each call pops the next response; when the list
 * is exhausted the last response repeats. Records the team domain of every
 * call so tests can assert cache behavior.
 */
function makeFetcher(responses: jose.JSONWebKeySet[]): { fetcher: JwksFetcher; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const fetcher: JwksFetcher = async (teamDomain) => {
    calls.push(teamDomain);
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    // Deep copy so the verifier's cache can never alias a shared object.
    return structuredClone(response);
  };
  return { fetcher, calls };
}

function makeVerifier(responses: jose.JSONWebKeySet[]): {
  verifier: AccessJwtVerifier;
  calls: string[];
} {
  const { fetcher, calls } = makeFetcher(responses);
  return {
    verifier: new AccessJwtVerifier({ teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksFetcher: fetcher }),
    calls,
  };
}

function headersFor(assertion: string): Record<string, string> {
  return { "Cf-Access-Jwt-Assertion": assertion };
}

async function expectInvalid(
  promise: Promise<VerifiedAccessIdentity>,
  reason: string,
): Promise<InvalidAssertionError> {
  const err = await promise.then(
    () => {
      throw new Error("expected verification to fail");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InvalidAssertionError);
  const invalid = err as InvalidAssertionError;
  expect(invalid.code).toBe("INVALID_ASSERTION");
  expect(invalid.reason).toBe(reason);
  return invalid;
}

// -----------------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------------

describe("AccessJwtVerifier — valid assertions", () => {
  it("verifies signature, issuer, audience, and subject and returns the identity", async () => {
    const { verifier, calls } = makeVerifier([jwksWithKids(KID)]);
    const assertion = await signAccessJwt();
    const result = await verifier.verifyRequest(headersFor(assertion));
    expect(result.subject).toBe(SUBJECT);
    expect(result.audience).toBe(AUDIENCE);
    const now = Math.floor(Date.now() / 1000);
    expect(result.expiresAt).toBe(new Date((now + 60 * 60) * 1000).toISOString());
    expect(calls).toEqual([TEAM_DOMAIN]);
  });

  it("extracts the Cf-Access-Jwt-Assertion header case-insensitively", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const assertion = await signAccessJwt();
    await expect(
      verifier.verifyRequest({ "cf-access-jwt-assertion": assertion }),
    ).resolves.toBeDefined();
    await expect(
      verifier.verifyRequest({ "CF-ACCESS-JWT-ASSERTION": assertion }),
    ).resolves.toBeDefined();
  });

  it("ignores the common_name claim; sub is the identity (spec §10.3)", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const assertion = await signAccessJwt({
      payload: { common_name: "someone-else@example.com" },
    });
    const result = await verifier.verifyRequest(headersFor(assertion));
    expect(result.subject).toBe(SUBJECT);
  });

  it("accepts a team domain given with an https:// prefix and normalizes it", async () => {
    const prefixed = new AccessJwtVerifier({
      teamDomain: `https://${TEAM_DOMAIN}/`,
      audience: AUDIENCE,
      jwksFetcher: makeFetcher([jwksWithKids(KID)]).fetcher,
    });
    expect(prefixed.issuer).toBe(ISSUER);
    const assertion = await signAccessJwt();
    const result = await prefixed.verifyRequest(headersFor(assertion));
    expect(result.subject).toBe(SUBJECT);
  });
});

// -----------------------------------------------------------------------------
// Failure modes
// -----------------------------------------------------------------------------

describe("AccessJwtVerifier — failure modes", () => {
  it("rejects a missing assertion header with MissingAssertionError", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const err = await verifier.verifyRequest({}).then(
      () => {
        throw new Error("expected failure");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MissingAssertionError);
    expect((err as MissingAssertionError).code).toBe("MISSING_ASSERTION");
  });

  it("rejects an empty assertion header value with MissingAssertionError", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    await expect(verifier.verifyRequest({ "Cf-Access-Jwt-Assertion": "" })).rejects.toBeInstanceOf(
      MissingAssertionError,
    );
    await expect(verifier.verifyRequest({ "Cf-Access-Jwt-Assertion": "   " })).rejects.toBeInstanceOf(
      MissingAssertionError,
    );
  });

  it("rejects a JWT signed by a different key (signature mismatch)", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const otherPair = await jose.generateKeyPair("RS256", { extractable: true });
    const assertion = await signAccessJwt({ key: otherPair.privateKey });
    await expectInvalid(verifier.verifyRequest(headersFor(assertion)), "signature");
  });

  it("rejects a wrong issuer", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const assertion = await signAccessJwt({
      payload: { iss: "https://wrong-team.cloudflareaccess.com" },
    });
    await expectInvalid(verifier.verifyRequest(headersFor(assertion)), "issuer");
  });

  it("rejects a wrong audience", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const assertion = await signAccessJwt({ payload: { aud: "someone-elses-aud" } });
    await expectInvalid(verifier.verifyRequest(headersFor(assertion)), "audience");
  });

  it("rejects an assertion without a subject", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signAccessJwt({
      payload: { sub: undefined, exp: now + 60 },
    });
    await expectInvalid(verifier.verifyRequest(headersFor(assertion)), "subject");
  });

  it("rejects an assertion with an empty subject", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const assertion = await signAccessJwt({ payload: { sub: "" } });
    await expectInvalid(verifier.verifyRequest(headersFor(assertion)), "subject");
  });

  it("rejects an expired assertion (exp enforcement, no clock tolerance)", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signAccessJwt({
      payload: { exp: now - 10, iat: now - 100 },
    });
    await expectInvalid(verifier.verifyRequest(headersFor(assertion)), "expired");
  });

  it("rejects a malformed (non-JWT) assertion", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    await expectInvalid(verifier.verifyRequest(headersFor("not-a-jwt")), "malformed");
  });
});

// -----------------------------------------------------------------------------
// JWKS cache behavior
// -----------------------------------------------------------------------------

describe("AccessJwtVerifier — JWKS cache", () => {
  it("serves repeated verifications from cache (one fetch)", async () => {
    const { verifier, calls } = makeVerifier([jwksWithKids(KID)]);
    const a = await signAccessJwt();
    const b = await signAccessJwt();
    await verifier.verifyRequest(headersFor(a));
    await verifier.verifyRequest(headersFor(b));
    expect(calls).toEqual([TEAM_DOMAIN]);
  });

  it("refreshes the JWKS once when the kid is unknown, then succeeds", async () => {
    // First fetch: JWKS without the token's kid. Second fetch: rotated set
    // containing it. The verifier must refresh and verify successfully.
    const { verifier, calls } = makeVerifier([jwksWithKids(OTHER_KID), jwksWithKids(OTHER_KID, KID)]);
    const assertion = await signAccessJwt();
    const result = await verifier.verifyRequest(headersFor(assertion));
    expect(result.subject).toBe(SUBJECT);
    expect(calls).toEqual([TEAM_DOMAIN, TEAM_DOMAIN]);
  });

  it("gives up after a single refresh when the kid remains unknown", async () => {
    const { verifier, calls } = makeVerifier([jwksWithKids(OTHER_KID)]);
    const assertion = await signAccessJwt();
    await expectInvalid(verifier.verifyRequest(headersFor(assertion)), "signature");
    expect(calls).toEqual([TEAM_DOMAIN, TEAM_DOMAIN]);
  });
});

// -----------------------------------------------------------------------------
// Constructor and error hygiene
// -----------------------------------------------------------------------------

describe("AccessJwtVerifier — construction and hygiene", () => {
  it("requires both a team domain and an audience", () => {
    expect(() => new AccessJwtVerifier({ teamDomain: "", audience: AUDIENCE })).toThrow(/teamDomain/);
    expect(() => new AccessJwtVerifier({ teamDomain: TEAM_DOMAIN, audience: "" })).toThrow(/audience/);
    expect(
      () => new AccessJwtVerifier({ teamDomain: "https://x y/", audience: AUDIENCE }),
    ).toThrow(/teamDomain/);
  });

  it("never includes the assertion body in error messages", async () => {
    const { verifier } = makeVerifier([jwksWithKids(KID)]);
    const otherPair = await jose.generateKeyPair("RS256", { extractable: true });
    const badSignature = await signAccessJwt({ key: otherPair.privateKey });
    const expired = await signAccessJwt({
      payload: { exp: Math.floor(Date.now() / 1000) - 10 },
    });
    for (const assertion of [badSignature, expired, "not-a-jwt"]) {
      const err = await verifier.verifyRequest(headersFor(assertion)).then(
        () => {
          throw new Error("expected failure");
        },
        (e: unknown) => e,
      );
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(assertion.slice(0, 48));
      expect(message).not.toContain(assertion.slice(-48));
    }
  });
});
