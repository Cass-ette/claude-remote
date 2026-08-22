import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import type { Command, CommandStatus } from "../../src/protocol/v1/types.js";
import {
  ConflictError,
  DuplicateRequestIdError,
  IllegalTransitionError,
  canonicalJson,
  computePayloadHash,
  createCommandLedger,
  type CommandLedger,
} from "../../src/commands/command-ledger.js";
import type { EventJournalPort, PersistedEvent } from "../../src/events/event-journal-types.js";

// ---------------------------------------------------------------------------
// In-test fake implementing the EventJournalPort contract against the real
// tables (sessions.lastEventId + pending_events), inside the caller's tx.
// ---------------------------------------------------------------------------

function makeFakeJournal(failAppend = false): EventJournalPort {
  return {
    appendWithinTransaction({ db, sessionId, eventType, payload, now }) {
      if (failAppend) throw new Error("journal append failed (injected)");
      const row = db
        .prepare("SELECT lastEventId FROM sessions WHERE sessionId = ?")
        .get(sessionId) as { lastEventId: number } | undefined;
      if (row === undefined) throw new Error(`unknown session ${sessionId}`);
      const eventId = row.lastEventId + 1;
      db.prepare("UPDATE sessions SET lastEventId = ? WHERE sessionId = ?").run(eventId, sessionId);
      const payloadJson = JSON.stringify(payload);
      db.prepare(
        `INSERT INTO pending_events (sessionId, eventId, eventType, payloadJson, protocolVersion, createdAt)
         VALUES (?, ?, ?, ?, 'claude-remote.v1', ?)`,
      ).run(sessionId, eventId, eventType, payloadJson, now);
      const event: PersistedEvent = {
        sessionId,
        eventId: BigInt(eventId),
        eventType,
        payloadJson,
        protocolVersion: "claude-remote.v1",
        createdAt: now,
      };
      return event;
    },
  };
}

let dir: string;
let db: SqliteDatabase;
let ledger: CommandLedger;

const T0 = 1_700_000_000_000;

function envelope(overrides: Partial<Command> = {}): Command {
  return {
    protocolVersion: "claude-remote.v1",
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    commandType: "message.send",
    sessionId: "sess-1",
    sentAt: new Date(T0).toISOString(),
    payload: { sessionId: "sess-1", text: "hello" },
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmd-ledger-"));
  db = openDatabase(join(dir, "test.db"));
  migrate(db);
  db.prepare(
    `INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
     VALUES ('proj-1', '/tmp/proj-1', 1, 2, 'proj', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
     VALUES ('sess-1', 'proj-1', 's', 'idle', 'bridge', 0, 0)`,
  ).run();
  ledger = createCommandLedger(db, makeFakeJournal());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("canonicalJson / computePayloadHash", () => {
  it("hashes nested objects deterministically regardless of key insertion order", () => {
    const a = { z: 1, a: { y: [1, 2, { k: "v" }], b: true } };
    const b = { a: { b: true, y: [1, 2, { k: "v" }] }, z: 1 };
    expect(computePayloadHash(a)).toBe(computePayloadHash(b));
  });

  it("distinguishes integer 1 from float 1.5 and from string '1'", () => {
    expect(computePayloadHash({ x: 1 })).not.toBe(computePayloadHash({ x: 1.5 }));
    expect(computePayloadHash({ x: 1 })).not.toBe(computePayloadHash({ x: "1" }));
  });

  it("orders keys by UTF-16 code units ('z' before 'é')", () => {
    expect(canonicalJson({ é: 1, z: 0 })).toBe('{"z":0,"é":1}');
  });

  it("handles surrogate-pair keys", () => {
    expect(canonicalJson({ "😀": 1, a: 2 })).toBe('{"a":2,"😀":1}');
    expect(canonicalJson({ "😀": 1 })).not.toBe(canonicalJson({ "\ud83d": 1 }));
  });
});

describe("accept / acceptDuplicate idempotency", () => {
  it("first insert succeeds with status accepted", async () => {
    const env = envelope();
    const rec = await ledger.accept(env, "device-1", computePayloadHash(env.payload), T0);
    expect(rec.status).toBe("accepted");
    expect(rec.requestId).toBe(env.requestId);
    expect(rec.createdAt).toBe(T0);
    expect(rec.updatedAt).toBe(T0);
    expect(await ledger.get(env.requestId)).toEqual(rec);
  });

  it("same key + same hash replays the saved record", async () => {
    const env = envelope();
    const first = await ledger.accept(env, "device-1", computePayloadHash(env.payload), T0);
    const second = await ledger.acceptDuplicate(env, "device-1", computePayloadHash(env.payload), T0 + 1);
    expect(second).toEqual({ kind: "replay", record: first });
    // updatedAt unchanged: no rewrite happened
    expect((await ledger.get(env.requestId))?.updatedAt).toBe(T0);
  });

  it("same key + different hash is a conflict and writes nothing new", async () => {
    const env = envelope();
    await ledger.accept(env, "device-1", computePayloadHash(env.payload), T0);
    const other = { ...env, payload: { sessionId: "sess-1", text: "DIFFERENT" } };
    const res = await ledger.acceptDuplicate(other, "device-1", computePayloadHash(other.payload), T0 + 1);
    expect(res).toEqual({ kind: "conflict" });
    // and accept() on the same conflicting payload rejects
    await expect(
      ledger.accept(other, "device-1", computePayloadHash(other.payload), T0 + 1),
    ).rejects.toBeInstanceOf(ConflictError);
    const count = db.prepare("SELECT COUNT(*) AS n FROM commands").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("duplicate requestId under a different key rejects", async () => {
    const env = envelope();
    await ledger.accept(env, "device-1", computePayloadHash(env.payload), T0);
    const dupe = { ...env, idempotencyKey: randomUUID() };
    await expect(
      ledger.accept(dupe, "device-1", computePayloadHash(dupe.payload), T0 + 1),
    ).rejects.toBeInstanceOf(DuplicateRequestIdError);
    await expect(
      ledger.acceptDuplicate(dupe, "device-1", computePayloadHash(dupe.payload), T0 + 1),
    ).rejects.toBeInstanceOf(DuplicateRequestIdError);
  });
});

describe("transition table", () => {
  const LEGAL: ReadonlyArray<readonly [CommandStatus, CommandStatus]> = [
    ["accepted", "dispatching"],
    ["dispatching", "dispatched"],
    ["dispatched", "completed"],
    ["dispatched", "failed"],
    ["dispatching", "indeterminate"],
    ["dispatched", "indeterminate"],
    ["dispatched", "interrupted"],
    ["indeterminate", "completed"],
    ["indeterminate", "failed"],
    ["indeterminate", "interrupted"],
    ["accepted", "completed"],
    ["accepted", "failed"],
    ["accepted", "interrupted"],
  ];

  const ILLEGAL: ReadonlyArray<readonly [CommandStatus, CommandStatus]> = [
    ["completed", "dispatching"],
    ["failed", "completed"],
    ["accepted", "dispatched"],
    ["interrupted", "dispatching"],
    ["dispatched", "dispatching"],
    ["completed", "indeterminate"],
    ["dispatching", "completed"],
    ["indeterminate", "dispatching"],
  ];

  async function seedStatus(status: CommandStatus): Promise<string> {
    const env = envelope();
    await ledger.accept(env, "device-1", computePayloadHash(env.payload), T0);
    // walk the accepted record to the requested status through legal steps
    const path: Record<CommandStatus, CommandStatus[]> = {
      accepted: [],
      dispatching: ["dispatching"],
      dispatched: ["dispatching", "dispatched"],
      indeterminate: ["dispatching", "indeterminate"],
      interrupted: ["interrupted"],
      completed: ["dispatching", "dispatched", "completed"],
      failed: ["dispatching", "dispatched", "failed"],
    };
    const steps = path[status]!;
    for (const next of steps) {
      await ledger.transition(env.requestId, next, { now: T0 });
    }
    return env.requestId;
  }

  it("allows every legal transition", async () => {
    for (const [from, to] of LEGAL) {
      const requestId = await seedStatus(from);
      await expect(ledger.transition(requestId, to, { now: T0 + 100 })).resolves.toMatchObject({
        status: to,
      });
    }
  });

  it("rejects illegal transitions", async () => {
    for (const [from, to] of ILLEGAL) {
      const requestId = await seedStatus(from);
      await expect(ledger.transition(requestId, to, { now: T0 + 100 })).rejects.toBeInstanceOf(
        IllegalTransitionError,
      );
    }
  });

  it("terminal states are irreversible", async () => {
    for (const terminal of ["completed", "failed", "interrupted"] as const) {
      const requestId = await seedStatus(terminal);
      for (const next of ["accepted", "dispatching", "dispatched", "indeterminate", terminal === "failed" ? "completed" : "failed", "interrupted"] as CommandStatus[]) {
        if (next === terminal) continue;
        await expect(ledger.transition(requestId, next, { now: T0 + 100 })).rejects.toBeInstanceOf(
          IllegalTransitionError,
        );
      }
    }
  });
});

describe("transitionWithStatusEvent atomicity", () => {
  it("updates status and appends the event atomically", async () => {
    const env = envelope();
    await ledger.accept(env, "device-1", computePayloadHash(env.payload), T0);
    const { record, event } = await ledger.transitionWithStatusEvent(env.requestId, "dispatching", {
      now: T0 + 5,
      buildEventPayload: (rec) => ({
        requestId: rec.requestId,
        idempotencyKey: rec.idempotencyKey,
        commandType: rec.commandType,
        commandStatus: "dispatching",
      }),
    });
    expect(record.status).toBe("dispatching");
    expect(event.eventType).toBe("command.status.changed");
    expect(event.eventId).toBe(1n);
    expect(JSON.parse(event.payloadJson)).toMatchObject({ requestId: env.requestId });
    const pending = db
      .prepare("SELECT eventId, eventType FROM pending_events WHERE sessionId = 'sess-1'")
      .all();
    expect(pending).toEqual([{ eventId: 1, eventType: "command.status.changed" }]);
    const session = db
      .prepare("SELECT lastEventId FROM sessions WHERE sessionId = 'sess-1'")
      .get() as { lastEventId: number };
    expect(session.lastEventId).toBe(1);
  });

  it("rolls back the status update if the event append throws", async () => {
    const failing = createCommandLedger(db, makeFakeJournal(true));
    const env = envelope();
    await ledger.accept(env, "device-1", computePayloadHash(env.payload), T0);
    await expect(
      failing.transitionWithStatusEvent(env.requestId, "dispatching", {
        now: T0 + 5,
        buildEventPayload: (rec) => ({
          requestId: rec.requestId,
          commandStatus: "dispatching",
        }),
      }),
    ).rejects.toThrow("journal append failed");
    const after = await ledger.get(env.requestId);
    expect(after?.status).toBe("accepted");
    expect(after?.updatedAt).toBe(T0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_events").get()).toMatchObject({ n: 0 });
    expect(
      db.prepare("SELECT lastEventId FROM sessions WHERE sessionId = 'sess-1'").get(),
    ).toMatchObject({ lastEventId: 0 });
  });

  it("rejects status-event transitions for session-less commands", async () => {
    const globalEnv: Command = {
      protocolVersion: "claude-remote.v1",
      requestId: "1b6f4f02-6ac6-4a46-9fd5-681c9db4d552",
      idempotencyKey: "global-key-1",
      commandType: "session.list",
      sessionId: null,
      sentAt: "2026-08-01T00:00:00Z",
      payload: {},
    };
    await ledger.accept(globalEnv, "device-1", computePayloadHash(globalEnv.payload), T0);
    await expect(
      ledger.transitionWithStatusEvent(globalEnv.requestId, "completed", {
        now: T0 + 5,
        buildEventPayload: (rec) => ({
          requestId: rec.requestId,
          commandStatus: "completed",
        }),
      }),
    ).rejects.toThrow("no session");
    const after = await ledger.get(globalEnv.requestId);
    expect(after?.status).toBe("accepted");
  });
});
