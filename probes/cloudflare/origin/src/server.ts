import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AccessVerifier,
  type AccessVerifierConfig,
  type JwksFetcher,
  type VerifiedClaims
} from "./access-verifier.js";

/**
 * Loopback-only Cloudflare Access probe origin.
 *
 * Routes:
 *   GET  /probe/http                    — bearer + Access JWT gated
 *   GET  /probe/ws                      — WebSocket Upgrade gated
 *   POST /probe/evidence                — atomic evidence flush (mode 0600)
 *   GET  /.well-known/assetlinks.json   — App Link statement (Access-bypassed)
 *
 * The origin never logs the assertion body or bearer token. Evidence files
 * capture only verified-claims metadata (issuer/audience/subject/expiry) and
 * per-request `requestId`s.
 */

export interface OriginConfig {
  /** Bind host — must be loopback. */
  bindHost: string;
  /** Bind port (0 = kernel-assigned). */
  bindPort: number;
  /** Access team domain. */
  teamDomain: string;
  /** Expected Access application audience. */
  audience: string;
  /** Expected subject (email). If omitted, only "is present" is enforced. */
  expectedSubject?: string;
  /** Absolute path to the atomic evidence file. */
  evidenceFile: string;
  /** Asset links JSON to serve at /.well-known/assetlinks.json. */
  assetLinks?: unknown;
}

export interface OriginHandle {
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
  /** Direct handle (for tests). */
  instance: unknown;
}

export interface OriginEvidence {
  issuer: string;
  audience: string;
  subject: string;
  expiresAt: string;
  httpRequestIds: string[];
  wsRequestIds: string[];
  /** Timestamps of the last successful verification. */
  lastVerifiedAt: string;
}

export type { JwksFetcher } from "./access-verifier.js";

interface RuntimeEvidence {
  lastClaims: VerifiedClaims | null;
  httpRequestIds: string[];
  wsRequestIds: string[];
}

/**
 * Build and start the origin server. Returns a handle that exposes the
 * resolved port (and baseUrl) plus a close() that shuts everything down.
 */
export async function createOriginServer(
  cfg: OriginConfig,
  jwksFetcher: JwksFetcher
): Promise<OriginHandle> {
  if (cfg.bindHost !== "127.0.0.1" && cfg.bindHost !== "localhost") {
    throw new Error(`Refusing to bind non-loopback host: ${cfg.bindHost}`);
  }

  const verifierConfig: AccessVerifierConfig = {
    teamDomain: cfg.teamDomain,
    audience: cfg.audience
  };
  if (cfg.expectedSubject !== undefined) {
    verifierConfig.expectedSubject = cfg.expectedSubject;
  }
  const verifier = new AccessVerifier(verifierConfig, jwksFetcher);

  const runtime: RuntimeEvidence = {
    lastClaims: null,
    httpRequestIds: [],
    wsRequestIds: []
  };

  const app = Fastify({
    logger: false
  });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1024 * 1024 }
  });

  /**
   * Common verifier for both HTTP and WS. Throws on failure; the caller maps
   * to a 401. Records verified-claims metadata into the runtime evidence.
   */
  async function verifyRequest(request: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{ requestId: string; claims: VerifiedClaims }> {
    const bearer = request.headers["authorization"];
    const assertion = request.headers["cf-access-jwt-assertion"];
    const bearerStr = Array.isArray(bearer) ? bearer[0] : bearer;
    const assertionStr = Array.isArray(assertion) ? assertion[0] : assertion;
    if (!bearerStr || typeof bearerStr !== "string" || !bearerStr.startsWith("Bearer ")) {
      throw new Error("missing or malformed Authorization header");
    }
    if (!assertionStr || typeof assertionStr !== "string") {
      throw new Error("missing Cf-Access-Jwt-Assertion header");
    }
    const claims = await verifier.verifyAssertion(assertionStr);
    runtime.lastClaims = claims;
    return { requestId: randomUUID(), claims };
  }

  app.get("/probe/http", async (request, reply) => {
    try {
      const { requestId } = await verifyRequest(request);
      runtime.httpRequestIds.push(requestId);
      await flushEvidence(cfg.evidenceFile, runtime);
      return reply.status(200).send({ ok: true, requestId });
    } catch (err) {
      return reply.status(401).send({ ok: false, error: (err as Error).message });
    }
  });

  // Reject WS Upgrades BEFORE the connection is established, so the client
  // sees an HTTP 401 (not a 101) when headers are missing/invalid.
  app.get(
    "/probe/ws",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        try {
          await verifyRequest(request);
        } catch (err) {
          await reply.code(401).send({ ok: false, error: (err as Error).message });
        }
      }
    },
    async (socket, request) => {
      // Re-derive the requestId from already-verified claims. We can't reuse
      // the preValidation result directly because fastify hooks discard
      // arbitrary return values.
      const bearer = request.headers["authorization"];
      const assertion = request.headers["cf-access-jwt-assertion"];
      const assertionStr = Array.isArray(assertion) ? assertion[0] : assertion;
      void bearer;
      const claims = await verifier.verifyAssertion(assertionStr as string);
      runtime.lastClaims = claims;
      const requestId = randomUUID();
      runtime.wsRequestIds.push(requestId);
      await flushEvidence(cfg.evidenceFile, runtime);
      socket.send(JSON.stringify({ ok: true, requestId }));
      socket.close(1000, "ok");
    }
  );

  app.post("/probe/evidence", async (request, reply) => {
    try {
      // This endpoint is intended for the device to request a final evidence
      // flush; it requires the same Access verification as /probe/http.
      const { requestId } = await verifyRequest(request);
      runtime.httpRequestIds.push(requestId);
      await flushEvidence(cfg.evidenceFile, runtime);
      return reply.status(200).send({ ok: true, requestId });
    } catch (err) {
      return reply.status(401).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get("/.well-known/assetlinks.json", async (_request, reply) => {
    return reply
      .status(200)
      .header("content-type", "application/json")
      .send(cfg.assetLinks ?? []);
  });

  await app.listen({ host: cfg.bindHost, port: cfg.bindPort });

  const address = app.addresses();
  let port: number;
  if (Array.isArray(address)) {
    port = address[0]?.port ?? 0;
  } else if (address && typeof address === "object" && "port" in address) {
    port = (address as { port: number }).port;
  } else {
    port = 0;
  }
  const baseUrl = `http://${cfg.bindHost}:${port}`;

  return {
    baseUrl,
    port,
    instance: app,
    close: async () => {
      await app.close();
    }
  };
}

/**
 * Atomically write the evidence file with mode 0600. Writes to a sibling
 * temp file then renames; never throws inside the runtime.
 *
 * The evidence contains only verified-claims metadata and request IDs — never
 * the assertion body or bearer token.
 */
async function flushEvidence(path: string, runtime: RuntimeEvidence): Promise<void> {
  const claims = runtime.lastClaims;
  const evidence: OriginEvidence = {
    issuer: claims?.issuer ?? "",
    audience: claims?.audience ?? "",
    subject: claims?.subject ?? "",
    expiresAt: claims?.expiresAt ?? "",
    httpRequestIds: [...runtime.httpRequestIds],
    wsRequestIds: [...runtime.wsRequestIds],
    lastVerifiedAt: claims ? new Date().toISOString() : ""
  };
  const tmp = join(dirname(path), `.${process.pid}-${Date.now()}.tmp`);
  const data = JSON.stringify(evidence, null, 2) + "\n";
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}
