import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { BridgeConfig } from "../config.js";
import type { DeviceAuth, RevocationHooks } from "../auth/device-auth.js";
import type { ProjectRegistry } from "../projects/project-registry.js";
import type { AuditLog } from "../audit/audit-log.js";
import { getBridgeVersion } from "../server/http-server.js";
import { verifyAdminToken } from "./admin-token.js";
import { createAdminReads, type AdminReads } from "./admin-reads.js";

/** Log file names under <dataDir>/logs (launchd StandardOut/ErrPath convention). */
const LOG_FILES = { out: "bridge.out.log", err: "bridge.err.log" } as const;
const LOG_TAIL_DEFAULT_BYTES = 32_768;
const LOG_TAIL_MAX_BYTES = 256 * 1024;
const AUTH_FAIL_AUDIT_WINDOW_MS = 10_000;

export interface AdminApiDeps {
  readonly config: BridgeConfig;
  readonly token: string;
  readonly registry: ProjectRegistry;
  readonly devices: DeviceAuth;
  readonly audit: AuditLog;
  readonly reads: AdminReads;
  readonly revocationHooks: RevocationHooks;
  readonly now: () => number;
  readonly uptimeSeconds: () => number;
  /** Probe the public health endpoint: true/false reachable, null when no publicHost. */
  readonly probePublicHealth: () => Promise<boolean | null>;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send(errorBody(code, message));
}

export function createAdminServer(deps: AdminApiDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: "info", redact: { paths: ["req.headers.authorization"], censor: "[redacted]" } },
  });
  let lastAuthFailAuditAt = -Infinity;

  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!verifyAdminToken(deps.token, presented)) {
      const t = deps.now();
      if (t - lastAuthFailAuditAt >= AUTH_FAIL_AUDIT_WINDOW_MS) {
        lastAuthFailAuditAt = t;
        deps.audit.write({ operationType: "admin.auth_failed", resultCode: "denied", sourceIp: request.ip });
      }
      await sendError(reply, 401, "unauthorized", "missing or invalid admin bearer token");
    }
  });

  app.get("/admin/v1/status", async () => {
    const active = deps.devices.listDevices().find((d) => d.revokedAt === null) ?? null;
    return {
      uptimeSeconds: Math.floor(deps.uptimeSeconds()),
      publicReachable: await deps.probePublicHealth(),
      activeSessions: deps.reads.activeSessionCount(),
      device: active === null ? null : {
        deviceId: active.deviceId,
        displayName: active.displayName,
        pairedAt: active.pairedAt,
        sessionExpiresAt: deps.reads.deviceSessionExpiryMs(active.deviceId, deps.now()),
      },
      dbSizeBytes: deps.reads.dbSizeBytes(),
      version: getBridgeVersion(),
    };
  });

  app.get("/admin/v1/projects", async () => deps.registry.list());

  app.post("/admin/v1/projects", async (request, reply) => {
    const body = request.body as { path?: unknown; name?: unknown };
    const path = typeof body.path === "string" ? body.path : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!isAbsolute(path) || name === "") {
      return sendError(reply, 400, "invalid_project", "path must be absolute and name must be non-empty");
    }
    try {
      const record = deps.registry.authorize(path, name, { now: deps.now() });
      deps.audit.write({ operationType: "admin.authorize_project", resultCode: "ok", projectId: record.projectId, detail: { source: "admin_api" } });
      return reply.code(201).send(record);
    } catch (error) {
      return sendError(reply, 400, "invalid_project", (error as Error).message);
    }
  });

  app.delete("/admin/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const existing = deps.registry.get(projectId);
    if (existing === undefined) return sendError(reply, 404, "project_not_found", `no authorized project ${projectId}`);
    deps.registry.remove(projectId);
    deps.audit.write({ operationType: "admin.revoke_project", resultCode: "ok", projectId, detail: { source: "admin_api" } });
    return reply.code(204).send();
  });

  app.get("/admin/v1/devices", async () => {
    const all = deps.devices.listDevices();
    return { active: all.find((d) => d.revokedAt === null) ?? null, revoked: all.filter((d) => d.revokedAt !== null) };
  });

  app.post("/admin/v1/devices/:deviceId/revoke", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const target = deps.devices.listDevices().find((d) => d.deviceId === deviceId && d.revokedAt === null);
    if (target === undefined) return sendError(reply, 404, "device_not_found", `no active device ${deviceId}`);
    // Domain semantics: DB transaction commits first, then hooks (deny → close).
    deps.devices.revokeDevice(deviceId, deps.now(), deps.revocationHooks);
    deps.audit.write({ operationType: "admin.revoke_device", resultCode: "ok", deviceId, detail: { source: "admin_api" } });
    return reply.code(204).send();
  });

  app.post("/admin/v1/devices/revoke-all", async (_request, reply) => {
    for (const device of deps.devices.listDevices().filter((d) => d.revokedAt === null)) {
      deps.devices.revokeDevice(device.deviceId, deps.now(), deps.revocationHooks);
      deps.audit.write({ operationType: "admin.revoke_device", resultCode: "ok", deviceId: device.deviceId, detail: { source: "admin_api" } });
    }
    return reply.code(204).send();
  });

  app.post("/admin/v1/pairing/qrcode", async (_request, reply) => {
    if (deps.config.publicHost === undefined) {
      return sendError(reply, 409, "public_host_unset", "bridge runs local-only; set BRIDGE_PUBLIC_HOST and restart to mint pairing codes");
    }
    if (deps.devices.listDevices().some((d) => d.revokedAt === null)) {
      return sendError(reply, 409, "already_paired", "a device is already paired; revoke it first");
    }
    const minted = deps.devices.mintPairingToken(deps.now());
    // The pairing token itself never reaches the audit trail. Host and token
    // are URI-encoded exactly like the CLI's pairing-qrcode payload builder.
    deps.audit.write({ operationType: "admin.mint_pairing_token", resultCode: "ok", detail: { source: "admin_api" } });
    const host = encodeURIComponent(deps.config.publicHost);
    const token = encodeURIComponent(minted.token);
    return { payload: `claude-remote://pair?host=${host}&token=${token}`, expiresAt: minted.expiresAt };
  });

  app.get("/admin/v1/sessions", async () => deps.reads.sessions());

  app.get("/admin/v1/audit", async (request) => {
    const q = request.query as { limit?: string; cursor?: string };
    const limit = Number(q.limit ?? "50");
    const before = q.cursor === undefined ? undefined : Number(q.cursor);
    const opts: { limit: number; before?: number } = {
      limit: Number.isFinite(limit) ? limit : 50,
    };
    if (before !== undefined && Number.isFinite(before)) {
      opts.before = before;
    }
    return deps.reads.auditPage(opts);
  });

  app.get("/admin/v1/logs/tail", async (request, reply) => {
    const q = request.query as { file?: string; bytes?: string };
    const file = LOG_FILES[q.file as keyof typeof LOG_FILES];
    if (file === undefined) return sendError(reply, 400, "invalid_file", "file must be out or err");
    const requested = Number(q.bytes ?? String(LOG_TAIL_DEFAULT_BYTES));
    const n = Number.isFinite(requested) ? Math.min(Math.max(1, Math.trunc(requested)), LOG_TAIL_MAX_BYTES) : LOG_TAIL_DEFAULT_BYTES;
    const path = join(deps.config.dataDir, "logs", file);
    if (!existsSync(path)) return { content: "" };
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(n, size));
      readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return { content: buffer.toString("utf8") };
    } finally {
      closeSync(fd);
    }
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, "not_found", "unknown admin route"));

  return app;
}
