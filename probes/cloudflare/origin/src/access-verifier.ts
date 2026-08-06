import * as jose from "jose";

/**
 * Cloudflare Access JWT verifier.
 *
 * Reads the `Cf-Access-Jwt-Assertion` header from an inbound request, fetches
 * the team-domain JWKS, and verifies signature, issuer, audience, subject
 * presence, and expiry. NEVER logs the assertion body.
 *
 * The JWKS is cached in-memory; on an unknown `kid` the cache is refreshed
 * once and the verification is retried.
 */

export interface VerifiedClaims {
  /** Token issuer (`https://<team>.cloudflareaccess.com`). */
  issuer: string;
  /** Configured Access audience (the application's AUD). */
  audience: string;
  /** Identity subject (typically an email). */
  subject: string;
  /** Expiry as an ISO-8601 string. */
  expiresAt: string;
}

export interface AccessVerifierConfig {
  /** The Access team domain (e.g. `myteam.cloudflareaccess.com`). */
  teamDomain: string;
  /** The expected Access application audience. */
  audience: string;
  /** The expected subject. If provided, a non-matching subject is rejected. */
  expectedSubject?: string;
}

/** Function type for fetching the JWKS document for the configured team. */
export type JwksFetcher = (teamDomain: string) => Promise<jose.JSONWebKeySet>;

/**
 * Default JWKS fetcher: hits the canonical Cloudflare Access certs URL.
 * Exported so tests can substitute a stub.
 */
export const defaultJwksFetcher: JwksFetcher = async (teamDomain: string): Promise<jose.JSONWebKeySet> => {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`JWKS fetch failed: ${res.status} for ${url}`);
  }
  return (await res.json()) as jose.JSONWebKeySet;
};

interface CachedJwks {
  keySet: jose.JSONWebKeySet;
  /** Monotonic timestamp (ms) of last refresh. */
  fetchedAt: number;
}

const REFRESH_TTL_MS = 60 * 60 * 1000; // 1 hour

export class AccessVerifier {
  private readonly cfg: AccessVerifierConfig;
  private readonly fetcher: JwksFetcher;
  private cache: CachedJwks | null = null;

  constructor(cfg: AccessVerifierConfig, fetcher: JwksFetcher = defaultJwksFetcher) {
    this.cfg = cfg;
    this.fetcher = fetcher;
  }

  /** Expected issuer for this verifier. */
  get issuer(): string {
    return `https://${this.cfg.teamDomain}`;
  }

  /**
   * Verify a raw assertion string. Throws on any failure.
   * Returns only the verified-claims metadata — never the raw JWT.
   */
  async verifyAssertion(rawAssertion: string): Promise<VerifiedClaims> {
    if (!rawAssertion || typeof rawAssertion !== "string") {
      throw new Error("missing assertion");
    }

    // Decode header WITHOUT trusting claims, to extract kid for JWKS lookup.
    const decoded = jose.decodeProtectedHeader(rawAssertion);
    const kid = decoded.kid;

    const getKey = async (): Promise<jose.KeyLike> => {
      const jwks = await this.getJwks(kid);
      const key = jwks.keys.find((k) => (kid === undefined ? true : k.kid === kid));
      if (!key) {
        throw new Error(`kid ${kid ?? "<none>"} not found in JWKS`);
      }
      return (await jose.importJWK(key, decoded.alg ?? "RS256")) as jose.KeyLike;
    };

    const { payload } = await jose.jwtVerify(rawAssertion, getKey, {
      issuer: this.issuer,
      audience: this.cfg.audience
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("assertion missing subject");
    }
    if (this.cfg.expectedSubject && payload.sub !== this.cfg.expectedSubject) {
      throw new Error("assertion subject mismatch");
    }
    if (typeof payload.exp !== "number") {
      throw new Error("assertion missing exp");
    }

    return {
      issuer: this.issuer,
      audience: this.cfg.audience,
      subject: payload.sub,
      expiresAt: new Date(payload.exp * 1000).toISOString()
    };
  }

  /**
   * Get the (cached) JWKS. If `kid` is not present in the cached set, or the
   * cache is older than REFRESH_TTL_MS, refresh once and retry.
   */
  private async getJwks(kid: string | number | undefined): Promise<jose.JSONWebKeySet> {
    const now = Date.now();
    const fresh = this.cache && now - this.cache.fetchedAt < REFRESH_TTL_MS;
    if (this.cache && fresh) {
      const hit = this.cache.keySet.keys.some(
        (k) => kid === undefined || k.kid === kid
      );
      if (hit) return this.cache.keySet;
    }
    // Refresh.
    const keySet = await this.fetcher(this.cfg.teamDomain);
    this.cache = { keySet, fetchedAt: now };
    return keySet;
  }
}
