/**
 * Idempotent command ledger (spec §7.4, §8.2, §8.3).
 *
 * Every command accepted by the bridge is recorded in the `commands` table.
 * Idempotency contract (§8.2):
 * - `(deviceId, idempotencyKey)` is UNIQUE. A retry with the same key and the
 *   same payload hash is a *replay*: the saved record is returned and no side
 *   effects re-run. A retry with the same key but a different payload hash is
 *   a *conflict* and is rejected.
 * - A duplicate `requestId` under a different idempotency key is always
 *   rejected.
 *
 * Status transitions follow the table in spec §7.4 (see LEGAL_TRANSITIONS).
 * All timestamps are injected by callers; the ledger never reads the clock.
 */
import { createHash } from "node:crypto";
import * as canonicalizeLib from "canonicalize";

// canonicalize ships an ESM-syntax .d.ts but resolves as CJS under NodeNext,
// so the default export must be recovered through interop.
const canonicalize = (canonicalizeLib as unknown as {
  default: (value: unknown) => string | undefined;
}).default;
import type { SqliteDatabase } from "../db/database.js";
import type { EventJournalPort, PersistedEvent } from "../events/event-journal-types.js";
import type { Command, CommandStatus, EventPayload } from "../protocol/v1/types.js";

/** RFC 8785 (JCS) canonical JSON serialization of a payload. */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) {
    throw new TypeError("payload is not canonicalizable (not JSON-safe)");
  }
  return out;
}

/** SHA-256 hex digest of the JCS canonicalization of `payload`. */
export function computePayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export interface CommandRecord {
  readonly requestId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly payloadHash: string;
  readonly status: CommandStatus;
  readonly resultJson?: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type AcceptDuplicateResult =
  | { kind: "replay"; record: CommandRecord }
  | { kind: "conflict" }
  | { kind: "inserted"; record: CommandRecord };

/** Same idempotency key, different payload hash. */
export class ConflictError extends Error {
  constructor(readonly deviceId: string, readonly idempotencyKey: string) {
    super(`idempotency conflict for (${deviceId}, ${idempotencyKey}): payload hash mismatch`);
    this.name = "ConflictError";
  }
}

/** requestId already recorded under a different idempotency key, or reused with a different key than its original acceptance. */
export class DuplicateRequestIdError extends Error {
  constructor(readonly requestId: string) {
    super(`requestId ${requestId} already recorded under a different idempotency key`);
    this.name = "DuplicateRequestIdError";
  }
}

export class IllegalTransitionError extends Error {
  constructor(readonly from: CommandStatus, readonly to: CommandStatus) {
    super(`illegal command transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** Stored value for commands that are not bound to a session (e.g. session.list). */
export const NO_SESSION = "";

/** A command.status.changed event requires a session to attach the event to. */
export class SessionlessTransitionError extends Error {
  constructor(readonly requestId: string) {
    super(`command ${requestId} has no session; status events require a session-scoped command`);
    this.name = "SessionlessTransitionError";
  }
}

/**
 * Legal transitions (spec §7.4):
 * - accepted → dispatching (async dispatch)
 * - accepted → completed/failed/interrupted (synchronous protocol ops that
 *   never dispatch to Claude, e.g. session.list)
 * - dispatching → dispatched | indeterminate
 * - dispatched → completed | failed | indeterminate | interrupted
 * - indeterminate → completed | failed | interrupted (transcript reconciliation)
 * - terminal states (completed/failed/interrupted) are irreversible
 */
const LEGAL_TRANSITIONS: Readonly<Record<CommandStatus, readonly CommandStatus[]>> = {
  accepted: ["dispatching", "completed", "failed", "interrupted"],
  dispatching: ["dispatched", "indeterminate"],
  dispatched: ["completed", "failed", "indeterminate", "interrupted"],
  indeterminate: ["completed", "failed", "interrupted"],
  interrupted: [],
  completed: [],
  failed: [],
};

export interface TransitionOptions {
  readonly now: number;
}

export interface TransitionWithStatusEventOptions {
  readonly buildEventPayload: (record: CommandRecord) => Omit<EventPayload, "eventId">;
  readonly now: number;
}

export interface CommandLedger {
  /**
   * Insert a new command. Replays (same key + same hash) return the saved
   * record without side effects; conflicts and duplicate requestIds reject.
   */
  accept(
    envelope: Command,
    deviceId: string,
    payloadHash: string,
    now: number,
  ): Promise<CommandRecord>;

  /**
   * Idempotency-aware insert used by the command endpoint to distinguish
   * replay / conflict / inserted outcomes without exceptions.
   */
  acceptDuplicate(
    envelope: Command,
    deviceId: string,
    payloadHash: string,
    now: number,
  ): Promise<AcceptDuplicateResult>;

  /** Apply a legal status transition. */
  transition(
    requestId: string,
    next: CommandStatus,
    options: TransitionOptions,
  ): Promise<CommandRecord>;

  /**
   * Apply a legal status transition and append a `command.status.changed`
   * event, sharing one transaction: commands row update, sessions.lastEventId
   * increment, and pending_events insert either all commit or all roll back.
   */
  transitionWithStatusEvent(
    requestId: string,
    next: CommandStatus,
    options: TransitionWithStatusEventOptions,
  ): Promise<{ record: CommandRecord; event: PersistedEvent }>;

  get(requestId: string): Promise<CommandRecord | undefined>;
}

interface CommandRow {
  requestId: string;
  deviceId: string;
  sessionId: string;
  idempotencyKey: string;
  commandType: string;
  payloadHash: string;
  status: CommandStatus;
  resultJson: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToRecord(row: CommandRow): CommandRecord {
  return {
    requestId: row.requestId,
    deviceId: row.deviceId,
    sessionId: row.sessionId,
    idempotencyKey: row.idempotencyKey,
    commandType: row.commandType,
    payloadHash: row.payloadHash,
    status: row.status,
    resultJson: row.resultJson === null ? undefined : (JSON.parse(row.resultJson) as unknown),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createCommandLedger(db: SqliteDatabase, journal: EventJournalPort): CommandLedger {
  const insertStmt = db.prepare(
    `INSERT INTO commands (requestId, deviceId, sessionId, idempotencyKey, commandType, payloadHash, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
  );
  const getByRequest = db.prepare("SELECT * FROM commands WHERE requestId = ?");
  const getByIdempotency = db.prepare(
    "SELECT * FROM commands WHERE deviceId = ? AND idempotencyKey = ?",
  );
  const updateStatus = db.prepare("UPDATE commands SET status = ?, updatedAt = ? WHERE requestId = ?");

  function acceptSync(
    envelope: Command,
    deviceId: string,
    payloadHash: string,
    now: number,
  ): AcceptDuplicateResult {
    const existing = getByIdempotency.get(deviceId, envelope.idempotencyKey) as CommandRow | undefined;
    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash) return { kind: "conflict" };
      if (existing.requestId !== envelope.requestId) {
        throw new DuplicateRequestIdError(envelope.requestId);
      }
      return { kind: "replay", record: rowToRecord(existing) };
    }
    if (getByRequest.get(envelope.requestId) !== undefined) {
      throw new DuplicateRequestIdError(envelope.requestId);
    }
    const sessionId = envelope.sessionId ?? NO_SESSION;
    insertStmt.run(
      envelope.requestId,
      deviceId,
      sessionId,
      envelope.idempotencyKey,
      envelope.commandType,
      payloadHash,
      now,
      now,
    );
    return { kind: "inserted", record: rowToRecord(getByRequest.get(envelope.requestId) as CommandRow) };
  }

  function loadForTransition(requestId: string): CommandRow {
    const row = getByRequest.get(requestId) as CommandRow | undefined;
    if (row === undefined) throw new Error(`unknown requestId ${requestId}`);
    return row;
  }

  function applyTransition(row: CommandRow, next: CommandStatus, now: number): CommandRecord {
    if (!LEGAL_TRANSITIONS[row.status].includes(next)) {
      throw new IllegalTransitionError(row.status, next);
    }
    updateStatus.run(next, now, row.requestId);
    return rowToRecord({ ...row, status: next, updatedAt: now });
  }

  return {
    accept(envelope, deviceId, payloadHash, now) {
      try {
        const result = acceptSync(envelope, deviceId, payloadHash, now);
        if (result.kind === "conflict") {
          return Promise.reject(new ConflictError(deviceId, envelope.idempotencyKey));
        }
        return Promise.resolve(result.record);
      } catch (error) {
        return Promise.reject(error);
      }
    },

    acceptDuplicate(envelope, deviceId, payloadHash, now) {
      try {
        return Promise.resolve(acceptSync(envelope, deviceId, payloadHash, now));
      } catch (error) {
        return Promise.reject(error);
      }
    },

    transition(requestId, next, options) {
      try {
        const row = loadForTransition(requestId);
        return Promise.resolve(applyTransition(row, next, options.now));
      } catch (error) {
        return Promise.reject(error);
      }
    },

    transitionWithStatusEvent(requestId, next, options) {
      return new Promise((resolve, reject) => {
        try {
          const outcome = db.transaction(() => {
            const row = loadForTransition(requestId);
            if (row.sessionId === NO_SESSION) {
              throw new SessionlessTransitionError(requestId);
            }
            const record = applyTransition(row, next, options.now);
            const event = journal.appendWithinTransaction({
              db,
              sessionId: record.sessionId,
              eventType: "command.status.changed",
              payload: {
                ...options.buildEventPayload(record),
                requestId: record.requestId,
                commandStatus: record.status,
              },
              now: options.now,
            });
            return { record, event };
          })();
          resolve(outcome);
        } catch (error) {
          reject(error);
        }
      });
    },

    get(requestId) {
      const row = getByRequest.get(requestId) as CommandRow | undefined;
      return Promise.resolve(row === undefined ? undefined : rowToRecord(row));
    },
  };
}
