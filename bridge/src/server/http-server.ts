import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import Fastify, { type FastifyInstance } from "fastify";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { BridgeConfig } from "../config.js";

/**
 * Capability values advertised over `GET /api/v1/capabilities`.
 *
 * Later tasks inject real values (e.g. the detected Claude Code version
 * from Chunk 3); Task 6 serves the static skeleton.
 */
export interface CapabilityOverrides {
  /** Detected Claude Code version; `null` until Chunk 3 wires the probe. */
  claudeCodeVersion?: string | null;
  /** Additional feature flags; empty for the Task 6 skeleton. */
  features?: readonly string[];
}

export interface CapabilitiesResponse {
  protocolVersion: string;
  minimumAndroidVersion: number;
  bridgeVersion: string;
  claudeCodeVersion: string | null;
  features: string[];
  serverTime: string;
}

export interface HealthResponse {
  status: "ok";
}

export const PROTOCOL_VERSION = "claude-remote.v1";
export const MINIMUM_ANDROID_VERSION = 28;

const require = createRequire(import.meta.url);
// Resolve the workspace package.json whether running from src (vitest/tsx)
// or dist/src (built output): the depth differs by one hop.
const pkgCandidates = ["../../package.json", "../../../package.json"];
const pkgPath = pkgCandidates.find((p) => {
  try {
    return existsSync(require.resolve(p));
  } catch {
    return false;
  }
});
if (pkgPath === undefined) {
  throw new Error("cannot locate bridge package.json for bridgeVersion");
}
const bridgeVersion: string = require(pkgPath).version as string;
// ajv-formats ships CJS with an esModule default; NodeNext cannot express
// that callable default import cleanly, so require it like runtime ESM would.
const addFormats = require("ajv-formats").default as (ajv: Ajv2020) => Ajv2020;

const healthSchema = {
  type: "object",
  required: ["status"],
  properties: { status: { const: "ok" } },
  additionalProperties: false,
} as const;

const capabilitiesSchema = {
  type: "object",
  required: [
    "protocolVersion",
    "minimumAndroidVersion",
    "bridgeVersion",
    "claudeCodeVersion",
    "features",
    "serverTime",
  ],
  properties: {
    protocolVersion: { const: PROTOCOL_VERSION },
    minimumAndroidVersion: { const: MINIMUM_ANDROID_VERSION },
    bridgeVersion: { type: "string", minLength: 1 },
    claudeCodeVersion: { type: ["string", "null"] },
    features: { type: "array", items: { type: "string" } },
    serverTime: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
} as const;

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validateHealth = ajv.compile<HealthResponse>(healthSchema);
const validateCapabilities = ajv.compile<CapabilitiesResponse>(capabilitiesSchema);

function assertValid<T>(validate: ValidateFunction<T>, body: T): T {
  if (!validate(body)) {
    throw new Error(`response schema violation: ${ajv.errorsText(validate.errors)}`);
  }
  return body;
}

/**
 * Build the Bridge HTTP/WS server.
 *
 * Returns a Fastify instance that is NOT yet listening; callers own
 * `listen()`/`close()`. The server only serves paths under `/api/v1/`;
 * everything else is a plain 404.
 */
export function startHttpServer(
  config: BridgeConfig,
  capabilities: CapabilityOverrides,
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: "info",
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['sec-websocket-protocol']"],
        censor: "[redacted]",
      },
    },
  });

  app.get("/api/v1/health", async () => {
    return assertValid(validateHealth, { status: "ok" } satisfies HealthResponse);
  });

  app.get("/api/v1/capabilities", async () => {
    return assertValid(
      validateCapabilities,
      {
        protocolVersion: PROTOCOL_VERSION,
        minimumAndroidVersion: MINIMUM_ANDROID_VERSION,
        bridgeVersion,
        claudeCodeVersion: capabilities.claudeCodeVersion ?? null,
        features: [...(capabilities.features ?? [])],
        serverTime: new Date().toISOString(),
      } satisfies CapabilitiesResponse,
    );
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "not_found" });
  });

  return app;
}
