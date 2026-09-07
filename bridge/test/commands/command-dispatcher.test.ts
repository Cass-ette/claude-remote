/**
 * Command dispatcher unit tests (Task 24 review fixes).
 *
 * Focused coverage of the paths the runtime integration cannot drive
 * deterministically:
 *  - command.retry_indeterminate (§7.4): transcript-evidence classification,
 *    same-UUID + same-payload re-dispatch, and the read-only no-op for
 *    already-classified commands;
 *  - StoragePressureError → typed 503 STORAGE_PRESSURE (§11.6);
 *  - message.send's indeterminate fallback on a failing stdin write.
 *
 * Real database + ledger + journal-port tables; supervisor / snapshots /
 * broker / audit are fakes.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import type { Command, CommandStatus } from "../../src/protocol/v1/types.js";
import { PROTOCOL_VERSION } from "../../src/protocol/v1/types.js";
import {
  createCommandDispatcher,
  STORAGE_PRESSURE_CODE,
  type CommandDispatcher,
  type DispatchOutcome,
} from "../../src/commands/command-dispatcher.js";
import {
  createCommandLedger,
  computePayloadHash,
  type CommandLedger,
} from "../../src/commands/command-ledger.js";
import { StoragePressureError } from "../../src/events/event-journal.js";
import type { EventJournalPort, PersistedEvent } from "../../src/events/event-journal-types.js";
import type { SessionSupervisor, TurnEvidence } from "../../src/sessions/session-supervisor.js";
import { InvalidSessionStateError } from "../../src/sessions/session-supervisor.js";
import type { AuditLog, AuditEntry } from "../../src/audit/audit-log.js";
import { TranscriptNotFoundError } from "../../src/history/claude-2.1.133-adapter.js";

// Same in-table journal port as command-ledger.test.ts (real tables).
function makeJournalPort(): EventJournalPort {
  return {
    appendWithinTransaction({ db, sessionId, eventType, payload, now }) {
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
let dispatcher: CommandDispatcher;

/** Fake supervisor state: every sendMessage call is recorded. */
interface SentMessage {
  sessionId: string;
  requestId: string;
  text: string;
}

let sentMessages: SentMessage[];
let sendMessageImpl: (input: SentMessage) => void;
let evidenceImpl: (sessionId: string, uuid: string) => Promise<TurnEvidence>;
let auditEntries: AuditEntry[];

const T0 = 1_700_000_000_000;
const SESSION = "11111111-1111-4111-8111-111111111111";

function envelope(overrides: Partial<Command> = {}): Command {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    commandType: "message.send",
    sessionId: SESSION,
    sentAt: new Date(T0).toISOString(),
    payload: { sessionId: SESSION, text: "hello" },
    ...overrides,
  };
}

function makeDispatcher(): CommandDispatcher {
  // Structural fakes: only the members the dispatcher touches are real.
  const supervisor = {
    sendMessage: async (input: { sessionId: string; requestId: string; text: string }) =>
      sendMessageImpl(input),
  } as unknown as SessionSupervisor;
  const audit = {
    filePath: "/dev/null",
    write: (entry: AuditEntry) => {
      auditEntries.push(entry);
      return {} as ReturnType<AuditLog["write"]>;
    },
  } as unknown as AuditLog;
  return createCommandDispatcher({
    db,
    ledger,
    journal: {} as never,
    supervisor,
    snapshots: {} as never,
    broker: {} as never,
    registry: {} as never,
    audit,
    importer: {} as never,
    findTurnEvidence: (sessionId, uuid) => evidenceImpl(sessionId, uuid),
    now: () => T0,
    noteWriter: () => undefined,
    clearWriter: () => undefined,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmd-dispatcher-"));
  db = openDatabase(join(dir, "test.db"));
  migrate(db);
  db.prepare(
    `INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
     VALUES ('proj-1', '/tmp/proj-1', 1, 2, 'proj', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
     VALUES (?, 'proj-1', 's', 'idle', 'bridge', 0, 0)`,
  ).run(SESSION);
  ledger = createCommandLedger(db, makeJournalPort());
  sentMessages = [];
  sendMessageImpl = (input) => {
    sentMessages.push(input);
  };
  evidenceImpl = async () => ({ kind: "absent" });
  auditEntries = [];
  dispatcher = makeDispatcher();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function dispatch(envelope: Command): Promise<DispatchOutcome> {
  return dispatcher.dispatch(envelope, "device-1");
}

/**
 * Walk a ledger row to `indeterminate` through the legal transitions without
 * dispatching (crash-equivalent: accepted → dispatching → indeterminate).
 */
async function seedIndeterminate(text: string): Promise<Command> {
  const env = envelope({ payload: { sessionId: SESSION, text } });
  await ledger.accept(env, "device-1", computePayloadHash(env.payload), T0);
  await ledger.transition(env.requestId, "dispatching", { now: T0 });
  await ledger.transition(env.requestId, "indeterminate", { now: T0 });
  return env;
}

function retryEnvelope(requestId: string): Command {
  return envelope({
    commandType: "command.retry_indeterminate",
    sessionId: null,
    payload: { requestId },
  });
}

describe("command.retry_indeterminate (§7.4)", () => {
  it("re-dispatches with the ORIGINAL requestId uuid and payload text", async () => {
    const original = await seedIndeterminate("原本文本 original text");
    const outcome = await dispatch(retryEnvelope(original.requestId));
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.response.responseType).toBe("command.status");

    // Exactly one re-send, carrying the ORIGINAL uuid and text.
    expect(sentMessages).toEqual([
      { sessionId: SESSION, requestId: original.requestId, text: "原本文本 original text" },
    ]);
    // The ledger row re-entered dispatch and is now dispatched.
    const record = await ledger.get(original.requestId);
    expect(record?.status).toBe("dispatched");
  });

  it("classifies via transcript evidence without re-sending anything", async () => {
    const original = await seedIndeterminate("maybe it finished");
    evidenceImpl = async () => ({ kind: "turn", outcome: "completed" });
    const outcome = await dispatch(retryEnvelope(original.requestId));
    expect(outcome.response.responseType).toBe("command.status");
    expect(sentMessages).toEqual([]);
    expect((await ledger.get(original.requestId))?.status).toBe("completed");
  });

  it("treats a missing transcript as absent evidence (re-dispatch)", async () => {
    const original = await seedIndeterminate("no transcript file");
    evidenceImpl = () => Promise.reject(new TranscriptNotFoundError("/gone.jsonl"));
    await dispatch(retryEnvelope(original.requestId));
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.requestId).toBe(original.requestId);
  });

  it("is a read-only no-op for non-indeterminate commands", async () => {
    const original = await seedIndeterminate("already classified");
    await ledger.transition(original.requestId, "failed", { now: T0 });
    const outcome = await dispatch(retryEnvelope(original.requestId));
    expect(outcome.response.responseType).toBe("command.status");
    const result = (outcome.response as { result?: { status: CommandStatus } }).result;
    expect(result).toEqual({ requestId: original.requestId, status: "failed" });
    expect(sentMessages).toEqual([]);
    expect((await ledger.get(original.requestId))?.status).toBe("failed");
  });

  it("rejects an unknown target with 404 COMMAND_NOT_FOUND", async () => {
    const outcome = await dispatch(retryEnvelope(randomUUID()));
    expect(outcome.httpStatus).toBe(404);
    expect(outcome.response.responseType).toBe("command.error");
    expect((outcome.response as { error: { code: string } }).error.code).toBe("COMMAND_NOT_FOUND");
  });

  it("returns to indeterminate (never failed) when the re-dispatch write fails", async () => {
    const original = await seedIndeterminate("session busy");
    evidenceImpl = async () => ({ kind: "absent" });
    sendMessageImpl = () => {
      throw new InvalidSessionStateError(SESSION, "sendMessage", "running", ["idle"]);
    };
    const outcome = await dispatch(retryEnvelope(original.requestId));
    expect(outcome.httpStatus).toBe(409);
    expect((outcome.response as { error: { code: string } }).error.code).toBe("SESSION_CONFLICT");
    // The target row is safely back at indeterminate — retryable again.
    expect((await ledger.get(original.requestId))?.status).toBe("indeterminate");
  });
});

describe("message.send error mapping (§11.6)", () => {
  it("maps StoragePressureError to a typed 503 STORAGE_PRESSURE, retryable", async () => {
    sendMessageImpl = () => {
      throw new StoragePressureError(100, 100);
    };
    const env = envelope();
    const outcome = await dispatch(env);
    expect(outcome.httpStatus).toBe(503);
    expect(outcome.response.responseType).toBe("command.error");
    const error = (outcome.response as { error: { code: string; retryable: boolean; message: string } }).error;
    expect(error.code).toBe(STORAGE_PRESSURE_CODE);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("storage budget");
    // The ledger row went indeterminate (not failed): the write never happened.
    expect((await ledger.get(env.requestId))?.status).toBe("indeterminate");
  });
});

describe("audit trail", () => {
  it("audits retry_indeterminate and the re-dispatched target outcome", async () => {
    const original = await seedIndeterminate("audit me");
    await dispatch(retryEnvelope(original.requestId));
    const retryOps = auditEntries.filter((e) => e.operationType === "command.retry_indeterminate");
    expect(retryOps).toHaveLength(1);
    expect(retryOps[0]!.resultCode).toBe("ok");
  });
});
