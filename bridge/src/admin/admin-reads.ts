import { statSync } from "node:fs";
import type { SqliteDatabase } from "../db/database.js";

export interface AuditEventRow {
  readonly auditId: number;
  readonly occurredAt: number;
  readonly operationType: string;
  readonly resultCode: string;
  readonly deviceId: string | null;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly redactedDetail: string | null;
}

export interface SessionListRow {
  readonly sessionId: string;
  readonly displayName: string;
  readonly status: string;
  readonly projectDisplayName: string;
  readonly lockedBy: string | null;
  readonly processPid: number | null;
  readonly lastActivityAt: number;
  readonly createdAt: number;
}

export interface AdminReads {
  auditPage(input: { before?: number; limit: number }): { items: AuditEventRow[]; nextCursor: number | null };
  sessions(): SessionListRow[];
  activeSessionCount(): number;
  deviceSessionExpiryMs(deviceId: string, nowMs: number): number | null;
  dbSizeBytes(): number;
}

export function createAdminReads(db: SqliteDatabase, options: { databasePath: string }): AdminReads {
  const auditStmt = db.prepare(
    `SELECT auditId, occurredAt, operationType, resultCode, deviceId, sessionId, projectId, redactedDetail
     FROM audit_events WHERE (? IS NULL OR auditId < ?) ORDER BY auditId DESC LIMIT ?`,
  );
  const sessionsStmt = db.prepare(
    `SELECT s.sessionId, s.displayName, s.status, p.displayName AS projectDisplayName,
            l.bridgeInstanceId AS lockedBy, l.processPid AS processPid,
            s.lastActivityAt, s.createdAt
     FROM sessions s
     JOIN projects p ON p.projectId = s.projectId
     LEFT JOIN session_locks l ON l.sessionId = s.sessionId
     ORDER BY s.lastActivityAt DESC LIMIT 50`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status IN ('starting','idle','running','waiting_permission','interrupting','releasing')`);
  const expiryStmt = db.prepare(
    `SELECT MAX(expiresAt) AS e FROM device_sessions WHERE deviceId = ? AND revokedAt IS NULL AND expiresAt > ?`,
  );

  return {
    auditPage({ before, limit }) {
      const capped = Math.min(Math.max(1, limit), 200);
      const rows = auditStmt.all(before ?? null, before ?? null, capped + 1) as AuditEventRow[];
      const hasMore = rows.length > capped;
      const items = hasMore ? rows.slice(0, capped) : rows;
      const last = items[items.length - 1];
      return { items, nextCursor: hasMore && last !== undefined ? last.auditId : null };
    },
    sessions() {
      return sessionsStmt.all() as SessionListRow[];
    },
    activeSessionCount() {
      return (countStmt.get() as { n: number }).n;
    },
    deviceSessionExpiryMs(deviceId, nowMs) {
      const row = expiryStmt.get(deviceId, nowMs) as { e: number | null } | undefined;
      return row?.e ?? null;
    },
    dbSizeBytes() {
      try {
        return statSync(options.databasePath).size;
      } catch {
        return 0;
      }
    },
  };
}
