/**
 * Bridge-scoped session write locks (spec §7.3, §7.6, §7.7).
 *
 * `session_locks` enforces that at most one Bridge instance drives a given
 * Claude session. The lock only excludes other Bridge clients and Bridge
 * child processes — it cannot detect a plain terminal `claude --resume`
 * (spec §7.7).
 *
 * Take-over rules (used by resumeSession):
 * - No row: insert ours.
 * - Row owned by THIS instance: keep it (heartbeat refreshed).
 * - Row owned by ANOTHER instance with a FRESH heartbeat: conflict.
 * - Row owned by another instance with a STALE heartbeat (process died or
 *   Bridge crashed): take over.
 */
import type { SqliteDatabase } from "../db/database.js";

/** Another Bridge instance holds a fresh lock on the session. */
export class SessionLockConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly holderInstanceId: string,
  ) {
    super(
      `session ${sessionId} is locked by Bridge instance ${holderInstanceId} with a fresh heartbeat`,
    );
    this.name = "SessionLockConflictError";
  }
}

export interface SessionLockRow {
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
  readonly processLeaseSecret: string | null;
  readonly processPid: number | null;
  readonly processStartedAt: number | null;
  readonly heartbeatAt: number;
}

/** Default freshness window for lock heartbeats (§7.3 take-over). */
export const DEFAULT_STALE_HEARTBEAT_MS = 30_000;

export interface SessionLockStore {
  get(sessionId: string): SessionLockRow | undefined;
  list(): SessionLockRow[];
  /** Insert a new lock row; throws on an existing row (PRIMARY KEY). */
  insert(lock: {
    sessionId: string;
    bridgeInstanceId: string;
    processLeaseSecret: string | null;
    now: number;
  }): void;
  /** Full-row upsert (used for take-overs and pid/lease updates). */
  put(lock: SessionLockRow): void;
  updateHeartbeat(sessionId: string, now: number): void;
  delete(sessionId: string): void;
}

export function createSessionLockStore(db: SqliteDatabase): SessionLockStore {
  const getById = db.prepare("SELECT * FROM session_locks WHERE sessionId = ?");
  const listStmt = db.prepare("SELECT * FROM session_locks ORDER BY sessionId");
  const insertStmt = db.prepare(
    `INSERT INTO session_locks (sessionId, bridgeInstanceId, processLeaseSecret, processPid, processStartedAt, heartbeatAt)
     VALUES (?, ?, ?, NULL, NULL, ?)`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO session_locks (sessionId, bridgeInstanceId, processLeaseSecret, processPid, processStartedAt, heartbeatAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sessionId) DO UPDATE SET
       bridgeInstanceId = excluded.bridgeInstanceId,
       processLeaseSecret = excluded.processLeaseSecret,
       processPid = excluded.processPid,
       processStartedAt = excluded.processStartedAt,
       heartbeatAt = excluded.heartbeatAt`,
  );
  const heartbeatStmt = db.prepare("UPDATE session_locks SET heartbeatAt = ? WHERE sessionId = ?");
  const deleteStmt = db.prepare("DELETE FROM session_locks WHERE sessionId = ?");

  return {
    get(sessionId) {
      return getById.get(sessionId) as SessionLockRow | undefined;
    },
    list() {
      return listStmt.all() as SessionLockRow[];
    },
    insert(lock) {
      insertStmt.run(lock.sessionId, lock.bridgeInstanceId, lock.processLeaseSecret, lock.now);
    },
    put(lock) {
      upsertStmt.run(
        lock.sessionId,
        lock.bridgeInstanceId,
        lock.processLeaseSecret,
        lock.processPid,
        lock.processStartedAt,
        lock.heartbeatAt,
      );
    },
    updateHeartbeat(sessionId, now) {
      heartbeatStmt.run(now, sessionId);
    },
    delete(sessionId) {
      deleteStmt.run(sessionId);
    },
  };
}

/** A lock row is stale when its heartbeat is older than `staleMs`. */
export function isStaleLock(row: SessionLockRow, now: number, staleMs: number): boolean {
  return now - row.heartbeatAt > staleMs;
}
