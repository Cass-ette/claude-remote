import * as jose from "jose";

/**
 * Cloudflare Access JWT assertion verifier (spec §10.2).
 *
 * Cloudflare Access, fronting the tunnel, injects a `Cf-Access-Jwt-Assertion`
 * header into every origin request. The verifier checks that assertion
 * against the team JWKS: signature, issuer (`https://<team>.cloudflareaccess.com`),
 * audience (the application's AUD tag), subject presence, and expiry.
 *
 * SECURITY INVARIANTS:
 * - The unverified token is only ever decoded (`decodeProtectedHeader`) to
 *   extract the `kid` for JWKS lookup; no claim is trusted before
 *   `jose.jwtVerify` succeeds.
 * - The assertion body is NEVER logged or included in error messages; errors
 *   carry a machine-readable reason only.
 * - Clock tolerance for `exp`/`nbf` is the jose default (none).
 */

/** Header carrying the Access JWT assertion (matched case-insensitively). */
export const CF_ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

/** Identity extracted from a verified Access assertion. */
export interface VerifiedAccessIdentity {
  /** Verified `sub` claim — the Access identity (spec §10.3). */
  readonly subject: string;
  /** The configured Access application audience (exact match enforced). */
  readonly audience: string;
  /** Verified `exp` claim as an ISO-8601 string (used for the WS deadline). */
  readonly expiresAt: string;
}

/** Function that fetches the JWKS document for a team domain. */
export type JwksFetcher = (teamDomain: string) => Promise<jose.JSONWebKeySet>;

/**
 * Default JWKS fetcher: the canonical Cloudflare Access certs endpoint.
 * A non-2xx response surfaces as a plain `Error` — the assertion itself is
 * never implicated, and callers may map fetch failures to 503.
 */
export const defaultJwksFetcher: JwksFetcher = async (teamDomain: string): Promise<jose.JSONWebKeySet> => {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`JWKS fetch failed: HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as jose.JSONWebKeySet;
};

export interface AccessJwtVerifierOptions {
  /**
   * Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com`.
   * An `https://` scheme prefix and trailing slash are tolerated and
   * normalized away. Required.
   */
  readonly teamDomain: string;
  /** Expected Access application audience (AUD tag). Required. */
  readonly audience: string;
  /** Injectable JWKS fetcher (tests substitute a stub). */
  readonly jwksFetcher?: JwksFetcher | undefined;
}

/** Machine-readable cause of an assertion rejection (for route mapping). */
export type AssertionFailureReason =
  | "signature"
  | "issuer"
  | "audience"
  | "subject"
  | "expired"
  | "malformed";

/** Stable error codes consumed by route error mapping (Task 24). */
export type AccessAssertionErrorCode = "MISSING_ASSERTION" | "INVALID_ASSERTION";

/** Thrown when the `Cf-Access-Jwt-Assertion` header is absent or blank. */
export class MissingAssertionError extends Error {
  readonly code: AccessAssertionErrorCode = "MISSING_ASSERTION";
  constructor() {
    super("Cloudflare Access assertion missing: Cf-Access-Jwt-Assertion header is absent or blank");
    this.name = "MissingAssertionError";
  }
}

/** Thrown when the assertion is present but fails verification. */
export class InvalidAssertionError extends Error {
  readonly code: AccessAssertionErrorCode = "INVALID_ASSERTION";
  /** Machine-readable failure category. Never contains token content. */
  readonly reason: AssertionFailureReason;
  constructor(reason: AssertionFailureReason, message: string) {
    super(message);
    this.name = "InvalidAssertionError";
    this.reason = reason;
  }
}

/** Hostname with at least two dot-separated labels, no scheme/path/port. */
const TEAM_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Normalize a Cloudflare Access team domain: trim, lowercase, strip an
 * `https://` scheme prefix and trailing slashes. Returns `undefined` when the
 * result is not a bare multi-label hostname (path, query, userinfo, port,
 * spaces, or a single-label name are all rejected).
 */
export function normalizeTeamDomain(input: string): string | undefined {
  if (typeof input !== "string") return undefined;
  let value = input.trim().toLowerCase();
  if (value.startsWith("https://")) {
    value = value.slice("https://".length);
  }
  value = value.replace(/\/+$/, "");
  return TEAM_DOMAIN_PATTERN.test(value) ? value : undefined;
}

interface CachedJwks {
  readonly keySet: jose.JSONWebKeySet;
  /** Wall-clock timestamp (ms) of the fetch. */
  readonly fetchedAt: number;
}

/** JWKS cache lifetime; after this the next verification refetches. */
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

export class AccessJwtVerifier {
  private readonly teamDomain: string;
  private readonly audience: string;
  private readonly fetcher: JwksFetcher;
  private cache: CachedJwks | null = null;

  constructor(options: AccessJwtVerifierOptions) {
    const teamDomain = normalizeTeamDomain(options.teamDomain);
    if (teamDomain === undefined) {
      throw new Error(
        `AccessJwtVerifier requires a valid teamDomain such as "myteam.cloudflareaccess.com"; got ${JSON.stringify(options.teamDomain)}.`,
      );
    }
    const audience = typeof options.audience === "string" ? options.audience.trim() : "";
    if (audience === "") {
      throw new Error("AccessJwtVerifier requires a non-empty audience (the Access application AUD tag).");
    }
    this.teamDomain = teamDomain;
    this.audience = audience;
    this.fetcher = options.jwksFetcher ?? defaultJwksFetcher;
  }

  /** Expected issuer derived from the team domain. */
  get issuer(): string {
    return `https://${this.teamDomain}`;
  }

  /**
   * Verify the `Cf-Access-Jwt-Assertion` header of an inbound request
   * (header lookup is case-insensitive). Throws {@link MissingAssertionError}
   * when the header is absent/blank and {@link InvalidAssertionError} when
   * verification fails. Never returns or throws the assertion body.
   */
  async verifyRequest(headers: Record<string, string | string[] | undefined>): Promise<VerifiedAccessIdentity> {
    const raw = this.extractAssertion(headers);
    return this.verifyAssertion(raw);
  }

  /** Extract and validate the assertion header value. */
  private extractAssertion(headers: Record<string, string | string[] | undefined>): string {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== CF_ACCESS_ASSERTION_HEADER) continue;
      let assertion: string;
      if (Array.isArray(value)) {
        // Duplicate assertion headers are never legitimate; reject as malformed.
        if (value.length !== 1) {
          throw new InvalidAssertionError("malformed", "assertion header must appear exactly once");
        }
        assertion = value[0] ?? "";
      } else {
        assertion = value ?? "";
      }
      if (assertion.trim() === "") {
        throw new MissingAssertionError();
      }
      return assertion;
    }
    throw new MissingAssertionError();
  }

  /**
   * Verify a raw assertion string. The protected header is decoded WITHOUT
   * trusting it (only the `kid` is read for JWKS selection); every claim is
   * validated by `jose.jwtVerify` with issuer/audience pinned and default
   * (zero) clock tolerance.
   */
  async verifyAssertion(rawAssertion: string): Promise<VerifiedAccessIdentity> {
    if (typeof rawAssertion !== "string" || rawAssertion.trim() === "") {
      throw new MissingAssertionError();
    }

    let protectedHeader: jose.ProtectedHeaderParameters;
    try {
      protectedHeader = jose.decodeProtectedHeader(rawAssertion);
    } catch {
      throw new InvalidAssertionError("malformed", "assertion is not a syntactically valid JWT");
    }

    try {
      const { payload } = await jose.jwtVerify(rawAssertion, async () => this.selectKey(protectedHeader), {
        issuer: this.issuer,
        audience: this.audience,
      });

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new InvalidAssertionError("subject", "assertion has no subject (sub) claim");
      }
      if (typeof payload.exp !== "number") {
        // jose validates exp only when present; Task 24 needs the expiry for
        // the socket deadline, so a missing exp is a malformed assertion.
        throw new InvalidAssertionError("malformed", "assertion has no expiry (exp) claim");
      }

      return {
        subject: payload.sub,
        audience: this.audience,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
      };
    } catch (err) {
      throw this.toAssertionError(err);
    }
  }

  /**
   * Resolve the JWKS key for the (untrusted) protected header. Serves from
   * cache while fresh; refreshes once — forced when the cached set lacks the
   * requested `kid` (Cloudflare key rotation).
   */
  private async selectKey(
    protectedHeader: jose.ProtectedHeaderParameters,
  ): Promise<jose.KeyLike | Uint8Array> {
    const kid = protectedHeader.kid;
    let keySet = await this.getCachedJwks();
    let jwk = findJwk(keySet, kid);
    if (jwk === undefined) {
      keySet = await this.refreshJwks();
      jwk = findJwk(keySet, kid);
    }
    if (jwk === undefined) {
      // Unknown kid even after a refresh: the signature cannot be verified.
      throw new InvalidAssertionError(
        "signature",
        `assertion references a key absent from the team JWKS${kid === undefined ? "" : " (unknown kid)"}`,
      );
    }
    return jose.importJWK(jwk, protectedHeader.alg ?? "RS256");
  }

  /** Cached JWKS if fresh, else a refresh (which also re-populates the cache). */
  private async getCachedJwks(): Promise<jose.JSONWebKeySet> {
    if (this.cache !== null && Date.now() - this.cache.fetchedAt < JWKS_CACHE_TTL_MS) {
      return this.cache.keySet;
    }
    return this.refreshJwks();
  }

  /** Force a JWKS fetch and update the cache. */
  private async refreshJwks(): Promise<jose.JSONWebKeySet> {
    const keySet = await this.fetcher(this.teamDomain);
    this.cache = { keySet, fetchedAt: Date.now() };
    return keySet;
  }

  /** Map jose/verification failures to typed errors; no token content. */
  private toAssertionError(err: unknown): Error {
    if (err instanceof InvalidAssertionError || err instanceof MissingAssertionError) {
      return err;
    }
    if (err instanceof jose.errors.JWTExpired) {
      return new InvalidAssertionError("expired", "assertion is expired");
    }
    if (err instanceof jose.errors.JWTClaimValidationFailed) {
      switch (err.claim) {
        case "iss":
          return new InvalidAssertionError("issuer", "assertion issuer does not match the configured team domain");
        case "aud":
          return new InvalidAssertionError("audience", "assertion audience does not match the configured audience");
        case "exp":
          return new InvalidAssertionError("expired", "assertion is expired");
        default:
          return new InvalidAssertionError("malformed", "assertion failed claim validation");
      }
    }
    if (err instanceof jose.errors.JWSSignatureVerificationFailed || err instanceof jose.errors.JOSEAlgNotAllowed) {
      return new InvalidAssertionError("signature", "assertion signature verification failed");
    }
    if (err instanceof jose.errors.JWSInvalid || err instanceof jose.errors.JWTInvalid) {
      return new InvalidAssertionError("malformed", "assertion is not a valid signed JWT");
    }
    // JWKS fetch failures and anything unexpected propagate unchanged (the
    // assertion is not at fault; route mapping may treat these as 5xx).
    return err instanceof Error ? err : new Error("assertion verification failed");
  }
}

function findJwk(keySet: jose.JSONWebKeySet, kid: string | undefined): jose.JWK | undefined {
  if (kid === undefined) {
    return keySet.keys[0];
  }
  return keySet.keys.find((k) => k.kid === kid);
}
