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
import { ProjectIdentityError } from "../projects/project-registry.js";
import type { SessionSupervisor, TurnEvidence } from "../sessions/session-supervisor.js";
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
import { BackwardAckError, StoragePressureError } from "../events/event-journal.js";
import { CheckpointCommitRequiredError } from "../snapshots/snapshot-errors.js";
import type { SessionImporter } from "../history/session-importer.js";
import {
  InvalidSessionIdError,
  SessionProjectMismatchError,
  TranscriptUnimportableError,
} from "../history/session-importer.js";
import { TranscriptNotFoundError } from "../history/claude-2.1.133-adapter.js";
import type { Command, ProtocolResponse, ResponseError } from "../protocol/v1/types.js";
import { parseEventId } from "../protocol/v1/validator.js";
import { PROTOCOL_VERSION } from "../protocol/v1/types.js";

/** Snapshot page size: server-side constant (the client pages via cursors). */
export const SNAPSHOT_PAGE_SIZE = 10;

/** Typed error code for §11.6 storage-pressure rejections (HTTP 503). */
export const STORAGE_PRESSURE_CODE = "STORAGE_PRESSURE";

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

/**
 * Parse a stored canonical payloadJson (migration 002). Returns undefined for
 * pre-migration rows (empty string) or unparsable content — callers treat
 * that as "payload not retained".
 */
function parseStoredPayload(payloadJson: string): Record<string, unknown> | undefined {
  if (payloadJson === "") return undefined;
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
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
  /** Transcript-session importer (§6.6), wired by the runtime. */
  readonly importer: SessionImporter;
  /**
   * Transcript evidence lookup (§7.4) — the same resolver the supervisor's
   * startup reconciliation uses; retry_indeterminate consults it to classify
   * an indeterminate command before re-dispatching.
   */
  readonly findTurnEvidence: (sessionId: string, uuid: string) => Promise<TurnEvidence>;
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
        // Already classified (or never indeterminate): read-only no-op that
        // reports the current status — retrying a terminal command must not
        // re-run side effects (§8.2 idempotency spirit).
        if (target.status !== "indeterminate") {
          return { requestId: target.requestId, status: target.status };
        }
        // §7.4: consult transcript evidence FIRST. If the original turn is
        // now classifiable, adopt the outcome and never re-send anything.
        let evidence: TurnEvidence;
        try {
          evidence = await deps.findTurnEvidence(target.sessionId, target.requestId);
        } catch (error) {
          // No transcript at all (never written / deleted): the turn cannot
          // have reached Claude — treat like absent evidence.
          if (error instanceof TranscriptNotFoundError) {
            evidence = { kind: "absent" };
          } else {
            throw error;
          }
        }
        if (evidence.kind === "turn") {
          await deps.ledger.transitionWithStatusEvent(target.requestId, evidence.outcome, {
            now: now(),
            buildEventPayload: (rec) => ({
              requestId: rec.requestId,
              idempotencyKey: rec.idempotencyKey,
              commandType: rec.commandType,
              result: { reconciledFrom: "transcript" },
            }),
          });
          return { requestId: target.requestId, status: evidence.outcome };
        }
        // Evidence absent / unparseable: re-dispatch with the ORIGINAL UUID
        // and ORIGINAL payload (§7.4) — a fresh UUID would create a
        // DIFFERENT user record in the transcript. Same-UUID re-sends are
        // safe: the Phase 0 gate proved duplicate UUIDs do not duplicate
        // transcript entries across resume.
        const original = parseStoredPayload(target.payloadJson);
        if (target.commandType !== "message.send" || original === undefined || typeof original.text !== "string") {
          throw new DispatchError(409, {
            code: "RETRY_NOT_DISPATCHABLE",
            message: "the original command's payload was not retained and cannot be re-dispatched",
            retryable: false,
          });
        }
        await runSend(target.requestId, target.sessionId, original.text, deviceId);
        return { requestId: target.requestId, status: "dispatched" };
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
      case "session.scan_imports": {
        // §6.6: revalidate the project identity, then read-only scan of
        // THAT project's transcript directory. The importer revalidates
        // internally (step 1) — this call IS the scan.
        const scan = await deps.importer.scanImports(payload.projectId as string);
        return { candidates: [...scan.candidates], skipped: scan.skipped };
      }
      case "session.import": {
        const binding = await deps.importer.importSession({
          projectId: payload.projectId as string,
          sessionId: payload.sessionId as string,
          now: now(),
        });
        return binding;
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

  /**
   * Async dispatch core (§7.4, §8.3): ? → dispatching → dispatched around the
   * supervisor's stdin write. Shared by message.send (from accepted) and
   * command.retry_indeterminate (from indeterminate — the ledger's legal
   * transitions admit indeterminate → dispatching for exactly that flow).
   */
  async function runSend(requestId: string, sessionId: string, text: string, deviceId: string): Promise<void> {
    deps.noteWriter(sessionId, deviceId);
    await deps.ledger.transitionWithStatusEvent(requestId, "dispatching", {
      now: now(),
      buildEventPayload: (rec) => ({
        requestId: rec.requestId,
        idempotencyKey: rec.idempotencyKey,
        commandType: rec.commandType,
      }),
    });
    try {
      await deps.supervisor.sendMessage({ sessionId, requestId, text });
    } catch (error) {
      // dispatching → dispatched failed: the turn may or may not have
      // reached Claude; per §7.4 the ONLY legal follow-up from dispatching
      // besides dispatched is indeterminate.
      await deps.ledger.transitionWithStatusEvent(requestId, "indeterminate", {
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
    await deps.ledger.transitionWithStatusEvent(requestId, "dispatched", {
      now: now(),
      buildEventPayload: (rec) => ({
        requestId: rec.requestId,
        idempotencyKey: rec.idempotencyKey,
        commandType: rec.commandType,
      }),
    });
  }

  /** Async dispatch path for message.send (§7.4, §8.3). */
  async function runMessageSend(envelope: Command, deviceId: string): Promise<DispatchOutcome> {
    const payload = envelope.payload as Record<string, unknown>;
    await runSend(envelope.requestId, payload.sessionId as string, payload.text as string, deviceId);
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
    // §11.6 storage pressure: the journal rejects new user messages while
    // pending events occupy the byte budget — retryable once the consumer
    // ACKs and the sweep frees bytes.
    if (error instanceof StoragePressureError) {
      return new DispatchError(503, {
        code: STORAGE_PRESSURE_CODE,
        message: "pending events are at the storage budget; the journal rejects new user messages until the consumer acknowledges delivery",
        retryable: true,
      });
    }
    // §6.6/§10.5: project identity no longer matches the authorized record
    // (moved/replaced dir, or unknown projectId).
    if (error instanceof ProjectIdentityError) {
      return new DispatchError(409, { code: "PROJECT_IDENTITY", message: error.message, retryable: false });
    }
    if (error instanceof InvalidSessionIdError) {
      return new DispatchError(400, { code: "INVALID_SESSION_ID", message: error.message, retryable: false });
    }
    if (error instanceof TranscriptUnimportableError) {
      return new DispatchError(400, { code: "TRANSCRIPT_UNIMPORTABLE", message: error.message, retryable: false });
    }
    if (error instanceof SessionProjectMismatchError) {
      return new DispatchError(409, { code: "SESSION_PROJECT_MISMATCH", message: error.message, retryable: false });
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
    // Project-scoped commands (scan_imports / import / create) carry the
    // projectId in the payload; §10.6 audit records it when present.
    const payload = envelope.payload as Record<string, unknown>;
    const auditProjectId =
      typeof payload.projectId === "string" ? { projectId: payload.projectId as string } : {};
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
        ...auditProjectId,
        resultCode: "ok",
        detail: { commandStatus: "completed" },
        committed: true,
      });
      return ok(envelope.requestId, result);
    } catch (error) {
      const mapped = mapSupervisorError(error);
      try {
        // Sync commands (still accepted) end failed. A message.send whose
        // dispatch already moved the row — indeterminate per §7.4, where it
        // must STAY so command.retry_indeterminate can target it — keeps
        // its status; the row is never silently reclassified.
        const current = await deps.ledger.get(envelope.requestId);
        if (current === undefined || current.status === "accepted") {
          await deps.ledger.transition(envelope.requestId, "failed", { now: now() });
        }
      } catch {
        // already terminal — ledger row stays as-is
      }
      deps.audit.write({
        operationType: envelope.commandType,
        deviceId,
        requestId: envelope.requestId,
        ...(record.sessionId === "" ? {} : { sessionId: record.sessionId }),
        ...auditProjectId,
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
