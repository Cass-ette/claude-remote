import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, PENDING_EVENT_RETENTION_SECONDS, SIGNAL_WAIT_SECONDS, type BridgeConfig, type EnvSource } from "./config.js";
import { migrate, openDatabase, type SqliteDatabase } from "./db/database.js";
import { createEventJournal, type EventJournal } from "./events/event-journal.js";
import { createCommandLedger, type CommandLedger } from "./commands/command-ledger.js";
import { createAuditLog, type AuditLog } from "./audit/audit-log.js";
import { createProjectRegistry, type ProjectRegistry } from "./projects/project-registry.js";
import { AccessJwtVerifier } from "./auth/access-jwt-verifier.js";
import { createDeviceAuth, type DeviceAuth } from "./auth/device-auth.js";
import { createRealProcessFactory } from "./claude/process-factory.js";
import {
  createSessionSupervisor,
  type ClaudeProcessFactory,
  type SessionSupervisor,
  type TurnEvidence as SupervisorTurnEvidence,
} from "./sessions/session-supervisor.js";
import { createSessionEventPump } from "./sessions/session-event-pump.js";
import { createPermissionBroker, type PermissionBroker } from "./permissions/permission-broker.js";
import { createSnapshotService, type SnapshotService } from "./snapshots/snapshot-service.js";
import { createSessionImporter, type SessionImporter } from "./history/session-importer.js";
import { createCommandDispatcher, type CommandDispatcher } from "./commands/command-dispatcher.js";
import {
  createClaudeTranscriptAdapter,
  transcriptPathForSession,
  type ClaudeTranscriptAdapter,
  type TurnEvidence as AdapterTurnEvidence,
} from "./history/claude-2.1.133-adapter.js";
import type { PersistedEvent } from "./events/event-journal-types.js";
import { startHttpServer } from "./server/http-server.js";
import { registerApiRoutes } from "./server/http-routes.js";
import {
  registerWebSocket,
  CLOSE_CODE,
  type OutboundEvent,
  type SessionConnection,
  type WebSocketService,
} from "./server/websocket-server.js";
import { PROTOCOL_VERSION, type EventPayload, type EventType } from "./protocol/v1/types.js";
import { validateCommand } from "./protocol/v1/validator.js";
import type { FastifyInstance } from "fastify";

const DEVICE_SESSION_HEADER = "x-claude-remote-device-session";

/**
 * Revocation poll interval (spec §10.4): a revocation applied by ANOTHER
 * process (the admin CLI writes the shared database directly) is picked up
 * by this in-process poller, which closes the revoked device's live sockets
 * and denies its pending permissions. Injectable for tests through
 * {@link StartBridgeOverrides.revocationPollIntervalMs}.
 */
export const REVOCATION_POLL_INTERVAL_MS = 30_000;

/**
 * Bridge entry point (Task 24 wiring).
 *
 * SECURITY: the Bridge binds to loopback only (enforced by loadConfig).
 * It NEVER starts a Cloudflare Tunnel itself — the tunnel connector runs
 * as a separate, user-managed process per the architecture spec.
 *
 * Composition order (all failures fatal at boot):
 *   config → database → audit → journal → ledger → project registry →
 *   Access verifier (injected or from env) → device registry → permission
 *   broker (late-bound process hook) → process factory (lazy) → supervisor
 *   + event pump → snapshot service → command dispatcher → HTTP routes →
 *   WebSocket service → broker.listen → journal append listener (live
 *   delivery + permission-wait flips) → §7.6 startup recovery and
 *   transcript reconciliation.
 */
export interface BridgeHandle {
  readonly config: BridgeConfig;
  readonly app: FastifyInstance;
  readonly wsService: WebSocketService;
  readonly db: SqliteDatabase;
  readonly journal: EventJournal;
  readonly ledger: CommandLedger;
  readonly registry: ProjectRegistry;
  readonly devices: DeviceAuth;
  readonly audit: AuditLog;
  readonly supervisor: SessionSupervisor;
  readonly snapshots: SnapshotService;
  readonly broker: PermissionBroker;
  /**
   * Revoke the paired device (§10.4): pending permissions denied, the
   * device's sockets closed 4401, sessions/challenges/sessions purged.
   */
  revokeDevice(deviceId: string): void;
  /**
   * Graceful shutdown: deny pending permissions FIRST (§11.5), stop active
   * sessions (deny-first stop order → interrupted), close WS clients, the
   * HTTP server, and the append listener. The database is NOT closed here —
   * callers (main / tests) own its lifetime.
   */
  close(): Promise<void>;
}

export interface StartBridgeOverrides {
  /** Injectable Access verifier (tests supply a local-JWKS instance). */
  readonly accessVerifier?: AccessJwtVerifier;
  /** Revocation poll interval override (tests use a few ms). */
  readonly revocationPollIntervalMs?: number;
}

/** Detect the Claude Code CLI version for /capabilities; null when unknown. */
async function probeClaudeVersion(claudeBin: string, timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve(value);
    };
    const child = spawn(claudeBin, ["--version"], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => finish(null), timeoutMs);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(out.match(/\d+\.\d+\.\d+/)?.[0] ?? null));
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
  });
}

/**
 * Bundled permission MCP adapter entry (src and dist layouts both resolve).
 * src layout: src/main.ts → src/permission-adapter/main.mjs (sibling).
 * dist layout: dist/src/main.js → dist/permission-adapter/main.mjs (the
 * build copies the adapter to the dist root, not under dist/src).
 */
function defaultPermissionAdapterEntry(): string {
  const sibling = fileURLToPath(new URL("./permission-adapter/main.mjs", import.meta.url));
  if (existsSync(sibling)) return sibling;
  return fileURLToPath(new URL("../../permission-adapter/main.mjs", import.meta.url));
}

/**
 * Construct the real process factory on FIRST use: BRIDGE_CLAUDE_BIN may be
 * unset and `claude` absent from PATH (local-only boots never start a
 * session), and construction must not turn those boots fatal.
 */
function lazyProcessFactory(build: () => ClaudeProcessFactory): ClaudeProcessFactory {
  let cached: ClaudeProcessFactory | undefined;
  return {
    async start(opts) {
      cached ??= build();
      return cached.start(opts);
    },
  };
}

export async function startBridge(
  env: EnvSource,
  overrides: StartBridgeOverrides = {},
): Promise<BridgeHandle> {
  const config = loadConfig(env);
  const now = (): number => Date.now();

  const db = openDatabase(config.databasePath, { createDir: false });
  migrate(db);

  const audit = createAuditLog({ filePath: config.auditLogPath, db, now });
  const journal = createEventJournal(db, {
    retentionMs: PENDING_EVENT_RETENTION_SECONDS * 1000,
    byteBudget: config.pendingEventsByteBudget,
  });
  const ledger = createCommandLedger(db, journal);
  const registry = createProjectRegistry(db);

  const verifier =
    overrides.accessVerifier ??
    (config.cloudflareTeamDomain !== undefined && config.cloudflareAud !== undefined
      ? new AccessJwtVerifier({
          teamDomain: config.cloudflareTeamDomain,
          audience: config.cloudflareAud,
        })
      : null);

  const devices = createDeviceAuth(db, {
    deviceSessionTtlSeconds: config.deviceSessionTtlSeconds,
  });

  // In-memory session → current writer device (§9 resolve authorization).
  // Written by the dispatcher on session.create / session.resume /
  // message.send; cleared on session.release.
  const writers = new Map<string, string>();
  const noteWriter = (sessionId: string, deviceId: string): void => {
    writers.set(sessionId, deviceId);
  };
  const clearWriter = (sessionId: string): void => {
    writers.delete(sessionId);
  };

  // Late-bound fail-closed hook: the broker is constructed before the
  // supervisor exists, but process control belongs to the supervisor.
  const terminateSession = (sessionId: string, reason: string): void => {
    try {
      supervisorBridgeKill(sessionId, reason);
    } catch {
      // the broker treats delivery failure as deny; control stays fail-closed
    }
  };
  let supervisorBridgeKill: (sessionId: string, reason: string) => void = () => undefined;

  const permissionSocketPath = join(config.dataDir, "permissions.sock");
  const broker = createPermissionBroker({
    journal,
    socketPath: permissionSocketPath,
    timeoutMs: config.permissionTimeoutSeconds * 1000,
    sessionsForDevice: (deviceId) => {
      // The in-memory writers map covers sessions created by this device on
      // THIS instance — including create-only sessions, whose session.create
      // ledger row cannot carry the sessionId (it does not exist yet). The
      // commands scan adds session-scoped commands from any prior boot.
      const sessions = new Set<string>();
      for (const [sessionId, device] of writers) {
        if (device === deviceId) sessions.add(sessionId);
      }
      for (const row of db
        .prepare("SELECT DISTINCT sessionId FROM commands WHERE deviceId = ? AND sessionId != ''")
        .all(deviceId) as Array<{ sessionId: string }>) {
        sessions.add(row.sessionId);
      }
      return [...sessions];
    },
    activeDeviceForSession: (sessionId) => writers.get(sessionId),
    terminateSessionProcess: terminateSession,
  });

  const processFactory = lazyProcessFactory(() =>
    createRealProcessFactory({
      dataDir: config.dataDir,
      ...(config.claudeBin !== undefined ? { claudeBin: config.claudeBin } : {}),
      permissionAdapterEntry: config.permissionAdapterEntry ?? defaultPermissionAdapterEntry(),
      permissionSocketPath,
      claudeConfigDir: config.claudeConfigDir,
      onLeaseGenerated: (leaseSecret, sessionId) => {
        broker.registerLease(leaseSecret, sessionId);
      },
    }),
  );

  const supervisor = createSessionSupervisor(db, {
    bridgeInstanceId: randomUUID(),
    processFactory,
    resolveProjectDir: (projectId) => registry.revalidate(projectId).canonicalRealpath,
    ledger,
    journal,
    permissionBroker: broker,
    onProcessStarted: (sessionId, handle) => pump.track(sessionId, handle),
  });

  supervisorBridgeKill = (sessionId: string, reason: string): void => {
    void supervisor
      .stop({ sessionId })
      .catch(() => undefined)
      .then(() => {
        app.log.warn({ sessionId, reason }, "permission broker terminated the session process");
      });
  };

  /** Route pump appends through the per-session resync mutex (§6.7 step 1). */
  const appendEvent = (sessionId: string, eventType: string, payload: Record<string, unknown>): void => {
    void snapshots.withResyncMutex(sessionId, () => {
      journal.append({ category: "system", sessionId, eventType: eventType as EventType, payload, now: now() });
      return Promise.resolve();
    });
  };

  const pump = createSessionEventPump({
    appendEvent,
    completeMessage: supervisor.completeMessage,
    onError: (sessionId, error) => {
      app.log.warn({ sessionId, err: error }, "session event pump failed");
    },
  });

  const snapshots = createSnapshotService({
    db,
    journal,
    claudeConfigDir: config.claudeConfigDir,
    adapterFor: (projectRoot) =>
      createClaudeTranscriptAdapter({ projectRoot, claudeConfigDir: config.claudeConfigDir }),
    getPendingPermission: (sessionId) => {
      const pending = broker.pendingForSession(sessionId);
      if (pending === null) return null;
      return { payloadJson: JSON.stringify(pending.payload), expiresAt: pending.expiresAt };
    },
  });

  // §7.6 step 6: map the history adapter's evidence vocabulary onto the
  // supervisor's (complete → turn/completed|failed, interrupted →
  // turn/interrupted, absent → absent, incompatible → unparseable).
  const adapterForSession = (sessionId: string): { adapter: ClaudeTranscriptAdapter; transcriptPath: string } => {
    const row = db
      .prepare("SELECT projectId FROM sessions WHERE sessionId = ?")
      .get(sessionId) as { projectId: string } | undefined;
    if (row === undefined) throw new Error(`unknown session ${sessionId}`);
    const project = registry.get(row.projectId);
    if (project === undefined) throw new Error(`session ${sessionId} has an unknown project`);
    return {
      adapter: createClaudeTranscriptAdapter({
        projectRoot: project.canonicalRealpath,
        claudeConfigDir: config.claudeConfigDir,
      }),
      transcriptPath: transcriptPathForSession(config.claudeConfigDir, project.canonicalRealpath, sessionId),
    };
  };
  const findTurnEvidence = async (
    sessionId: string,
    uuid: string,
  ): Promise<SupervisorTurnEvidence> => {
    const { adapter, transcriptPath } = adapterForSession(sessionId);
    const evidence: AdapterTurnEvidence = await adapter.findTurnEvidence(transcriptPath, uuid);
    switch (evidence.kind) {
      case "complete":
        return { kind: "turn", outcome: evidence.outcome };
      case "interrupted":
        return { kind: "turn", outcome: "interrupted" };
      case "absent":
        return { kind: "absent" };
      case "incompatible":
        return { kind: "unparseable" };
    }
  };

  // §6.6 transcript importer: scan/import of foreign sessions for an
  // already-authorized project (same adapter as the snapshot service).
  const importer: SessionImporter = createSessionImporter(db, {
    claudeConfigDir: config.claudeConfigDir,
    registry,
    adapterFor: (projectRoot) =>
      createClaudeTranscriptAdapter({ projectRoot, claudeConfigDir: config.claudeConfigDir }),
  });

  const dispatcher = createCommandDispatcher({
    db,
    ledger,
    journal,
    supervisor,
    snapshots,
    broker,
    registry,
    audit,
    importer,
    findTurnEvidence,
    now,
    noteWriter,
    clearWriter,
  });

  const claudeCodeVersion =
    config.claudeBin !== undefined ? await probeClaudeVersion(config.claudeBin) : null;

  const app = startHttpServer(config, { claudeCodeVersion });
  registerApiRoutes(app, {
    verifier,
    devices,
    dispatcher,
    audit,
    hostAscii: config.publicHost ?? "",
    now,
  });

  // --- WebSocket: real two-layer auth, replay, and command dispatch -------

  /** PersistedEvent → OutboundEvent (the payloadJson IS the full envelope). */
  const toOutbound = (event: PersistedEvent): OutboundEvent => {
    const envelope = JSON.parse(event.payloadJson) as { payload: EventPayload; timestamp: string };
    return {
      eventId: event.eventId,
      sessionId: event.sessionId,
      eventType: event.eventType,
      timestamp: envelope.timestamp,
      payload: envelope.payload,
    };
  };

  const wsService = registerWebSocket(app, {
    authenticate: async (headers) => {
      // §10.6: every WS authentication failure is audited (auth.ws) with a
      // reason code; token/assertion values never reach the audit log.
      const auditWsDenied = (resultCode: string, fields: { deviceId?: string; accessSubject?: string } = {}): void => {
        audit.write({ operationType: "auth.ws", resultCode, ...fields });
      };
      if (verifier === null) {
        auditWsDenied("unauthorized");
        return { code: CLOSE_CODE.AUTH_INVALID, reason: "access verification is not configured" };
      }
      let identity;
      try {
        identity = await verifier.verifyRequest(headers);
      } catch {
        auditWsDenied("unauthorized");
        return { code: CLOSE_CODE.AUTH_INVALID, reason: "invalid or missing access assertion" };
      }
      const token = headers[DEVICE_SESSION_HEADER];
      const tokenString = Array.isArray(token) ? token[0] : token;
      const expiry =
        typeof tokenString === "string" && tokenString !== ""
          ? devices.getSessionExpiry(tokenString, now())
          : null;
      const validated =
        typeof tokenString === "string" && tokenString !== ""
          ? devices.validateDeviceSession(tokenString, now())
          : null;
      if (expiry === null || validated === null) {
        auditWsDenied("unauthorized", { accessSubject: identity.subject });
        return { code: CLOSE_CODE.AUTH_INVALID, reason: "invalid or missing device session" };
      }
      if (validated.accessSubject !== identity.subject) {
        auditWsDenied("subject_mismatch", { deviceId: validated.deviceId, accessSubject: identity.subject });
        return { code: CLOSE_CODE.FORBIDDEN, reason: "access subject does not match the device session" };
      }
      const accessExpMs = Date.parse(identity.expiresAt);
      return {
        deviceId: validated.deviceId,
        accessSubject: identity.subject,
        expiresAtMs: Number.isFinite(accessExpMs) ? Math.min(accessExpMs, expiry) : expiry,
      };
    },

    onConnect: (connection) => {
      if (connection.deviceId === null) return; // stub mode (legacy tests)
      // Replay undelivered events above the device's watermark. An event
      // whose persisted protocolVersion is incompatible closes the socket
      // 4410 (§8.1): the client must resync through snapshot begin/commit.
      const rows = db
        .prepare("SELECT sessionId, deliveryWatermark FROM device_delivery WHERE deviceId = ?")
        .all(connection.deviceId) as Array<{ sessionId: string; deliveryWatermark: number }>;
      for (const row of rows) {
        for (const event of journal.replayAfter(row.sessionId, BigInt(row.deliveryWatermark))) {
          if (event.protocolVersion !== PROTOCOL_VERSION) {
            connection.close(CLOSE_CODE.RESYNC_REQUIRED, "event protocol version is incompatible; resynchronize");
            return;
          }
          try {
            connection.send(toOutbound(event));
          } catch {
            return; // socket closed mid-replay; the close event unregisters
          }
        }
      }
    },

    onCommand: (connection, raw) => {
      void (async () => {
        const validated = validateCommand(raw);
        if (!validated.ok) {
          connection.socket.send(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              requestId: "",
              responseType: "command.error",
              error: { code: "INVALID_COMMAND", message: validated.error, retryable: false },
            }),
          );
          return;
        }
        const outcome = await dispatcher.dispatch(validated.value, connection.deviceId ?? "");
        connection.socket.send(JSON.stringify(outcome.response));
      })().catch((error: unknown) => {
        app.log.error({ err: error }, "websocket command dispatch failed");
      });
    },
  });

  await broker.listen();

  // Live delivery: every journaled event fans out to connected devices
  // (client-side eventId dedup absorbs replays), and permission events flip
  // the session's guarded status (running ⇄ waiting_permission).
  journal.setAppendListener((event) => {
    if (event.protocolVersion !== PROTOCOL_VERSION) return;
    const outbound = toOutbound(event);
    for (const connection of wsService.connections()) {
      if (connection.deviceId === null) continue;
      try {
        connection.send(outbound);
      } catch {
        // socket already closing; the close event unregisters it
      }
    }
    if (event.eventType === "permission.requested") {
      supervisor.markPermissionWait(event.sessionId);
    } else if (event.eventType === "permission.resolved") {
      supervisor.markPermissionResume(event.sessionId);
    }
  });

  await app.listen({ host: config.host, port: config.port });

  // §7.6 startup: expire foreign locks, interrupt active sessions, sweep
  // stale prepared snapshots, reconcile indeterminate commands per
  // transcript evidence, and run the pending-event retention sweep.
  await supervisor.recoverOnStartup();
  snapshots.expireStale(now());
  await supervisor.reconcileIndeterminateCommands({ findTurnEvidence });
  journal.sweep(now());

  app.log.info({ host: config.host, port: config.port }, "bridge listening");

  const revokeDevice = (deviceId: string): void => {
    devices.revokeDevice(deviceId, now(), {
      denyPendingPermissions: (target) => {
        void broker.denyAllForDevice(target, "device revoked").catch(() => undefined);
      },
      closeSockets: (target) => {
        wsService.closeDevice(target, CLOSE_CODE.AUTH_INVALID, "device revoked");
      },
    });
    handledRevocations.add(deviceId);
    audit.write({
      operationType: "device.revoke",
      deviceId,
      resultCode: "ok",
      detail: { source: "runtime" },
      committed: true,
    });
  };

  // --- Revocation poller (§10.4) ------------------------------------------
  // The admin CLI revokes against the shared database from a SEPARATE
  // process; its no-op hooks cannot reach this Bridge's live sockets. The
  // poller notices `devices.revokedAt` rows within one interval and applies
  // the §10.4 side effects here: close the device's sockets (4401) and deny
  // its pending permissions. Handled devices are tracked in memory only —
  // re-handling after a restart is a harmless no-op (a revoked device cannot
  // authenticate, so no sockets or pending permissions can exist).
  const handledRevocations = new Set<string>();
  for (const row of db
    .prepare("SELECT deviceId FROM devices WHERE revokedAt IS NOT NULL")
    .all() as Array<{ deviceId: string }>) {
    handledRevocations.add(row.deviceId);
  }
  const applyRevocation = (deviceId: string): void => {
    handledRevocations.add(deviceId);
    wsService.closeDevice(deviceId, CLOSE_CODE.AUTH_INVALID, "device revoked");
    void broker.denyAllForDevice(deviceId, "device revoked").catch(() => undefined);
  };
  const revocationPollMs = overrides.revocationPollIntervalMs ?? REVOCATION_POLL_INTERVAL_MS;
  const revocationTimer = setInterval(() => {
    try {
      const rows = db
        .prepare("SELECT deviceId FROM devices WHERE revokedAt IS NOT NULL")
        .all() as Array<{ deviceId: string }>;
      for (const { deviceId } of rows) {
        if (!handledRevocations.has(deviceId)) applyRevocation(deviceId);
      }
    } catch (error) {
      app.log.warn({ err: error }, "revocation poll failed");
    }
  }, revocationPollMs);
  revocationTimer.unref?.();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(revocationTimer);
    journal.setAppendListener(undefined);
    // §11.5 order: pending permissions denied FIRST (adapters get their
    // decision frames), then active sessions stopped (deny-first signal
    // order → interrupted), then the transport layers.
    try {
      await broker.close();
    } catch (error) {
      app.log.warn({ err: error }, "permission broker close failed");
    }
    try {
      await supervisor.shutdownAll();
    } catch (error) {
      app.log.warn({ err: error }, "session supervisor shutdown failed");
    }
    // No §8.1 code means "clean server shutdown"; 4500 (internal error)
    // is the least-wrong documented code — the socket close is immediate
    // and the client is expected to reconnect and resync.
    wsService.closeAll(CLOSE_CODE.INTERNAL_ERROR, "bridge shutdown");
    try {
      await app.close();
    } catch (error) {
      app.log.warn({ err: error }, "http server close failed");
    }
    // The database is deliberately NOT closed: callers own its lifetime
    // (main() closes it; tests keep it open to assert post-close state).
  };

  return {
    config,
    app,
    wsService,
    db,
    journal,
    ledger,
    registry,
    devices,
    audit,
    supervisor,
    snapshots,
    broker,
    revokeDevice,
    close,
  };
}

async function main(): Promise<void> {
  const bridge = await startBridge(process.env);

  const shutdown = (signal: string) => {
    bridge.app.log.info({ signal }, "shutting down");
    void bridge
      .close()
      .catch((err: unknown) => {
        bridge.app.log.error({ err }, "error during close");
      })
      .finally(() => {
        setTimeout(() => process.exit(0), 0).unref();
      });
    // Force-exit if graceful close exceeds SIGNAL_WAIT_SECONDS.
    setTimeout(() => process.exit(0), SIGNAL_WAIT_SECONDS * 1000).unref();
  };

  // process.once (not .on): a second signal falls through to the default
  // hard-exit, which is the intended escape hatch during a hung graceful close.
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error("bridge failed to start:", err);
    process.exit(1);
  });
}
