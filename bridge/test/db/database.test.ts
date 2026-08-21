import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabase } from "../../src/db/database.js";
import { migrate, openDatabase, transaction } from "../../src/db/database.js";
import { MIGRATION_001_SQL } from "../../src/db/migrations/001_initial.js";

let dataDir: string;
let db: SqliteDatabase;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "bridge-db-test-"));
});

afterEach(() => {
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function openAndMigrate(): SqliteDatabase {
  db = openDatabase(join(dataDir, "bridge.db"));
  migrate(db);
  return db;
}

function tableColumns(database: SqliteDatabase, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

describe("openDatabase", () => {
  it("creates the database file with mode 0600", () => {
    const path = join(dataDir, "bridge.db");
    openAndMigrate();
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("enables WAL journal mode", () => {
    openAndMigrate();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("enables foreign keys", () => {
    openAndMigrate();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("sets synchronous = NORMAL", () => {
    openAndMigrate();
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
  });

  it("sets busy_timeout = 5000", () => {
    openAndMigrate();
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });
});

describe("migrate", () => {
  it("is idempotent", () => {
    openAndMigrate();
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    const rows = db.prepare("SELECT version FROM schema_migrations").all() as {
      version: number;
    }[];
    expect(rows).toEqual([{ version: 1 }]);
  });
});

describe("transaction", () => {
  it("commits when fn succeeds", () => {
    openAndMigrate();
    transaction(db, () => {
      db.prepare(
        "INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("p1", "/tmp/p1", 1, 2, "P1", 3, 4);
    });
    expect(db.prepare("SELECT projectId FROM projects").get()).toEqual({ projectId: "p1" });
  });

  it("rolls back when fn throws", () => {
    openAndMigrate();
    expect(() =>
      transaction(db, () => {
        db.prepare(
          "INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run("p1", "/tmp/p1", 1, 2, "P1", 3, 4);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
  });
});

describe("schema", () => {
  it("enforces CHECK constraints on sessions.status", () => {
    openAndMigrate();
    expect(() =>
      db.prepare(
        "INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("s1", "p1", "S1", "bogus", "bridge", 1, 2),
    ).toThrow(/CHECK constraint/i);
  });

  it("embedded migration SQL matches 001_initial.sql", () => {
    const sqlFile = readFileSync(
      join(import.meta.dirname!, "../../src/db/migrations/001_initial.sql"),
      "utf8",
    );
    // Strip comments and normalize whitespace: the .sql file carries a
    // documentation header; the embedded string does not.
    const strip = (s: string): string =>
      s
        .replace(/--.*$/gm, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n");
    expect(strip(MIGRATION_001_SQL)).toBe(strip(sqlFile));
  });

  const expectedColumns: Record<string, string[]> = {
    projects: [
      "projectId",
      "canonicalRealpath",
      "deviceNumber",
      "inode",
      "displayName",
      "createdAt",
      "authorizedAt",
    ],
    sessions: [
      "sessionId",
      "projectId",
      "displayName",
      "status",
      "source",
      "lastClaudeVersion",
      "lastEventId",
      "lastActivityAt",
      "createdAt",
    ],
    commands: [
      "requestId",
      "deviceId",
      "sessionId",
      "idempotencyKey",
      "commandType",
      "payloadHash",
      "status",
      "resultJson",
      "createdAt",
      "updatedAt",
    ],
    pending_events: [
      "sessionId",
      "eventId",
      "eventType",
      "payloadJson",
      "protocolVersion",
      "deleteAfter",
      "createdAt",
    ],
    device_delivery: [
      "deviceId",
      "sessionId",
      "protocolVersion",
      "deliveryBase",
      "deliveryWatermark",
      "deliveryCheckpointWatermark",
      "pendingCheckpoint",
    ],
    history_snapshots: [
      "snapshotId",
      "sessionId",
      "deviceId",
      "status",
      "historyRevision",
      "adapterVersion",
      "transcriptPath",
      "readByteLimit",
      "deliveryBase",
      "deliveryWatermark",
      "sessionStatus",
      "pendingPermissionJson",
      "commitIdempotencyKey",
      "commitResultJson",
      "committedAt",
      "createdAt",
      "expiresAt",
    ],
    history_snapshot_items: [
      "snapshotId",
      "ordinal",
      "historyItemId",
      "historyRevision",
      "payloadJson",
    ],
    session_locks: [
      "sessionId",
      "bridgeInstanceId",
      "processLeaseSecret",
      "processPid",
      "processStartedAt",
      "heartbeatAt",
    ],
    devices: ["deviceId", "publicKeySpki", "accessSubject", "displayName", "pairedAt", "revokedAt"],
    device_sessions: ["tokenHash", "deviceId", "accessSubject", "expiresAt", "revokedAt", "createdAt"],
    pairing_tokens: ["tokenHash", "expiresAt", "consumedAt", "createdAt"],
    auth_challenges: [
      "challengeId",
      "deviceId",
      "accessSubject",
      "hostAscii",
      "challengeRaw",
      "expiresAt",
      "consumedAt",
      "createdAt",
    ],
    audit_events: [
      "auditId",
      "occurredAt",
      "accessSubjectHash",
      "deviceId",
      "rayId",
      "sourceIp",
      "requestId",
      "operationType",
      "sessionId",
      "projectId",
      "resultCode",
      "toolCategory",
      "permissionDecision",
      "redactedDetail",
    ],
    schema_migrations: ["version", "appliedAt"],
  };

  for (const [table, columns] of Object.entries(expectedColumns)) {
    it(`table ${table} has exactly the expected columns`, () => {
      openAndMigrate();
      expect(tableColumns(db, table)).toEqual(columns);
    });
  }
});
