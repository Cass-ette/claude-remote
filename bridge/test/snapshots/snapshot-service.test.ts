/**
 * Two-phase snapshot service tests (Task 19, spec §6.7).
 *
 * Covers the full checkpoint protocol: begin (mutex + capture + first
 * page), the ACK 409 guard while prepared, paging from materialized items
 * with cursor expiry, atomic commit with delivery advancement and
 * superseded-event scheduling, idempotent duplicate commits, field
 * conflicts, expiry sweeps, and event-ID buffering behind the resync
 * mutex. Uses a real temp SQLite database and the production history
 * adapter against real-vocabulary fixture transcripts.
 */
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { createEventJournal, type EventJournal } from "../../src/events/event-journal.js";
import {
  createClaudeTranscriptAdapter,
  type ClaudeTranscriptAdapter,
  type HistoryItem,
} from "../../src/history/claude-2.1.133-adapter.js";
import { CheckpointCommitRequiredError } from "../../src/snapshots/snapshot-errors.js";
import { createSnapshotService, type SnapshotService } from "../../src/snapshots/snapshot-service.js";
import { createProjectRegistry } from "../../src/projects/project-registry.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = (name: string) => join(here, "..", "history", "fixtures", name);

const SESSION = "12345678-1234-4123-8123-123456789abc";
const DEVICE = "device-1";
const DEVICE_2 = "device-2";
const T0 = 1_700_000_000_000;
const TTL_MS = 600_000; // spec §6.7: fixed 10-minute expiry
const RETENTION_MS = 600_000;

let dir: string;
let db: SqliteDatabase;
let journal: EventJournal;
let adapter: ClaudeTranscriptAdapter;
let configDir: string;
let transcriptPath: string;
let pendingPermission: { payloadJson: string; expiresAt: number } | null = null;
let service: SnapshotService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "snapshot-service-"));
  db = openDatabase(join(dir, "test.db"));
  migrate(db);

  configDir = join(dir, ".claude");
  const projectDir = join(dir, "proj");
  mkdirSync(projectDir);
  const canonical = realpathSync(projectDir);
  const transcriptDir = join(configDir, "projects", canonical.replaceAll("/", "-"));
  mkdirSync(transcriptDir, { recursive: true });
  transcriptPath = join(transcriptDir, `${SESSION}.jsonl`);
  copyFileSync(FIXTURE("complete.jsonl"), transcriptPath);

  const registry = createProjectRegistry(db);
  const projectId = registry.authorize(projectDir, "proj", { now: T0 }).projectId;
  db.prepare(
    `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
     VALUES (?, ?, 's', 'idle', 'bridge', ?, ?)`,
  ).run(SESSION, projectId, T0, T0);

  journal = createEventJournal(db, { retentionMs: RETENTION_MS, byteBudget: 64 * 1024 * 1024 });
  adapter = createClaudeTranscriptAdapter({ projectRoot: canonical, claudeConfigDir: configDir });
  pendingPermission = null;

  service = createSnapshotService({
    db,
    journal,
    claudeConfigDir: configDir,
    adapterFor: () => adapter,
    getPendingPermission: (sessionId) =>
      pendingPermission === null || sessionId !== SESSION ? null : pendingPermission,
    snapshotTtlMs: TTL_MS,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendEvents(count: number, from = 1): void {
  for (let i = 0; i < count; i++) {
    journal.append({
      category: "system",
      sessionId: SESSION,
      eventType: "session.state.changed",
      payload: { n: from + i },
      now: T0,
    });
  }
}

function addCommand(requestId: string, status: string): void {
  db.prepare(
    `INSERT INTO commands (requestId, deviceId, sessionId, idempotencyKey, commandType, payloadHash, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 'message.send', 'hash', ?, ?, ?)`,
  ).run(requestId, DEVICE, SESSION, `idem-${requestId}`, status, T0, T0);
}

async function prepare(args?: {
  events?: number;
  ackTo?: number;
  pageSize?: number;
  now?: number;
}) {
  const events = args?.events ?? 5;
  appendEvents(events);
  const ackTo = args?.ackTo ?? 3;
  if (ackTo >= 0) journal.acknowledge(SESSION, DEVICE, BigInt(ackTo), T0);
  return service.begin({
    sessionId: SESSION,
    deviceId: DEVICE,
    pageSize: args?.pageSize ?? 2,
    now: args?.now ?? T0,
  });
}

function snapshotRow(snapshotId: string): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM history_snapshots WHERE snapshotId = ?")
    .get(snapshotId) as Record<string, unknown>;
}

function deliveryRow(deviceId = DEVICE): Record<string, number | string> {
  return db
    .prepare("SELECT * FROM device_delivery WHERE deviceId = ? AND sessionId = ?")
    .get(deviceId, SESSION) as Record<string, number | string>;
}

function itemRows(snapshotId: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM history_snapshot_items WHERE snapshotId = ? ORDER BY ordinal")
    .all(snapshotId) as Array<Record<string, unknown>>;
}

function pendingRows(): Array<{ eventId: number; deleteAfter: number | null }> {
  return db
    .prepare("SELECT eventId, deleteAfter FROM pending_events WHERE sessionId = ? ORDER BY eventId")
    .all(SESSION) as Array<{ eventId: number; deleteAfter: number | null }>;
}

/** eventId → deleteAfter map, for "unchanged" comparisons. */
function deleteAfterMap(): Map<number, number | null> {
  return new Map(pendingRows().map((r) => [r.eventId, r.deleteAfter]));
}

async function expectedFixtureItems(): Promise<readonly HistoryItem[]> {
  const read = await adapter.readSnapshot(transcriptPath, Number.MAX_SAFE_INTEGER);
  return read.items;
}

// ---------------------------------------------------------------------------
// 1. begin
// ---------------------------------------------------------------------------

describe("§6.7 begin", () => {
  it("captures deliveryBase/watermark, session state, non-terminal commands, pending permission, and returns the first page", async () => {
    addCommand("req-1", "dispatched"); // non-terminal
    addCommand("req-2", "completed"); // terminal — excluded
    addCommand("req-3", "accepted"); // non-terminal
    pendingPermission = { payloadJson: '{"permissionId":"p1"}', expiresAt: T0 + 30_000 };

    appendEvents(5);
    journal.acknowledge(SESSION, DEVICE, 3n, T0);
    // The ACK itself schedules deleteAfter for events <= 3 (redelivery
    // grace, §8.5); begin must not alter any of these.
    const deleteAfterAtBegin = deleteAfterMap();
    const begin = await service.begin({ sessionId: SESSION, deviceId: DEVICE, pageSize: 2, now: T0 });

    expect(begin.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(begin.historyRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(begin.deliveryBase).toBe(3);
    expect(begin.deliveryWatermark).toBe(5);
    expect(begin.sessionStatus).toBe("idle");
    expect(begin.commands).toEqual([
      { requestId: "req-1", commandType: "message.send", status: "dispatched" },
      { requestId: "req-3", commandType: "message.send", status: "accepted" },
    ]);
    expect(begin.pendingPermission).toEqual({ payloadJson: '{"permissionId":"p1"}', remainingMs: 30_000 });
    expect(begin.expiresAt).toBe(T0 + TTL_MS);
    expect(begin.items).toHaveLength(2);
    expect(begin.nextCursor).toBeTypeOf("string");

    const row = snapshotRow(begin.snapshotId);
    expect(row.status).toBe("prepared");
    expect(row.adapterVersion).toBe(adapter.adapterVersion);
    expect(row.transcriptPath).toBe(transcriptPath);
    expect(row.readByteLimit).toBe(
      (await adapter.readMetadata(transcriptPath, Number.MAX_SAFE_INTEGER)).totalBytes,
    );
    expect(row.historyRevision).toBe(begin.historyRevision);
    expect(row.deliveryBase).toBe(3);
    expect(row.deliveryWatermark).toBe(5);
    expect(row.sessionStatus).toBe("idle");
    expect(row.pendingPermissionJson).toBe('{"permissionId":"p1"}');
    expect(row.commitIdempotencyKey).toBeNull();
    expect(row.commitResultJson).toBeNull();
    expect(row.committedAt).toBeNull();
    expect(row.createdAt).toBe(T0);
    expect(row.expiresAt).toBe(T0 + TTL_MS);
    expect(row.deviceId).toBe(DEVICE);

    // Items are materialized immutably from the complete records.
    const expected = await expectedFixtureItems();
    const items = itemRows(begin.snapshotId);
    expect(items).toHaveLength(expected.length);
    expect(items.map((i) => i.historyItemId)).toEqual(expected.map((i) => i.historyItemId));
    for (const [i, item] of items.entries()) {
      expect(item.ordinal).toBe(i);
      expect(item.historyRevision).toBe(begin.historyRevision);
      expect(JSON.parse(item.payloadJson as string)).toMatchObject({
        historyItemId: expected[i]!.historyItemId,
      });
    }

    // §6.7 (5): begin does NOT advance delivery, mark, or delete events.
    const delivery = deliveryRow();
    expect(delivery.deliveryWatermark).toBe(3);
    expect(delivery.pendingCheckpoint).toBe(1);
    expect(delivery.deliveryBase).toBe(3); // ACK ceiling while prepared
    expect(deleteAfterMap()).toEqual(deleteAfterAtBegin);
  });

  it("upserts the device_delivery row (base 0) when the device never ACKed", async () => {
    const begin = await prepare({ ackTo: -1 });
    expect(begin.deliveryBase).toBe(0);
    const delivery = deliveryRow();
    expect(delivery.deliveryWatermark).toBe(0);
    expect(delivery.pendingCheckpoint).toBe(1);
  });

  it("rejects an unknown session", async () => {
    await expect(
      service.begin({ sessionId: "00000000-0000-4000-8000-000000000000", deviceId: DEVICE, pageSize: 2, now: T0 }),
    ).rejects.toMatchObject({ name: "UnknownSessionError" });
  });

  it("rejects a non-positive pageSize", async () => {
    await expect(
      service.begin({ sessionId: SESSION, deviceId: DEVICE, pageSize: 0, now: T0 }),
    ).rejects.toMatchObject({ name: "InvalidPageSizeError" });
  });
});

// ---------------------------------------------------------------------------
// 2. ACK guard while prepared
// ---------------------------------------------------------------------------

describe("§6.7 (5): events.ack past deliveryBase during a prepared snapshot", () => {
  it("returns 409 CHECKPOINT_COMMIT_REQUIRED; acks at or below the base still land", async () => {
    await prepare();
    expect(() => journal.acknowledge(SESSION, DEVICE, 4n, T0)).toThrow(CheckpointCommitRequiredError);
    try {
      journal.acknowledge(SESSION, DEVICE, 4n, T0);
    } catch (error) {
      expect((error as { code: string }).code).toBe("CHECKPOINT_COMMIT_REQUIRED");
      expect((error as { httpStatus: number }).httpStatus).toBe(409);
    }
    // Delivery did not move on the rejected ACK.
    expect(deliveryRow().deliveryWatermark).toBe(3);
    // At-or-below-base ACKs are unaffected (== base allowed).
    expect(() => journal.acknowledge(SESSION, DEVICE, 3n, T0)).not.toThrow();

    // Another device's ACKs are not blocked by this device's checkpoint.
    appendEvents(1, 6);
    expect(() => journal.acknowledge(SESSION, DEVICE_2, 6n, T0)).not.toThrow();

    // After commit the guard is gone.
    const row = db
      .prepare("SELECT snapshotId, historyRevision, deliveryWatermark FROM history_snapshots WHERE status = 'prepared'")
      .get() as { snapshotId: string; historyRevision: string; deliveryWatermark: number };
    await service.commit({
      snapshotId: row.snapshotId,
      historyRevision: row.historyRevision,
      deliveryWatermark: row.deliveryWatermark,
      idempotencyKey: "key-1",
      deviceId: DEVICE,
      now: T0 + 1000,
    });
    expect(() => journal.acknowledge(SESSION, DEVICE, 6n, T0)).not.toThrow();
    expect(deliveryRow().deliveryWatermark).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 3. page
// ---------------------------------------------------------------------------

describe("§6.7 page", () => {
  it("returns subsequent pages from materialized items only, in ordinal order", async () => {
    const expected = await expectedFixtureItems();
    const begin = await prepare({ pageSize: 2 });
    const collected: HistoryItem[] = [...begin.items];
    let cursor = begin.nextCursor;
    let guard = 0;
    while (cursor !== null) {
      const page = await service.page({ cursor, now: T0 + 1000 });
      collected.push(...page.items);
      cursor = page.nextCursor;
      if (++guard > 20) throw new Error("pagination did not terminate");
    }
    expect(collected).toEqual(expected as HistoryItem[]);
  });

  it("returns an empty tail page with a null cursor when pageSize divides evenly", async () => {
    const expected = await expectedFixtureItems();
    const begin = await prepare({ pageSize: expected.length });
    expect(begin.items).toHaveLength(expected.length);
    expect(begin.nextCursor).toBeNull();
  });

  it("returns 410 SNAPSHOT_EXPIRED for an unknown cursor", async () => {
    await prepare();
    await expect(service.page({ cursor: "bogus-cursor", now: T0 })).rejects.toMatchObject({
      code: "SNAPSHOT_EXPIRED",
      httpStatus: 410,
    });
  });

  it("returns 410 for an expired cursor without changing delivery", async () => {
    const begin = await prepare();
    const deleteAfterAtBegin = deleteAfterMap();
    await service.expireStale(T0 + TTL_MS + 1);
    await expect(service.page({ cursor: begin.nextCursor!, now: T0 + TTL_MS + 1 })).rejects.toMatchObject(
      { code: "SNAPSHOT_EXPIRED" },
    );
    expect(snapshotRow(begin.snapshotId).status).toBe("expired");
    expect(deliveryRow().deliveryWatermark).toBe(3);
    expect(deleteAfterMap()).toEqual(deleteAfterAtBegin); // no deletions scheduled
  });
});

// ---------------------------------------------------------------------------
// 4-7. commit
// ---------------------------------------------------------------------------

describe("§6.7 commit", () => {
  async function beginPrepared() {
    const begin = await prepare();
    appendEvents(1, 6); // buffered live event, eventId 6 > watermark 5
    return begin;
  }

  it("atomically validates and advances delivery, schedules superseded-event deletion", async () => {
    const begin = await beginPrepared();
    const result = await service.commit({
      snapshotId: begin.snapshotId,
      historyRevision: begin.historyRevision,
      deliveryWatermark: begin.deliveryWatermark,
      idempotencyKey: "key-1",
      deviceId: DEVICE,
      now: T0 + 1000,
    });

    expect(result).toMatchObject({
      status: "committed",
      snapshotId: begin.snapshotId,
      historyRevision: begin.historyRevision,
      deliveryWatermark: 5,
      deliveryBase: 3,
      committedAt: T0 + 1000,
    });

    const row = snapshotRow(begin.snapshotId);
    expect(row.status).toBe("committed");
    expect(row.commitIdempotencyKey).toBe("key-1");
    expect(JSON.parse(row.commitResultJson as string)).toEqual(result);
    expect(row.committedAt).toBe(T0 + 1000);

    const delivery = deliveryRow();
    expect(delivery.deliveryWatermark).toBe(5);
    expect(delivery.deliveryCheckpointWatermark).toBe(5);
    expect(delivery.pendingCheckpoint).toBe(0);

    // Events <= watermark are scheduled for superseded deletion (retention
    // delay honored); the buffered event 6 is untouched. Nothing is deleted
    // yet. Events 1-3 keep the EARLIER deleteAfter scheduled by the ACK
    // (T0+RETENTION — the journal only fills null deleteAfter); events 4-5
    // get the commit-time schedule.
    const rows = pendingRows();
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.eventId === 1)!.deleteAfter).toBe(T0 + RETENTION_MS); // from the ACK
    expect(rows.find((r) => r.eventId === 4)!.deleteAfter).toBe(T0 + 1000 + RETENTION_MS); // from the commit
    expect(rows.find((r) => r.eventId === 5)!.deleteAfter).toBe(T0 + 1000 + RETENTION_MS);
    expect(rows.find((r) => r.eventId === 6)!.deleteAfter).toBeNull(); // buffered, not superseded
  });

  it("duplicate commit with the same idempotencyKey replays the persisted result with no state change", async () => {
    const begin = await beginPrepared();
    const first = await service.commit({
      snapshotId: begin.snapshotId,
      historyRevision: begin.historyRevision,
      deliveryWatermark: begin.deliveryWatermark,
      idempotencyKey: "key-1",
      deviceId: DEVICE,
      now: T0 + 1000,
    });
    const duplicate = await service.commit({
      snapshotId: begin.snapshotId,
      historyRevision: begin.historyRevision,
      deliveryWatermark: begin.deliveryWatermark,
      idempotencyKey: "key-1",
      deviceId: DEVICE,
      now: T0 + 999_999, // much later wall clock
    });
    expect(duplicate).toEqual(first); // committedAt stays T0+1000
    expect(snapshotRow(begin.snapshotId).committedAt).toBe(T0 + 1000);
    // Delivery cannot jump to the replayed watermark semantics: unchanged.
    expect(deliveryRow().deliveryWatermark).toBe(5);
  });

  it("same idempotencyKey with different fields returns 409 CHECKPOINT_CONFLICT and changes nothing", async () => {
    const begin = await beginPrepared();
    await service.commit({
      snapshotId: begin.snapshotId,
      historyRevision: begin.historyRevision,
      deliveryWatermark: begin.deliveryWatermark,
      idempotencyKey: "key-1",
      deviceId: DEVICE,
      now: T0 + 1000,
    });
    const before = snapshotRow(begin.snapshotId);
    await expect(
      service.commit({
        snapshotId: begin.snapshotId,
        historyRevision: begin.historyRevision,
        deliveryWatermark: 4, // wrong watermark
        idempotencyKey: "key-1",
        deviceId: DEVICE,
        now: T0 + 2000,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_CONFLICT", httpStatus: 409 });
    await expect(
      service.commit({
        snapshotId: begin.snapshotId,
        historyRevision: "0".repeat(64), // wrong revision
        deliveryWatermark: begin.deliveryWatermark,
        idempotencyKey: "key-1",
        deviceId: DEVICE,
        now: T0 + 2000,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_CONFLICT" });
    // No state change.
    expect(snapshotRow(begin.snapshotId)).toEqual(before);
    expect(deliveryRow().deliveryWatermark).toBe(5);
  });

  it("a mismatched commit against a prepared snapshot is a conflict and leaves it prepared", async () => {
    const begin = await prepare();
    await expect(
      service.commit({
        snapshotId: begin.snapshotId,
        historyRevision: begin.historyRevision,
        deliveryWatermark: begin.deliveryWatermark - 1,
        idempotencyKey: "key-x",
        deviceId: DEVICE,
        now: T0 + 100,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_CONFLICT" });
    const row = snapshotRow(begin.snapshotId);
    expect(row.status).toBe("prepared");
    expect(row.commitIdempotencyKey).toBeNull();
    expect(deliveryRow().deliveryWatermark).toBe(3);
    expect(deliveryRow().pendingCheckpoint).toBe(1);
  });

  it("rejects a commit from the wrong device with 403 and no state change", async () => {
    const begin = await prepare();
    await expect(
      service.commit({
        snapshotId: begin.snapshotId,
        historyRevision: begin.historyRevision,
        deliveryWatermark: begin.deliveryWatermark,
        idempotencyKey: "key-1",
        deviceId: DEVICE_2,
        now: T0 + 100,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_FORBIDDEN", httpStatus: 403 });
    expect(snapshotRow(begin.snapshotId).status).toBe("prepared");
    expect(deliveryRow().deliveryWatermark).toBe(3);
  });

  it("rejects a duplicate-commit replay from the wrong device, even with the owner's key and fields", async () => {
    const begin = await prepare();
    await service.commit({
      snapshotId: begin.snapshotId,
      historyRevision: begin.historyRevision,
      deliveryWatermark: begin.deliveryWatermark,
      idempotencyKey: "key-1",
      deviceId: DEVICE,
      now: T0 + 1000,
    });
    await expect(
      service.commit({
        snapshotId: begin.snapshotId,
        historyRevision: begin.historyRevision,
        deliveryWatermark: begin.deliveryWatermark,
        idempotencyKey: "key-1",
        deviceId: DEVICE_2,
        now: T0 + 2000,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_FORBIDDEN" });
  });

  it("returns 410 SNAPSHOT_EXPIRED after the sweep flipped the row, regardless of wall clock", async () => {
    const begin = await prepare(); // expiresAt = T0 + TTL_MS
    const deleteAfterAtBegin = deleteAfterMap();
    // Simulate a Bridge-start sweep with a clock already past expiry…
    service.expireStale(T0 + TTL_MS + 60_000);
    expect(snapshotRow(begin.snapshotId).status).toBe("expired");
    // …then the (delayed/retried) commit arrives with its own earlier clock.
    await expect(
      service.commit({
        snapshotId: begin.snapshotId,
        historyRevision: begin.historyRevision,
        deliveryWatermark: begin.deliveryWatermark,
        idempotencyKey: "key-1",
        deviceId: DEVICE,
        now: T0 + 1000,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", httpStatus: 410 });
    // Expired snapshots never advance delivery and never delete events.
    expect(deliveryRow().deliveryWatermark).toBe(3);
    expect(deleteAfterMap()).toEqual(deleteAfterAtBegin);
  });

  it("returns 410 for an unknown snapshotId", async () => {
    await expect(
      service.commit({
        snapshotId: "00000000-0000-4000-8000-000000000000",
        historyRevision: "r",
        deliveryWatermark: 5,
        idempotencyKey: "key-1",
        deviceId: DEVICE,
        now: T0,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED" });
  });
});

// ---------------------------------------------------------------------------
// 8. expireStale
// ---------------------------------------------------------------------------

describe("§6.7 expireStale", () => {
  it("flips prepared rows whose expiresAt <= now; expired rows never advance delivery", async () => {
    const begin = await prepare();
    const deleteAfterAtBegin = deleteAfterMap();
    service.expireStale(T0 + TTL_MS - 1);
    expect(snapshotRow(begin.snapshotId).status).toBe("prepared"); // not yet
    service.expireStale(T0 + TTL_MS);
    expect(snapshotRow(begin.snapshotId).status).toBe("expired");

    expect(deliveryRow().deliveryWatermark).toBe(3);
    expect(deleteAfterMap()).toEqual(deleteAfterAtBegin); // no deletions scheduled
    expect(pendingRows()).toHaveLength(5); // nothing deleted

    await expect(
      service.commit({
        snapshotId: begin.snapshotId,
        historyRevision: begin.historyRevision,
        deliveryWatermark: begin.deliveryWatermark,
        idempotencyKey: "key-1",
        deviceId: DEVICE,
        now: T0 + TTL_MS,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED" });
  });

  it("clears the ACK guard only when no prepared snapshot remains for the device", async () => {
    // Two overlapping begins: the second one expires later.
    const first = await service.begin({ sessionId: SESSION, deviceId: DEVICE, pageSize: 3, now: T0 });
    appendEvents(0);
    const second = await service.begin({ sessionId: SESSION, deviceId: DEVICE, pageSize: 3, now: T0 + 300_000 });
    expect(deliveryRow().pendingCheckpoint).toBe(1);

    service.expireStale(T0 + TTL_MS + 1); // first expired, second alive
    expect(snapshotRow(first.snapshotId).status).toBe("expired");
    expect(snapshotRow(second.snapshotId).status).toBe("prepared");
    expect(deliveryRow().pendingCheckpoint).toBe(1); // guard still on
    expect(() => journal.acknowledge(SESSION, DEVICE, 5n, T0 + TTL_MS + 1)).toThrow(
      CheckpointCommitRequiredError,
    );

    service.expireStale(T0 + 900_001); // second (expires T0+900k) now expired too
    expect(snapshotRow(second.snapshotId).status).toBe("expired");
    expect(deliveryRow().pendingCheckpoint).toBe(0); // guard released
    expect(() => journal.acknowledge(SESSION, DEVICE, 5n, T0 + 900_001)).not.toThrow();
  });

  it("leaves committed snapshots alone", async () => {
    const begin = await prepare();
    await service.commit({
      snapshotId: begin.snapshotId,
      historyRevision: begin.historyRevision,
      deliveryWatermark: begin.deliveryWatermark,
      idempotencyKey: "key-1",
      deviceId: DEVICE,
      now: T0 + 1000,
    });
    service.expireStale(T0 + 10 * TTL_MS);
    expect(snapshotRow(begin.snapshotId).status).toBe("committed");
  });
});

// ---------------------------------------------------------------------------
// 9. Buffered events behind the resync mutex
// ---------------------------------------------------------------------------

describe("§6.7 (1)/(6): resync mutex buffers event-ID allocation", () => {
  it("appends routed through withResyncMutex wait for begin to release and land above the watermark", async () => {
    await prepare(); // watermark = 5, snapshot prepared

    // Simulate an in-flight begin (or any checkpoint critical section) by
    // holding the mutex.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const holder = service.withResyncMutex(SESSION, async () => {
      await gate;
    });

    // The journal append for this session is routed through the same hook
    // (Task 24 wires this into the delivery path).
    let appended = false;
    const appendPromise = service.withResyncMutex(SESSION, async () => {
      const event = journal.append({
        category: "system",
        sessionId: SESSION,
        eventType: "session.state.changed",
        payload: { buffered: true },
        now: T0,
      });
      appended = true;
      return event;
    });

    // While the mutex is held: no event ID allocated, append pending.
    await Promise.resolve(); // let the queue settle one microtask
    expect(appended).toBe(false);
    expect(
      (db.prepare("SELECT lastEventId FROM sessions WHERE sessionId = ?").get(SESSION) as { lastEventId: number })
        .lastEventId,
    ).toBe(5);

    releaseGate();
    const event = await appendPromise;
    await holder;
    expect(appended).toBe(true);
    expect(event.eventId).toBe(6n); // > deliveryWatermark 5
  });
});
