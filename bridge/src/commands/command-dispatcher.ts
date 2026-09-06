/**
 * Command dispatcher (Task 24, spec §7.4, §8.3, §9).
 *
 * Shared by the HTTP command route and the WebSocket command channel. Given
 * a validated command envelope plus the authenticated deviceId, it:
 *
 *   1. hashes the payload (RFC 8785 canonical JSON) and runs idempotent
 *      acceptance (replay returns the saved status; conflicts reject 409);
 *   2. executes the command against the supervisor / snapshot service /
 *      permission broker / project registry;
 *   3. completes sync commands via a plain ledger transition (no
 *      command.status.changed events — §8.3 reserves those for dispatch
 *      transitions) plus a stored result for idempotent replay;
 *   4. dispatches the async command (message.send) through
 *      accepted → dispatching → dispatched (each WITH a status event) and
 *      returns the dispatch outcome in the command.status response;
 *   5. audits every command with operationType === commandType.
 *
 * Errors surface as typed command.error responses carrying the right HTTP
 * status; an accepted command that fails is moved to failed (ledger only)
 * so restarts do not reclassify it.
 */
import type { SqliteDatabase } from "../db/database.js";
import type { CommandLedger } from "./command-ledger.js";
import { canonicalJson } from "./command-ledger.js";
import { createHash } from "node:crypto";
import type { AuditLog } from "../audit/audit-log.js";
import type { PermissionBroker } from "../permissions/permission-broker.js";
import type { ProjectRegistry } from "../projects/project-registry.js";
import type { SessionSupervisor } from "../sessions/session-supervisor.js";
import {
  UnknownSessionError as SupervisorUnknownSessionError,
  InvalidSessionStateError,
  CancelNotAllowedError,
} from "../sessions/session-supervisor.js";
import {
  UnknownSessionError as SnapshotUnknownSessionError,
  InvalidPageSizeError,
} from "../snapshots/snapshot-service.js";
import type { SnapshotService } from "../snapshots/snapshot-service.js";
import { SnapshotProtocolError } from "../snapshots/snapshot-errors.js";
import type { EventJournal } from "../events/event-journal.js";
import { BackwardAckError } from "../events/event-journal.js";
import { CheckpointCommitRequiredError } from "../snapshots/snapshot-errors.js";
import type { Command, ProtocolResponse, ResponseError } from "../protocol/v1/types.js";
import { parseEventId } from "../protocol/v1/validator.js";
import { PROTOCOL_VERSION } from "../protocol/v1/types.js";

/** Snapshot page size: server-side constant (the client pages via cursors). */
export const SNAPSHOT_PAGE_SIZE = 10;

export interface DispatchOutcome {
  readonly httpStatus: number;
  readonly response: ProtocolResponse;
}

/** Thrown by run* implementations; mapped to a typed command.error. */
export class DispatchError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly error: ResponseError,
  ) {
    super(error.message);
    this.name = "DispatchError";
  }
}

export interface CommandDispatcherDeps {
  readonly db: SqliteDatabase;
  readonly ledger: CommandLedger;
  readonly journal: EventJournal;
  readonly supervisor: SessionSupervisor;
  readonly snapshots: SnapshotService;
  readonly broker: PermissionBroker;
  readonly registry: ProjectRegistry;
  readonly audit: AuditLog;
  readonly now: () => number;
  /** Marks the session's current writer device (permission resolve authz). */
  readonly noteWriter: (sessionId: string, deviceId: string) => void;
  readonly clearWriter: (sessionId: string) => void;
}

export function createCommandDispatcher(deps: CommandDispatcherDeps) {
  const now = deps.now;

  function ok(requestId: string, result: unknown): DispatchOutcome {
    return {
      httpStatus: 200,
      response: {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        responseType: "command.status",
        commandStatus: "completed",
        result,
      },
    };
  }

  function failure(httpStatus: number, code: string, message: string, retryable = false): DispatchOutcome {
    return {
      httpStatus,
      response: {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "",
        responseType: "command.error",
        error: { code, message, retryable },
      },
    };
  }

  function getSessionOrThrow(sessionId: string): { sessionId: string; status: string; displayName: string; projectId: string; lastActivityAt: number } {
    const row = deps.db
      .prepare("SELECT sessionId, status, displayName, projectId, lastActivityAt FROM sessions WHERE sessionId = ?")
      .get(sessionId) as
      | { sessionId: string; status: string; displayName: string; projectId: string; lastActivityAt: number }
      | undefined;
    if (row === undefined) {
      throw new DispatchError(404, { code: "SESSION_NOT_FOUND", message: "unknown session", retryable: false });
    }
    return row;
  }

  async function run(envelope: Command, deviceId: string): Promise<unknown> {
    const payload = envelope.payload as Record<string, unknown>;
    switch (envelope.commandType) {
      case "session.list": {
        const rows = deps.db
          .prepare(
            `SELECT s.sessionId, s.displayName, s.status, s.lastActivityAt, p.displayName AS projectDisplayName
             FROM sessions s JOIN projects p ON p.projectId = s.projectId
             ORDER BY s.lastActivityAt DESC`,
          )
          .all() as Array<Record<string, unknown>>;
        return { sessions: rows };
      }
      case "session.create": {
        const projectId = payload.projectId as string;
        const project = deps.registry.get(projectId);
        if (project === undefined) {
          throw new DispatchError(404, { code: "PROJECT_NOT_FOUND", message: "unknown projectId", retryable: false });
        }
        const displayName = payload.displayName as string | undefined;
        const { sessionId } = await deps.supervisor.createSession(
          displayName === undefined ? { projectId } : { projectId, displayName },
        );
        deps.noteWriter(sessionId, deviceId);
        return { sessionId, status: deps.supervisor.sessionStatus(sessionId) };
      }
      case "session.resume": {
        const sessionId = payload.sessionId as string;
        await deps.supervisor.resumeSession({ sessionId });
        deps.noteWriter(sessionId, deviceId);
        return { sessionId, status: deps.supervisor.sessionStatus(sessionId) };
      }
      case "session.stop": {
        const sessionId = payload.sessionId as string;
        await deps.supervisor.stop({ sessionId });
        return { sessionId, status: deps.supervisor.sessionStatus(sessionId) };
      }
      case "session.release": {
        const sessionId = payload.sessionId as string;
        await deps.supervisor.release({ sessionId });
        deps.clearWriter(sessionId);
        return { sessionId, status: deps.supervisor.sessionStatus(sessionId) };
      }
      case "session.state.get": {
        const row = getSessionOrThrow(payload.sessionId as string);
        return { sessionId: row.sessionId, status: row.status, displayName: row.displayName };
      }
      case "session.snapshot.begin": {
        const sessionId = payload.sessionId as string;
        const result = await deps.snapshots.begin({
          sessionId,
          deviceId,
          pageSize: SNAPSHOT_PAGE_SIZE,
          now: now(),
        });
        return {
          snapshotId: result.snapshotId,
          historyRevision: result.historyRevision,
          items: [...result.items],
          nextCursor: result.nextCursor,
          deliveryBase: result.deliveryBase.toString(),
          deliveryWatermark: result.deliveryWatermark.toString(),
          sessionStatus: result.sessionStatus,
          commands: [...result.commands],
          pendingPermission: result.pendingPermission,
          expiresAt: result.expiresAt,
        };
      }
      case "session.snapshot.page": {
        const result = await deps.snapshots.page({ cursor: payload.cursor as string, now: now() });
        return { items: [...result.items], nextCursor: result.nextCursor };
      }
      case "session.snapshot.commit": {
        const result = await deps.snapshots.commit({
          snapshotId: payload.snapshotId as string,
          historyRevision: payload.historyRevision as string,
          deliveryWatermark: Number(parseEventId(payload.deliveryWatermark as string)),
          idempotencyKey: payload.idempotencyKey as string,
          deviceId,
          now: now(),
        });
        return {
          status: result.status,
          snapshotId: result.snapshotId,
          historyRevision: result.historyRevision,
          deliveryWatermark: result.deliveryWatermark.toString(),
          deliveryBase: result.deliveryBase.toString(),
          committedAt: result.committedAt,
        };
      }
      case "command.cancel": {
        await deps.supervisor.cancel({ requestId: payload.requestId as string });
        return { cancelled: true };
      }
      case "command.retry_indeterminate": {
        const target = await deps.ledger.get(payload.requestId as string);
        if (target === undefined) {
          throw new DispatchError(404, { code: "COMMAND_NOT_FOUND", message: "unknown requestId", retryable: false });
        }
        if (target.status === "indeterminate") {
          // §7.4: the client re-sends the command with a fresh requestId;
          // retry_indeterminate only closes the old row as failed.
          await deps.ledger.transitionWithStatusEvent(target.requestId, "failed", {
            now: now(),
            buildEventPayload: (rec) => ({
              requestId: rec.requestId,
              idempotencyKey: rec.idempotencyKey,
              commandType: rec.commandType,
              error: { code: "RETRYED", message: "closed by retry_indeterminate" },
            }),
          });
        }
        return { requestId: target.requestId, status: "failed" };
      }
      case "permission.resolve": {
        const decision = payload.decision as "allow" | "deny";
        await deps.broker.resolve({
          permissionRequestId: payload.permissionRequestId as string,
          sessionId: payload.sessionId as string,
          deviceId,
          decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny" },
        });
        return { resolved: true, permissionRequestId: payload.permissionRequestId as string };
      }
      case "events.ack": {
        const sessionId = payload.sessionId as string;
        const lastEventId = parseEventId(payload.lastEventId as string);
        deps.journal.acknowledge(sessionId, deviceId, lastEventId, now());
        return { acknowledged: true, lastEventId: lastEventId.toString() };
      }
      case "session.scan_imports":
      case "session.import": {
        // Transcript import of foreign sessions is not part of Chunk 3.
        throw new DispatchError(400, {
          code: "COMMAND_NOT_SUPPORTED",
          message: `${envelope.commandType} is not supported by this Bridge version`,
          retryable: false,
        });
      }
      case "message.send": {
        throw new Error("message.send is handled asynchronously; unreachable in run()");
      }
      default: {
        throw new DispatchError(400, {
          code: "UNKNOWN_COMMAND",
          message: `unsupported commandType ${envelope.commandType}`,
          retryable: false,
        });
      }
    }
  }

  /** Async dispatch path for message.send (§7.4, §8.3). */
  async function runMessageSend(envelope: Command, deviceId: string): Promise<DispatchOutcome> {
    const payload = envelope.payload as Record<string, unknown>;
    const sessionId = payload.sessionId as string;
    const text = payload.text as string;

    deps.noteWriter(sessionId, deviceId);
    await deps.ledger.transitionWithStatusEvent(envelope.requestId, "dispatching", {
      now: now(),
      buildEventPayload: (rec) => ({
        requestId: rec.requestId,
        idempotencyKey: rec.idempotencyKey,
        commandType: rec.commandType,
      }),
    });
    try {
      await deps.supervisor.sendMessage({ sessionId, requestId: envelope.requestId, text });
    } catch (error) {
      // dispatching → dispatched failed: the turn may or may not have
      // reached Claude; per §7.4 the ONLY legal follow-up from dispatching
      // besides dispatched is indeterminate.
      await deps.ledger.transitionWithStatusEvent(envelope.requestId, "indeterminate", {
        now: now(),
        buildEventPayload: (rec) => ({
          requestId: rec.requestId,
          idempotencyKey: rec.idempotencyKey,
          commandType: rec.commandType,
          error: { code: "DISPATCH_INDETERMINATE", message: (error as Error).message, retryable: true },
        }),
      });
      throw mapSupervisorError(error);
    }
    await deps.ledger.transitionWithStatusEvent(envelope.requestId, "dispatched", {
      now: now(),
      buildEventPayload: (rec) => ({
        requestId: rec.requestId,
        idempotencyKey: rec.idempotencyKey,
        commandType: rec.commandType,
      }),
    });
    return {
      httpStatus: 200,
      response: {
        protocolVersion: PROTOCOL_VERSION,
        requestId: envelope.requestId,
        responseType: "command.status",
        commandStatus: "dispatched",
      },
    };
  }

  function mapSupervisorError(error: unknown): DispatchError {
    if (error instanceof DispatchError) return error;
    if (error instanceof SupervisorUnknownSessionError || error instanceof SnapshotUnknownSessionError) {
      return new DispatchError(404, { code: "SESSION_NOT_FOUND", message: error.message, retryable: false });
    }
    if (error instanceof InvalidSessionStateError || error instanceof CancelNotAllowedError) {
      return new DispatchError(409, { code: "SESSION_CONFLICT", message: error.message, retryable: false });
    }
    if (error instanceof SnapshotProtocolError) {
      return new DispatchError(error.httpStatus, { code: error.code, message: error.message, retryable: error.httpStatus === 410 });
    }
    if (error instanceof InvalidPageSizeError) {
      return new DispatchError(400, { code: "INVALID_PAGE_SIZE", message: error.message, retryable: false });
    }
    if (error instanceof BackwardAckError) {
      return new DispatchError(409, { code: "BACKWARD_ACK", message: error.message, retryable: false });
    }
    if (error instanceof CheckpointCommitRequiredError) {
      return new DispatchError(409, { code: "CHECKPOINT_COMMIT_REQUIRED", message: error.message, retryable: false });
    }
    const name = (error as Error).name;
    if (name === "UnknownPermissionRequestError" || name === "PermissionSessionMismatchError") {
      return new DispatchError(404, { code: "PERMISSION_NOT_FOUND", message: (error as Error).message, retryable: false });
    }
    if (name === "PermissionDeviceMismatchError") {
      return new DispatchError(403, { code: "PERMISSION_DEVICE_MISMATCH", message: (error as Error).message, retryable: false });
    }
    if (name === "InvalidDecisionError") {
      return new DispatchError(400, { code: "INVALID_DECISION", message: (error as Error).message, retryable: false });
    }
    if (name === "TranscriptNotFoundError") {
      return new DispatchError(404, { code: "TRANSCRIPT_NOT_FOUND", message: (error as Error).message, retryable: false });
    }
    if (name === "IllegalTransitionError") {
      return new DispatchError(409, { code: "ILLEGAL_TRANSITION", message: (error as Error).message, retryable: false });
    }
    return new DispatchError(500, {
      code: "INTERNAL",
      message: "internal dispatch error",
      retryable: true,
    });
  }

  async function dispatch(envelope: Command, deviceId: string): Promise<DispatchOutcome> {
    const payloadHash = createHash("sha256").update(canonicalJson(envelope.payload), "utf8").digest("hex");
    let accepted;
    try {
      accepted = await deps.ledger.acceptDuplicate(envelope, deviceId, payloadHash, now());
    } catch (error) {
      const outcome = failure(409, "DUPLICATE_REQUEST_ID", (error as Error).message);
      return { ...outcome, response: { ...outcome.response, requestId: envelope.requestId } };
    }

    if (accepted.kind === "conflict") {
      return {
        httpStatus: 409,
        response: {
          protocolVersion: PROTOCOL_VERSION,
          requestId: envelope.requestId,
          responseType: "command.error",
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: `idempotencyKey ${envelope.idempotencyKey} was used with a different payload`,
            retryable: false,
          },
        },
      };
    }

    if (accepted.kind === "replay") {
      const record = accepted.record;
      return {
        httpStatus: 200,
        response: {
          protocolVersion: PROTOCOL_VERSION,
          requestId: envelope.requestId,
          responseType: "command.status",
          commandStatus: record.status,
          ...(record.resultJson !== undefined ? { result: record.resultJson } : {}),
        },
      };
    }

    const record = accepted.record;
    try {
      if (envelope.commandType === "message.send") {
        const outcome = await runMessageSend(envelope, deviceId);
        deps.audit.write({
          operationType: envelope.commandType,
          deviceId,
          requestId: envelope.requestId,
          ...(record.sessionId === "" ? {} : { sessionId: record.sessionId }),
          resultCode: "ok",
          detail: { commandStatus: "dispatched" },
          committed: true,
        });
        return outcome;
      }
      const result = await run(envelope, deviceId);
      await deps.ledger.transition(envelope.requestId, "completed", { now: now() });
      deps.ledger.setResult(envelope.requestId, result, now());
      deps.audit.write({
        operationType: envelope.commandType,
        deviceId,
        requestId: envelope.requestId,
        ...(record.sessionId === "" ? {} : { sessionId: record.sessionId }),
        resultCode: "ok",
        detail: { commandStatus: "completed" },
        committed: true,
      });
      return ok(envelope.requestId, result);
    } catch (error) {
      const mapped = mapSupervisorError(error);
      try {
        await deps.ledger.transition(envelope.requestId, "failed", { now: now() });
      } catch {
        // already terminal (e.g. message.send went indeterminate) — ledger
        // row stays as-is
      }
      deps.audit.write({
        operationType: envelope.commandType,
        deviceId,
        requestId: envelope.requestId,
        ...(record.sessionId === "" ? {} : { sessionId: record.sessionId }),
        resultCode: mapped.error.code,
        committed: true,
      });
      return {
        httpStatus: mapped.httpStatus,
        response: {
          protocolVersion: PROTOCOL_VERSION,
          requestId: envelope.requestId,
          responseType: "command.error",
          error: mapped.error,
        },
      };
    }
  }

  return { dispatch };
}

export type CommandDispatcher = ReturnType<typeof createCommandDispatcher>;
