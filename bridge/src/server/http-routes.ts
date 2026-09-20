/**
 * Public-network HTTP routes (Task 24 wiring, spec §9, §10.3, §10.6).
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
 *
 * §10.6 auditing: every auth attempt, every authenticated-route denial, and
 * every WS auth failure is audited (auth.pair / auth.challenge / auth.verify
 * / auth.request / auth.ws; the runtime's revokeDevice writes device.revoke).
 * Challenge and verify failures audit a deliberately uniform
 * "uniform-failure" code — the audit never names the sub-failure either.
 * deviceId and accessSubject are recorded where known; tokens and assertion
 * values are never passed to the audit log.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessIdentitySource, VerifiedAccessIdentity } from "../auth/access-jwt-verifier.js";
import type { DeviceAuth } from "../auth/device-auth.js";
import type { AuditLog } from "../audit/audit-log.js";
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
  /**
   * Verified Access identity source — the bridge's opaque-token resolver in
   * production; null in local-only mode (auth impossible).
   */
  readonly verifier: AccessIdentitySource | null;
  readonly devices: DeviceAuth;
  readonly dispatcher: CommandDispatcher;
  /** §10.6 audit sink for auth request events. */
  readonly audit: AuditLog;
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
 * assertion subject byte-for-byte. Failures carry the §10.6 audit reason
 * code and any partially-established identity (never echoed to the client).
 */
export type AuthnFailure = {
  readonly status: 401 | 403;
  /** §10.6 audit reason code ("unauthorized" | "subject_mismatch"). */
  readonly reason: string;
  readonly accessSubject?: string;
  readonly deviceId?: string;
};

export async function authenticateCommand(
  deps: ApiRoutesDeps,
  headers: Headers,
): Promise<AuthenticatedCommand | AuthnFailure> {
  if (deps.verifier === null) {
    return { status: 401, reason: "unauthorized" };
  }
  let identity: VerifiedAccessIdentity;
  try {
    identity = await deps.verifier.verifyRequest(headers);
  } catch {
    return { status: 401, reason: "unauthorized" };
  }
  const token = headerAsString(headers, DEVICE_SESSION_HEADER);
  const validated =
    token === null || token === "" ? null : deps.devices.validateDeviceSession(token, deps.now());
  if (validated === null) {
    return { status: 401, reason: "unauthorized", accessSubject: identity.subject };
  }
  if (validated.accessSubject !== identity.subject) {
    return {
      status: 403,
      reason: "subject_mismatch",
      accessSubject: identity.subject,
      deviceId: validated.deviceId,
    };
  }
  return { deviceId: validated.deviceId, accessSubject: identity.subject };
}

/** Audit reason code for a device-auth error on /auth/pair (§10.6). */
function pairAuditCode(error: unknown): string {
  switch ((error as Error).name) {
    case "PairingTokenError":
      return "invalid_pairing_token";
    case "SinglePairedDeviceError":
      return "one_device_limit";
    case "SubjectMismatchError":
      return "subject_mismatch";
    default:
      // InvalidPublicKeyError / DeviceIdMismatchError / malformed bodies.
      return "bad_request";
  }
}

/**
 * Audit reason code for a device-auth error on /auth/challenge and
 * /auth/verify: deliberately uniform — the audit never names which check
 * failed either (§10.3 applies to the trail as much as the response).
 */
function uniformAuditCode(error: unknown): string {
  switch ((error as Error).name) {
    case "ChallengeError":
    case "SignatureError":
    case "UnknownDeviceError":
    case "DeviceRevokedError":
    case "SubjectMismatchError":
    case "InvalidHostException":
      return "uniform-failure";
    default:
      return "bad_request";
  }
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiRoutesDeps): void {
  app.post("/api/v1/auth/pair", async (request, reply) => {
    const identity = await requireAccess(deps, request);
    if ("status" in identity) {
      deps.audit.write({ operationType: "auth.pair", resultCode: "unauthorized" });
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
      deps.audit.write({
        operationType: "auth.pair",
        deviceId,
        accessSubject: identity.subject,
        resultCode: "ok",
        committed: true,
      });
      return reply.code(200).send({ deviceId });
    } catch (error) {
      const mapped = mapAuthError(error);
      deps.audit.write({
        operationType: "auth.pair",
        accessSubject: identity.subject,
        resultCode: pairAuditCode(error),
        // The client-claimed deviceId (already server-side recomputed on
        // success); populated where known per §10.6.
        ...(typeof body.deviceId === "string" && body.deviceId !== ""
          ? { deviceId: body.deviceId }
          : {}),
      });
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post("/api/v1/auth/challenge", async (request, reply) => {
    const identity = await requireAccess(deps, request);
    if ("status" in identity) {
      deps.audit.write({ operationType: "auth.challenge", resultCode: "unauthorized" });
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
      deps.audit.write({
        operationType: "auth.challenge",
        ...(typeof body.deviceId === "string" && body.deviceId !== ""
          ? { deviceId: body.deviceId }
          : {}),
        accessSubject: identity.subject,
        resultCode: "ok",
        committed: true,
      });
      return reply.code(200).send({
        challengeId: challenge.challengeId,
        challengeRawB64u: challenge.challengeRawB64u,
        accessSubject: challenge.accessSubject,
        hostAscii: challenge.hostAscii,
        expiresAt: challenge.expiresAt,
      });
    } catch (error) {
      // Log the error for debugging 500 responses
      console.error("auth.challenge error:", error instanceof Error ? error.message : String(error), error);
      deps.audit.write({
        operationType: "auth.challenge",
        accessSubject: identity.subject,
        resultCode: uniformAuditCode(error),
      });
      const mapped = mapAuthError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post("/api/v1/auth/verify", async (request, reply) => {
    const identity = await requireAccess(deps, request);
    if ("status" in identity) {
      deps.audit.write({ operationType: "auth.verify", resultCode: "unauthorized" });
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
      deps.audit.write({
        operationType: "auth.verify",
        accessSubject: identity.subject,
        resultCode: "ok",
        committed: true,
      });
      return reply.code(200).send(session);
    } catch (error) {
      deps.audit.write({
        operationType: "auth.verify",
        accessSubject: identity.subject,
        resultCode: uniformAuditCode(error),
      });
      const mapped = mapAuthError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
  });

  app.post("/api/v1/commands", async (request, reply) => {
    const authn = await authenticateCommand(deps, request.headers);
    if ("status" in authn) {
      deps.audit.write({
        operationType: "auth.request",
        resultCode: authn.reason,
        ...(authn.accessSubject !== undefined ? { accessSubject: authn.accessSubject } : {}),
        ...(authn.deviceId !== undefined ? { deviceId: authn.deviceId } : {}),
      });
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
