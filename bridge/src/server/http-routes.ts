/**
 * Public-network HTTP routes (Task 24 wiring, spec §9, §10.3).
 *
 *   POST /api/v1/auth/pair       — pairing-token device enrollment
 *   POST /api/v1/auth/challenge  — issue the signed-challenge nonce
 *   POST /api/v1/auth/verify     — verify the device signature, mint a
 *                                   device session token
 *   POST /api/v1/commands        — authenticated command endpoint (§9)
 *
 * Every route is fronted by the verified Cloudflare Access assertion. Per
 * §10.3, authentication failures are uniform and detail-free: the response
 * never reveals WHICH step failed. Typed device-auth errors are collapsed
 * to 401/403/400 by {@link mapAuthError}; only the one-device rule
 * (SinglePairedDeviceError → 403) and subject mismatches (→ 403) are
 * distinguishable from generic 401s, because the client must act on them.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessJwtVerifier, VerifiedAccessIdentity } from "../auth/access-jwt-verifier.js";
import type { DeviceAuth } from "../auth/device-auth.js";
import type { CommandDispatcher } from "../commands/command-dispatcher.js";
import { PROTOCOL_VERSION } from "../protocol/v1/types.js";
import { validateCommand } from "../protocol/v1/validator.js";

export const DEVICE_SESSION_HEADER = "x-claude-remote-device-session";

/** Identity established for /commands (two-layer auth, spec §10.3). */
export interface AuthenticatedCommand {
  readonly deviceId: string;
  readonly accessSubject: string;
}

export interface ApiRoutesDeps {
  /** Verified Access identity source; null in local-only mode (auth impossible). */
  readonly verifier: AccessJwtVerifier | null;
  readonly devices: DeviceAuth;
  readonly dispatcher: CommandDispatcher;
  /** Bridge public host (BRIDGE_PUBLIC_HOST) — challenge signing input. */
  readonly hostAscii: string;
  readonly now: () => number;
}

type Headers = Record<string, string | string[] | undefined>;

function headerAsString(headers: Headers, name: string): string | null {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1) return value[0] ?? null;
  return null;
}

/** Verify the Access assertion of an inbound request; 401 body is uniform. */
async function requireAccess(
  deps: ApiRoutesDeps,
  request: FastifyRequest,
): Promise<VerifiedAccessIdentity | { readonly status: 401 }> {
  if (deps.verifier === null) {
    return { status: 401 };
  }
  try {
    return await deps.verifier.verifyRequest(request.headers);
  } catch {
    // Missing/invalid assertion, JWKS fetch failure — uniform 401; no detail.
    return { status: 401 };
  }
}

/** Map typed device-auth errors to route outcomes (§10.3). */
function mapAuthError(error: unknown): { status: number; body: Record<string, string> } {
  const name = (error as Error).name;
  switch (name) {
    case "SinglePairedDeviceError":
      return { status: 403, body: { error: "device_already_paired" } };
    case "SubjectMismatchError":
      return { status: 403, body: { error: "subject_mismatch" } };
    case "PairingTokenError":
    case "ChallengeError":
    case "SignatureError":
    case "UnknownDeviceError":
    case "DeviceRevokedError":
      // Deliberately uniform: pairing token / challenge / signature failures
      // never disclose which check failed.
      return { status: 401, body: { error: "authentication_failed" } };
    case "InvalidHostException":
      return { status: 500, body: { error: "internal" } };
    default:
      // InvalidPublicKeyError / DeviceIdMismatchError / malformed bodies.
      return { status: 400, body: { error: "bad_request" } };
  }
}

/**
 * Two-layer /commands authentication (§10.3): a verified Access assertion
 * PLUS a still-valid device session, whose accessSubject must equal the
 * assertion subject byte-for-byte.
 */
export async function authenticateCommand(
  deps: ApiRoutesDeps,
  headers: Headers,
): Promise<AuthenticatedCommand | { readonly status: 401 | 403 }> {
  if (deps.verifier === null) {
    return { status: 401 };
  }
  let identity: VerifiedAccessIdentity;
  try {
    identity = await deps.verifier.verifyRequest(headers);
  } catch {
    return { status: 401 };
  }
  const token = headerAsString(headers, DEVICE_SESSION_HEADER);
  const validated =
    token === null || token === "" ? null : deps.devices.validateDeviceSession(token, deps.now());
  if (validated === null) {
    return { status: 401 };
  }
  if (validated.accessSubject !== identity.subject) {
    return { status: 403 };
  }
  return { deviceId: validated.deviceId, accessSubject: identity.subject };
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiRoutesDeps): void {
  app.post("/api/v1/auth/pair", async (request, reply) => {
    const identity = await requireAccess(deps, request);
    if ("status" in identity) {
      return reply.code(identity.status).send({ error: "unauthorized" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const { deviceId } = deps.devices.pairWithToken({
        pairingToken: typeof body.pairingToken === "string" ? body.pairingToken : "",
        publicKeySpkiB64u: typeof body.publicKeySpkiB64u === "string" ? body.publicKeySpkiB64u : "",
        deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
        accessSubject: identity.subject,
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
        now: deps.now(),
      });
      return reply.code(200).send({ deviceId });
    } catch (error) {
      const mapped = mapAuthError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post("/api/v1/auth/challenge", async (request, reply) => {
    const identity = await requireAccess(deps, request);
    if ("status" in identity) {
      return reply.code(identity.status).send({ error: "unauthorized" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const challenge = deps.devices.issueChallenge({
        deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
        accessSubject: identity.subject,
        hostAscii: deps.hostAscii,
        now: deps.now(),
      });
      return reply.code(200).send({
        challengeId: challenge.challengeId,
        challengeRawB64u: challenge.challengeRawB64u,
        accessSubject: challenge.accessSubject,
        expiresAt: challenge.expiresAt,
      });
    } catch (error) {
      const mapped = mapAuthError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post("/api/v1/auth/verify", async (request, reply) => {
    const identity = await requireAccess(deps, request);
    if ("status" in identity) {
      return reply.code(identity.status).send({ error: "unauthorized" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const session = deps.devices.verifyDeviceSignature({
        challengeId: typeof body.challengeId === "string" ? body.challengeId : "",
        accessSubjectEcho: typeof body.accessSubjectEcho === "string" ? body.accessSubjectEcho : "",
        signatureB64u: typeof body.signatureB64u === "string" ? body.signatureB64u : "",
        currentAccessSubject: identity.subject,
        now: deps.now(),
      });
      return reply.code(200).send(session);
    } catch (error) {
      const mapped = mapAuthError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post("/api/v1/commands", async (request, reply) => {
    const authn = await authenticateCommand(deps, request.headers);
    if ("status" in authn) {
      return reply
        .code(authn.status)
        .send({ error: authn.status === 403 ? "forbidden" : "unauthorized" });
    }
    const validated = validateCommand(request.body);
    if (!validated.ok) {
      return reply.code(400).send({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "",
        responseType: "command.error",
        error: { code: "INVALID_COMMAND", message: validated.error, retryable: false },
      });
    }
    const outcome = await deps.dispatcher.dispatch(validated.value, authn.deviceId);
    return reply.code(outcome.httpStatus).send(outcome.response);
  });
}
