import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { createAdminReads } from "../../src/admin/admin-reads.js";

let dir: string;
let db: SqliteDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "admin-reads-"));
  db = openDatabase(join(dir, "bridge.db"), { createDir: true });
  migrate(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function seed() {
  db.prepare(`INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
              VALUES ('p1', '/tmp/a', 1, 2, 'Alpha', 0, 0)`).run();
  db.prepare(`INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
              VALUES ('s1', 'p1', 'S1', 'running', 'bridge', 100, 0)`).run();
  db.prepare(`INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
              VALUES ('s2', 'p1', 'S2', 'inactive', 'bridge', 50, 0)`).run();
  db.prepare(`INSERT INTO session_locks (sessionId, bridgeInstanceId, processPid, heartbeatAt)
              VALUES ('s1', 'inst-1', 4242, 100)`).run();
  db.prepare(`INSERT INTO devices (deviceId, publicKeySpki, accessSubject, displayName, pairedAt)
              VALUES ('d1', 'k', 'sub', 'Phone', 0)`).run();
  db.prepare(`INSERT INTO device_sessions (tokenHash, deviceId, accessSubject, expiresAt, createdAt)
              VALUES ('t1', 'd1', 'sub', 5000, 0)`).run();
  db.prepare(`INSERT INTO device_sessions (tokenHash, deviceId, accessSubject, expiresAt, createdAt)
              VALUES ('t2', 'd1', 'sub', 9000, 0)`).run();
}

describe("admin reads", () => {
  it("activeSessionCount counts only live statuses", () => {
    seed();
    expect(createAdminReads(db, { databasePath: join(dir, "bridge.db") }).activeSessionCount()).toBe(1);
  });
  it("sessions() joins project name and lock holder", () => {
    seed();
    const rows = createAdminReads(db, { databasePath: join(dir, "bridge.db") }).sessions();
    expect(rows[0]).toMatchObject({ sessionId: "s1", status: "running", projectDisplayName: "Alpha", lockedBy: "inst-1", processPid: 4242 });
    expect(rows[1]).toMatchObject({ sessionId: "s2", lockedBy: null });
  });
  it("deviceSessionExpiryMs returns max live expiry, null when none", () => {
    seed();
    const reads = createAdminReads(db, { databasePath: join(dir, "bridge.db") });
    expect(reads.deviceSessionExpiryMs("d1", 100)).toBe(9000);
    expect(reads.deviceSessionExpiryMs("missing", 100)).toBeNull();
  });
  it("auditPage pages newest-first by auditId and reports nextCursor only when more exist", () => {
    seed();
    for (let i = 1; i <= 5; i++) {
      db.prepare(`INSERT INTO audit_events (occurredAt, operationType, resultCode) VALUES (?, 'op', 'ok')`).run(i * 100);
    }
    // auditId AUTOINCREMENT assigns 1..5
    const reads = createAdminReads(db, { databasePath: join(dir, "bridge.db") });
    const page1 = reads.auditPage({ limit: 2 });
    expect(page1.items.map((r) => r.auditId)).toEqual([5, 4]);
    expect(page1.nextCursor).toBe(4);
    const last = reads.auditPage({ before: 2, limit: 5 });
    expect(last.items.map((r) => r.auditId)).toEqual([1]);
    expect(last.nextCursor).toBeNull();
  });
  it("dbSizeBytes stats the database file", () => {
    const reads = createAdminReads(db, { databasePath: join(dir, "bridge.db") });
    expect(reads.dbSizeBytes()).toBeGreaterThan(0);
  });
});
