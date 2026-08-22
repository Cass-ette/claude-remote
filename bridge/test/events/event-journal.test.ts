import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import {
  BackwardAckError,
  StoragePressureError,
  createEventJournal,
  truncateLargeToolOutput,
  type EventJournal,
} from "../../src/events/event-journal.js";

const T0 = 1_700_000_000_000;
const RETENTION_MS = 600_000; // PENDING_EVENT_RETENTION_SECONDS * 1000
const BYTE_LIMIT = 65_536;

let dir: string;
let dbPath: string;
let db: SqliteDatabase;
let journal: EventJournal;

function openJournal(overrides: Partial<{ byteBudget: number }> = {}): EventJournal {
  return createEventJournal(db, {
    retentionMs: RETENTION_MS,
    byteBudget: overrides.byteBudget ?? 64 * 1024 * 1024,
  });
}

function appendUser(j: EventJournal, sessionId = "sess-1", payload: Record<string, unknown> = { n: 1 }) {
  return j.append({
    category: "user_command",
    sessionId,
    eventType: "assistant.message.delta",
    payload,
    now: T0,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "event-journal-"));
  dbPath = join(dir, "test.db");
  db = openDatabase(dbPath);
  migrate(db);
  db.prepare(
    `INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
     VALUES ('proj-1', '/tmp/proj-1', 1, 2, 'proj', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
     VALUES ('sess-1', 'proj-1', 's', 'idle', 'bridge', 0, 0)`,
  ).run();
  journal = openJournal();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("append", () => {
  it("increments sessions.lastEventId and inserts a pending_events row in one transaction", () => {
    const event = appendUser(journal);
    expect(event.eventId).toBe(1n);
    expect(
      db.prepare("SELECT lastEventId FROM sessions WHERE sessionId = 'sess-1'").get(),
    ).toMatchObject({ lastEventId: 1 });
    expect(
      db.prepare("SELECT sessionId, eventId, eventType, deleteAfter FROM pending_events").all(),
    ).toEqual([{ sessionId: "sess-1", eventId: 1, eventType: "assistant.message.delta", deleteAfter: null }]);
  });

  it("encodes eventId as a decimal string in the persisted payload", () => {
    appendUser(journal);
    const event = appendUser(journal);
    const row = db.prepare("SELECT payloadJson FROM pending_events WHERE eventId = 2").get() as {
      payloadJson: string;
    };
    const parsed = JSON.parse(row.payloadJson);
    expect(parsed.eventId).toBe("2");
    expect(typeof parsed.eventId).toBe("string");
    expect(parsed.eventId).toBe(event.eventId.toString());
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.eventType).toBe("assistant.message.delta");
  });

  it("keeps IDs strictly increasing after all events are deleted", () => {
    const a = appendUser(journal);
    const b = appendUser(journal);
    db.prepare("DELETE FROM pending_events").run();
    const c = appendUser(journal);
    expect(c.eventId).toBeGreaterThan(b.eventId);
    expect(b.eventId).toBeGreaterThan(a.eventId);
    expect(c.eventId).toBe(3n);
  });
});

describe("replayAfter", () => {
  it("yields events in order excluding nothing in the unacknowledged window", () => {
    appendUser(journal, "sess-1", { n: 1 });
    appendUser(journal, "sess-1", { n: 2 });
    appendUser(journal, "sess-1", { n: 3 });
    const replayed = journal.replayAfter("sess-1", 1n);
    expect(replayed.map((e) => e.eventId)).toEqual([2n, 3n]);
    expect(replayed.map((e) => JSON.parse(e.payloadJson).payload)).toEqual([{ n: 2 }, { n: 3 }]);
  });

  it("is scoped per session", () => {
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES ('sess-2', 'proj-1', 's2', 'idle', 'bridge', 0, 0)`,
    ).run();
    appendUser(journal, "sess-1", { n: 1 });
    appendUser(journal, "sess-2", { n: 2 });
    expect(journal.replayAfter("sess-2", 0n).map((e) => e.eventId)).toEqual([1n]);
  });
});

describe("acknowledge", () => {
  it("schedules retention-delayed deletion up to and including eventId and advances the watermark", () => {
    appendUser(journal, "sess-1", { n: 1 });
    appendUser(journal, "sess-1", { n: 2 });
    appendUser(journal, "sess-1", { n: 3 });
    journal.acknowledge("sess-1", "device-1", 2n, T0 + 100);
    const rows = db
      .prepare("SELECT eventId, deleteAfter FROM pending_events WHERE sessionId = 'sess-1' ORDER BY eventId")
      .all() as Array<{ eventId: number; deleteAfter: number | null }>;
    expect(rows).toEqual([
      { eventId: 1, deleteAfter: T0 + 100 + RETENTION_MS },
      { eventId: 2, deleteAfter: T0 + 100 + RETENTION_MS },
      { eventId: 3, deleteAfter: null },
    ]);
    expect(
      db
        .prepare("SELECT deliveryWatermark, deliveryBase FROM device_delivery WHERE deviceId = 'device-1' AND sessionId = 'sess-1'")
        .get(),
    ).toMatchObject({ deliveryWatermark: 2, deliveryBase: 0 });
  });

  it("rejects backward ACKs", () => {
    appendUser(journal);
    appendUser(journal);
    journal.acknowledge("sess-1", "device-1", 2n, T0);
    expect(() => journal.acknowledge("sess-1", "device-1", 1n, T0 + 1)).toThrow(BackwardAckError);
  });

  it("does not delete immediately even after the retention window starts", () => {
    appendUser(journal);
    journal.acknowledge("sess-1", "device-1", 1n, T0);
    // No sweep has run past deleteAfter; the row must still exist.
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_events").get()).toMatchObject({ n: 1 });
  });
});

describe("markCheckpointSuperseded", () => {
  it("schedules retention-delayed deletion for eventId <= watermark", () => {
    appendUser(journal, "sess-1", { n: 1 });
    appendUser(journal, "sess-1", { n: 2 });
    appendUser(journal, "sess-1", { n: 3 });
    journal.markCheckpointSuperseded("sess-1", "device-1", 2n, T0 + 50);
    const rows = db
      .prepare("SELECT eventId, deleteAfter FROM pending_events ORDER BY eventId")
      .all() as Array<{ eventId: number; deleteAfter: number | null }>;
    expect(rows).toEqual([
      { eventId: 1, deleteAfter: T0 + 50 + RETENTION_MS },
      { eventId: 2, deleteAfter: T0 + 50 + RETENTION_MS },
      { eventId: 3, deleteAfter: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_events").get()).toMatchObject({ n: 3 });
  });
});

describe("storage pressure", () => {
  it("throws STORAGE_PRESSURE for user_command appends beyond the byte budget without modifying the journal", () => {
    const tight = openJournal({ byteBudget: 32 });
    const bigPayload = { blob: "x".repeat(64) };
    expect(() => tight.append({
      category: "user_command",
      sessionId: "sess-1",
      eventType: "assistant.message.delta",
      payload: bigPayload,
      now: T0,
    })).toThrow(StoragePressureError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_events").get()).toMatchObject({ n: 0 });
    expect(
      db.prepare("SELECT lastEventId FROM sessions WHERE sessionId = 'sess-1'").get(),
    ).toMatchObject({ lastEventId: 0 });
  });

  it("counts bytes, not characters, for CJK payloads (char-count of 100 would pass a 250 budget)", () => {
    const cjk = { text: "汉".repeat(100) }; // 100 chars = 300 UTF-8 bytes in the string alone
    const tight = openJournal({ byteBudget: 250 });
    expect(() =>
      tight.append({
        category: "user_command",
        sessionId: "sess-1",
        eventType: "assistant.message.delta",
        payload: cjk,
        now: T0,
      }),
    ).toThrow(StoragePressureError); // JSON payload > 250 bytes; a char count (100) would have passed
  });

  it("sweeps elapsed rows before the budget check so freed space allows appends", () => {
    const first = appendUser(journal, "sess-1", { blob: "x".repeat(300) });
    const firstBytes = Buffer.byteLength(
      (db.prepare("SELECT payloadJson FROM pending_events WHERE eventId = ?").get(first.eventId) as {
        payloadJson: string;
      }).payloadJson,
      "utf8",
    );
    // ACK event 1 with a deleteAfter already in the past (acknowledged long ago).
    journal.acknowledge("sess-1", "device-1", 1n, T0 - RETENTION_MS - 1);
    // Budget fits the new payload only if event 1 is swept first.
    const tight = openJournal({ byteBudget: firstBytes - 1 });
    expect(() =>
      tight.append({
        category: "user_command",
        sessionId: "sess-1",
        eventType: "assistant.message.delta",
        payload: { n: 2 },
        now: T0,
      }),
    ).not.toThrow();
    expect(db.prepare("SELECT eventId FROM pending_events ORDER BY eventId").all()).toEqual([
      { eventId: 2 },
    ]);
  });

  it("system-category appends bypass the byte-budget check", () => {
    const tight = openJournal({ byteBudget: 32 });
    for (const eventType of ["session.state.changed", "command.status.changed", "session.failed", "session.interrupted"] as const) {
      expect(() =>
        tight.append({
          category: "system",
          sessionId: "sess-1",
          eventType,
          payload: { blob: "x".repeat(64) },
          now: T0,
        }),
      ).not.toThrow();
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_events").get()).toMatchObject({ n: 4 });
  });
});

describe("truncateLargeToolOutput", () => {
  it("replaces oversized tool.output.delta payloads with a truncation marker", () => {
    const payload = { delta: "x".repeat(BYTE_LIMIT) };
    const { payload: out, truncated } = truncateLargeToolOutput(payload, BYTE_LIMIT);
    expect(truncated).toBe(true);
    expect(out).toEqual({ truncated: true, originalByteCount: Buffer.byteLength(JSON.stringify(payload), "utf8"), truncatedAt: "65KiB" });
  });

  it("uses an exact byte marker for non-default limits", () => {
    const payload = { delta: "x".repeat(2048) };
    const { payload: out } = truncateLargeToolOutput(payload, 1024);
    expect(out).toMatchObject({ truncated: true, truncatedAt: "1024B" });
  });

  it("passes non-tool-output and small payloads through unchanged", () => {
    const small = { delta: "hi" };
    expect(truncateLargeToolOutput(small, BYTE_LIMIT)).toEqual({ payload: small, truncated: false });
    const other = { foo: "x".repeat(BYTE_LIMIT * 2) };
    expect(truncateLargeToolOutput(other, BYTE_LIMIT, "assistant.message.delta")).toEqual({
      payload: other,
      truncated: false,
    });
  });
});

describe("sweep and restart replay", () => {
  it("sweep deletes rows whose deleteAfter has elapsed, and append triggers a sweep", () => {
    appendUser(journal, "sess-1", { n: 1 });
    appendUser(journal, "sess-1", { n: 2 });
    journal.acknowledge("sess-1", "device-1", 1n, T0);
    // Append at a time past deleteAfter: the sweep-on-append removes event 1.
    journal.append({
      category: "user_command",
      sessionId: "sess-1",
      eventType: "assistant.message.delta",
      payload: { n: 3 },
      now: T0 + RETENTION_MS + 1,
    });
    const remaining = db
      .prepare("SELECT eventId FROM pending_events ORDER BY eventId")
      .all() as Array<{ eventId: number }>;
    expect(remaining).toEqual([{ eventId: 2 }, { eventId: 3 }]);

    journal.acknowledge("sess-1", "device-1", 3n, T0 + RETENTION_MS + 1);
    journal.sweep(T0 + 2 * RETENTION_MS + 2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_events").get()).toMatchObject({ n: 0 });
  });

  it("a bridge restart replays unacknowledged events and drops elapsed ones in the start sweep", () => {
    appendUser(journal, "sess-1", { n: 1 });
    appendUser(journal, "sess-1", { n: 2 });
    appendUser(journal, "sess-1", { n: 3 });
    journal.acknowledge("sess-1", "device-1", 2n, T0);

    // Simulate restart: close and reopen the database on the same path.
    db.close();
    db = openDatabase(dbPath);
    const restarted = createEventJournal(db, { retentionMs: RETENTION_MS, byteBudget: 64 * 1024 * 1024 });

    // Before the start sweep, everything is still on disk.
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_events").get()).toMatchObject({ n: 3 });
    // Start sweep at a time past event 1/2's deleteAfter but before event 3 acks.
    restarted.sweep(T0 + RETENTION_MS + 1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_events").get()).toMatchObject({ n: 1 });
    // Replay after restart yields the still-pending events.
    const replayed = restarted.replayAfter("sess-1", 0n);
    expect(replayed.map((e) => e.eventId)).toEqual([3n]);
  });
});

describe("appendWithinTransaction (EventJournalPort)", () => {
  it("composes atomically with other writes on the caller-owned transaction", () => {
    const event = db.transaction(() =>
      journal.appendWithinTransaction({
        db,
        sessionId: "sess-1",
        eventType: "command.status.changed",
        payload: { requestId: "r1", commandStatus: "accepted" },
        now: T0,
      }),
    )();
    expect(event.eventId).toBe(1n);
    expect(
      db.prepare("SELECT lastEventId FROM sessions WHERE sessionId = 'sess-1'").get(),
    ).toMatchObject({ lastEventId: 1 });
  });

  it("rolls back eventId allocation and insert with the surrounding transaction", () => {
    expect(() =>
      db.transaction(() => {
        journal.appendWithinTransaction({
          db,
          sessionId: "sess-1",
          eventType: "command.status.changed",
          payload: { a: 1 },
          now: T0,
        });
        throw new Error("caller rollback");
      })(),
    ).toThrow("caller rollback");
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_events").get()).toMatchObject({ n: 0 });
    expect(
      db.prepare("SELECT lastEventId FROM sessions WHERE sessionId = 'sess-1'").get(),
    ).toMatchObject({ lastEventId: 0 });
  });
});

describe("pendingBytes", () => {
  it("sums payloadJson byte sizes", () => {
    expect(journal.pendingBytes()).toBe(0);
    appendUser(journal);
    const expected = Buffer.byteLength(
      (db.prepare("SELECT payloadJson FROM pending_events").get() as { payloadJson: string }).payloadJson,
      "utf8",
    );
    expect(journal.pendingBytes()).toBe(expected);
  });
});
