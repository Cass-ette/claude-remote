import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, transaction, type SqliteDatabase } from "../../src/db/database.js";
import { createCommandLedger, type CommandLedger } from "../../src/commands/command-ledger.js";
import type { EventJournalPort, PersistedEvent } from "../../src/events/event-journal-types.js";
import type { Command } from "../../src/protocol/v1/types.js";
import {
  CancelNotAllowedError,
  InitSessionMismatchError,
  InvalidSessionStateError,
  createSessionSupervisor,
  type ClaudeProcessFactory,
  type ClaudeProcessHandle,
  type ProcessController,
  type SessionSupervisor,
  type SignalName,
} from "../../src/sessions/session-supervisor.js";
import { SessionLockConflictError } from "../../src/sessions/session-locks.js";

// ---------------------------------------------------------------------------
// In-test journal port against the real tables.
// ---------------------------------------------------------------------------

function makeFakeJournal(): EventJournalPort {
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

// ---------------------------------------------------------------------------
// Fake Claude process + factory
// ---------------------------------------------------------------------------

interface FakeProcessOptions {
  sessionId: string;
  /** What system/init reports; defaults to the expected sessionId. */
  initSessionId?: string;
  /** init never arrives (timeout / rejection path). */
  initNever?: boolean;
  pid?: number;
  transcriptPath?: string;
  /** Signals the fake survives; anything else kills it. Default: SIGKILL only. */
  diesOn?: SignalName[];
}

class FakeProcess implements ClaudeProcessHandle {
  readonly sessionId: string;
  readonly pid: number | undefined;
  readonly transcriptPath: string | undefined;
  readonly signals: SignalName[] = [];
  inputClosed = false;
  private exited = false;
  private readonly initSessionId: string;
  private readonly initNever: boolean;
  private readonly diesOn: ReadonlySet<SignalName>;

  constructor(opts: FakeProcessOptions) {
    this.sessionId = opts.sessionId;
    this.pid = opts.pid ?? 4242;
    this.transcriptPath = opts.transcriptPath;
    this.initSessionId = opts.initSessionId ?? opts.sessionId;
    this.initNever = opts.initNever ?? false;
    this.diesOn = new Set(opts.diesOn ?? ["SIGKILL"]);
  }

  sendUser(): void {
    if (this.exited) throw new Error("process exited");
  }

  closeInput(): void {
    this.inputClosed = true;
  }

  signal(sig: SignalName): void {
    this.signals.push(sig);
    if (this.diesOn.has(sig)) this.exited = true;
  }

  /** Simulate the process exiting on its own (EOF, crash) — records no signal. */
  fakeExit(): void {
    this.exited = true;
  }

  alive(): boolean {
    return !this.exited;
  }

  async awaitInit(timeoutMs: number): Promise<{ session_id: string }> {
    if (this.initNever) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 50)));
      throw new Error("init timeout");
    }
    return { session_id: this.initSessionId };
  }
}

class FakeFactory implements ClaudeProcessFactory {
  readonly starts: Array<{ sessionId: string; mode: "create" | "resume"; cwd: string }> = [];
  readonly handles: FakeProcess[] = [];
  private queue: ((opts: { sessionId: string; mode: "create" | "resume"; cwd: string }) => FakeProcessOptions)[] = [];

  /** Queue a per-start override (defaults apply otherwise). */
  onNextStart(build: (opts: { sessionId: string; mode: "create" | "resume"; cwd: string }) => FakeProcessOptions): void {
    this.queue.push(build);
  }

  async start(opts: { sessionId: string; mode: "create" | "resume"; cwd: string }): Promise<ClaudeProcessHandle> {
    this.starts.push({ ...opts });
    const build = this.queue.shift();
    const handle = new FakeProcess(build ? build(opts) : { sessionId: opts.sessionId });
    this.handles.push(handle);
    return handle;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PROJECT_DIR = "/tmp/claude-remote-fixture-project";
const T0 = 1_700_000_000_000;

let dir: string;
let db: SqliteDatabase;
let ledger: CommandLedger;
let factory: FakeFactory;
let clockMs: number;

function buildSupervisor(overrides: Partial<Parameters<typeof createSessionSupervisor>[1]> = {}) {
  return createSessionSupervisor(db, {
    bridgeInstanceId: "instance-a",
    processFactory: factory,
    resolveProjectDir: () => PROJECT_DIR,
    ledger,
    journal: makeFakeJournal(),
    now: () => clockMs,
    signalWaitMs: 20,
    initTimeoutMs: 100,
    stabilizationIntervalMs: 10,
    stabilizationTimeoutMs: 300,
    ...overrides,
  });
}

function sessionStatus(sessionId: string): string {
  return (db.prepare("SELECT status FROM sessions WHERE sessionId = ?").get(sessionId) as {
    status: string;
  }).status;
}

function lockRow(sessionId: string) {
  return db.prepare("SELECT * FROM session_locks WHERE sessionId = ?").get(sessionId) as
    | {
        sessionId: string;
        bridgeInstanceId: string;
        processLeaseSecret: string | null;
        processPid: number | null;
        processStartedAt: number | null;
        heartbeatAt: number;
      }
    | undefined;
}

async function seedCommand(
  supervisor: SessionSupervisor,
  sessionId: string,
  walkTo: "accepted" | "dispatching" | "dispatched" = "accepted",
): Promise<string> {
  void supervisor;
  const env: Command = {
    protocolVersion: "claude-remote.v1",
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    commandType: "message.send",
    sessionId,
    sentAt: new Date(T0).toISOString(),
    payload: { sessionId, text: "hi" },
  };
  await ledger.accept(env, "device-1", "hash-" + env.requestId, T0);
  if (walkTo === "dispatching") {
    await ledger.transition(env.requestId, "dispatching", { now: T0 });
  } else if (walkTo === "dispatched") {
    await ledger.transition(env.requestId, "dispatching", { now: T0 });
    await ledger.transition(env.requestId, "dispatched", { now: T0 });
  }
  return env.requestId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-supervisor-"));
  db = openDatabase(join(dir, "test.db"));
  migrate(db);
  db.prepare(
    `INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
     VALUES ('proj-1', ?, 1, 2, 'proj', 0, 0)`,
  ).run(PROJECT_DIR);
  ledger = createCommandLedger(db, makeFakeJournal());
  factory = new FakeFactory();
  clockMs = T0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// createSession (§7.2)
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("generates a UUID, persists session+lock in one transaction, starts in the project dir, and reaches idle", async () => {
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1", displayName: "work" });

    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const row = db.prepare("SELECT * FROM sessions WHERE sessionId = ?").get(sessionId) as {
      projectId: string;
      displayName: string;
      status: string;
      source: string;
    };
    expect(row).toMatchObject({
      projectId: "proj-1",
      displayName: "work",
      status: "idle",
      source: "bridge",
    });
    // lock written by the same instance, with a lease secret
    const lock = lockRow(sessionId);
    expect(lock).toMatchObject({ sessionId, bridgeInstanceId: "instance-a" });
    expect(lock?.processLeaseSecret).toBeTruthy();
    expect(factory.starts).toEqual([{ sessionId, mode: "create", cwd: PROJECT_DIR }]);
    // state-change events were journaled (starting, idle)
    const events = db
      .prepare("SELECT eventType, payloadJson FROM pending_events WHERE sessionId = ? ORDER BY eventId")
      .all(sessionId) as Array<{ eventType: string; payloadJson: string }>;
    expect(events.map((e) => e.eventType)).toEqual(["session.state.changed", "session.state.changed"]);
    expect(JSON.parse(events[1]!.payloadJson)).toMatchObject({ status: "idle", previousStatus: "starting" });
  });

  it("rejects when system/init.session_id does not match, kills the process, and marks the session failed", async () => {
    factory.onNextStart((opts) => ({ ...opts, initSessionId: "not-the-expected-id" }));
    const supervisor = buildSupervisor();
    await expect(supervisor.createSession({ projectId: "proj-1" })).rejects.toBeInstanceOf(
      InitSessionMismatchError,
    );
    const row = db.prepare("SELECT sessionId, status FROM sessions").get() as {
      sessionId: string;
      status: string;
    };
    expect(row.status).toBe("failed");
    expect(factory.handles[0]!.signals).toContain("SIGKILL");
    expect(factory.handles[0]!.alive()).toBe(false);
    expect(lockRow(row.sessionId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resumeSession (§7.3)
// ---------------------------------------------------------------------------

describe("resumeSession", () => {
  it("requires idle or interrupted", async () => {
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES ('sess-x', 'proj-1', 'x', 'running', 'bridge', 0, 0)`,
    ).run();
    const supervisor = buildSupervisor();
    await expect(supervisor.resumeSession({ sessionId: "sess-x" })).rejects.toBeInstanceOf(
      InvalidSessionStateError,
    );
  });

  it("reuses a healthy same-instance process without spawning", async () => {
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    const startsBefore = factory.starts.length;
    await supervisor.resumeSession({ sessionId });
    expect(factory.starts.length).toBe(startsBefore);
    expect(sessionStatus(sessionId)).toBe("idle");
  });

  it("starts --resume from interrupted and validates init session_id", async () => {
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    // push to running, then stop → interrupted
    db.prepare("UPDATE sessions SET status = 'running' WHERE sessionId = ?").run(sessionId);
    await supervisor.stop({ sessionId });
    expect(sessionStatus(sessionId)).toBe("interrupted");

    await supervisor.resumeSession({ sessionId });
    expect(factory.starts.at(-1)).toMatchObject({ sessionId, mode: "resume", cwd: PROJECT_DIR });
    expect(sessionStatus(sessionId)).toBe("idle");
  });

  it("fails the session when resume init reports a different session_id", async () => {
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    db.prepare("UPDATE sessions SET status = 'running' WHERE sessionId = ?").run(sessionId);
    await supervisor.stop({ sessionId });

    factory.onNextStart((opts) => ({ ...opts, initSessionId: "someone-elses-session" }));
    await expect(supervisor.resumeSession({ sessionId })).rejects.toBeInstanceOf(InitSessionMismatchError);
    expect(sessionStatus(sessionId)).toBe("failed");
    expect(lockRow(sessionId)).toBeUndefined();
  });

  it("resumes an idle session with a dead process via starting, back to idle", async () => {
    // Idle with NO live handle (our process died) — seeded directly.
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES ('sess-idle-dead', 'proj-1', 's', 'idle', 'bridge', 0, 0)`,
    ).run();
    const supervisor = buildSupervisor();
    await supervisor.resumeSession({ sessionId: "sess-idle-dead" });
    expect(factory.starts.at(-1)).toMatchObject({
      sessionId: "sess-idle-dead",
      mode: "resume",
      cwd: PROJECT_DIR,
    });
    expect(sessionStatus("sess-idle-dead")).toBe("idle");
    const statuses = db
      .prepare("SELECT payloadJson FROM pending_events WHERE sessionId = 'sess-idle-dead' ORDER BY eventId")
      .all() as Array<{ payloadJson: string }>;
    expect(
      statuses.map((e) => (JSON.parse(e.payloadJson) as { status: string }).status),
    ).toEqual(["starting", "idle"]);
  });

  it("fails an idle dead-process resume whose init reports a different session_id", async () => {
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES ('sess-idle-mm', 'proj-1', 's', 'idle', 'bridge', 0, 0)`,
    ).run();
    factory.onNextStart((opts) => ({ ...opts, initSessionId: "wrong-session-id" }));
    const supervisor = buildSupervisor();
    await expect(supervisor.resumeSession({ sessionId: "sess-idle-mm" })).rejects.toBeInstanceOf(
      InitSessionMismatchError,
    );
    expect(sessionStatus("sess-idle-mm")).toBe("failed");
    expect(lockRow("sess-idle-mm")).toBeUndefined();
    expect(factory.handles[0]!.signals).toContain("SIGKILL");
  });

  it("takes over a stale foreign lock", async () => {
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES ('sess-stale', 'proj-1', 's', 'interrupted', 'bridge', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO session_locks (sessionId, bridgeInstanceId, processLeaseSecret, heartbeatAt)
       VALUES ('sess-stale', 'instance-OLD', 'old-secret', ?)`,
    ).run(T0 - 10 * 60 * 1000); // 10 min old heartbeat → stale

    const supervisor = buildSupervisor();
    await supervisor.resumeSession({ sessionId: "sess-stale" });
    expect(lockRow("sess-stale")?.bridgeInstanceId).toBe("instance-a");
    expect(sessionStatus("sess-stale")).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// stop (§7.5)
// ---------------------------------------------------------------------------

describe("stop", () => {
  async function sessionRunning(supervisor: SessionSupervisor): Promise<string> {
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    db.prepare("UPDATE sessions SET status = 'running' WHERE sessionId = ?").run(sessionId);
    return sessionId;
  }

  it("denies pending permissions first, then escalates SIGINT → SIGTERM → SIGKILL, ending interrupted", async () => {
    const denied: Array<{ sessionId: string; reason: string }> = [];
    const supervisor = buildSupervisor({
      permissionBroker: {
        async denyAllForSession(sessionId, reason) {
          denied.push({ sessionId, reason });
        },
      },
    });
    const sessionId = await sessionRunning(supervisor);
    await supervisor.stop({ sessionId });
    expect(denied).toEqual([{ sessionId, reason: "session stopped" }]);
    expect(factory.handles[0]!.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(factory.handles[0]!.alive()).toBe(false);
    expect(sessionStatus(sessionId)).toBe("interrupted");
  });

  it("stops after SIGINT alone when the process exits quickly", async () => {
    factory.onNextStart((opts) => ({ ...opts, diesOn: ["SIGINT"] }));
    const supervisor = buildSupervisor();
    const sessionId = await sessionRunning(supervisor);
    await supervisor.stop({ sessionId });
    expect(factory.handles[0]!.signals).toEqual(["SIGINT"]);
    expect(sessionStatus(sessionId)).toBe("interrupted");
  });

  it("is a no-op-safe call when already interrupted", async () => {
    const supervisor = buildSupervisor();
    const sessionId = await sessionRunning(supervisor);
    await supervisor.stop({ sessionId });
    await supervisor.stop({ sessionId });
    expect(factory.handles[0]!.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(sessionStatus(sessionId)).toBe("interrupted");
  });
});

// ---------------------------------------------------------------------------
// release (§7.5)
// ---------------------------------------------------------------------------

describe("release", () => {
  it("is only legal from idle or interrupted", async () => {
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    db.prepare("UPDATE sessions SET status = 'running' WHERE sessionId = ?").run(sessionId);
    await expect(supervisor.release({ sessionId })).rejects.toBeInstanceOf(InvalidSessionStateError);
  });

  it("closes stdin, waits for exit and transcript stabilization, releases the lock, ends inactive", async () => {
    const transcript = join(dir, "transcript.jsonl");
    writeFileSync(transcript, "line1\n");
    factory.onNextStart((opts) => ({ ...opts, transcriptPath: transcript, diesOn: ["SIGKILL"] }));
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    expect(lockRow(sessionId)).toBeDefined();

    // process exits gracefully once stdin closes
    const handle = factory.handles[0]!;
    const closed = supervisor.release({ sessionId });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handle.inputClosed).toBe(true);
    handle.fakeExit(); // simulate the process noticing EOF and exiting
    await closed;
    expect(handle.signals).toEqual([]); // release signalled nothing: exit was graceful

    expect(handle.alive()).toBe(false);
    expect(lockRow(sessionId)).toBeUndefined();
    expect(sessionStatus(sessionId)).toBe("inactive");
  });

  it("waits until the transcript file stops changing", async () => {
    const transcript = join(dir, "transcript.jsonl");
    writeFileSync(transcript, "line1\n");
    factory.onNextStart((opts) => ({ ...opts, transcriptPath: transcript, diesOn: ["SIGKILL"] }));
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    const handle = factory.handles[0]!;

    // keep growing the transcript while release is in flight
    let growing = true;
    const grower = (async () => {
      for (let i = 0; i < 10 && growing; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (growing) writeFileSync(transcript, `line${i}\n`, { flag: "a" });
      }
    })();
    const released = supervisor.release({ sessionId });
    handle.fakeExit();
    await released;
    growing = false;
    await grower;
    expect(sessionStatus(sessionId)).toBe("inactive");
  });

  it("releases from interrupted without a live process", async () => {
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    db.prepare("UPDATE sessions SET status = 'running' WHERE sessionId = ?").run(sessionId);
    await supervisor.stop({ sessionId }); // kills the handle and removes it
    expect(sessionStatus(sessionId)).toBe("interrupted");
    await supervisor.release({ sessionId });
    expect(sessionStatus(sessionId)).toBe("inactive");
    expect(lockRow(sessionId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cancel (§7.5)
// ---------------------------------------------------------------------------

describe("cancel", () => {
  it("cancels an accepted, undispatched command as failed {cancelled:true}", async () => {
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    const requestId = await seedCommand(supervisor, sessionId, "accepted");
    await supervisor.cancel({ requestId });
    const record = await ledger.get(requestId);
    expect(record?.status).toBe("failed");
    const event = db
      .prepare("SELECT payloadJson FROM pending_events WHERE sessionId = ? ORDER BY eventId")
      .all(sessionId) as Array<{ payloadJson: string }>;
    expect(
      event.some((e) => {
        const parsed = JSON.parse(e.payloadJson) as { requestId?: string; result?: { cancelled?: boolean } };
        return parsed.requestId === requestId && parsed.result?.cancelled === true;
      }),
    ).toBe(true);
  });

  it("rejects cancel for dispatched commands", async () => {
    const supervisor = buildSupervisor();
    const { sessionId } = await supervisor.createSession({ projectId: "proj-1" });
    const requestId = await seedCommand(supervisor, sessionId, "dispatched");
    await expect(supervisor.cancel({ requestId })).rejects.toBeInstanceOf(CancelNotAllowedError);
    expect((await ledger.get(requestId))?.status).toBe("dispatched");
  });
});

// ---------------------------------------------------------------------------
// recoverOnStartup (§7.6)
// ---------------------------------------------------------------------------

describe("recoverOnStartup", () => {
  function seedForeignLockedSession(sessionId: string, pid: number, startedAt: number, status: string): void {
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES (?, 'proj-1', 's', ?, 'bridge', 0, 0)`,
    ).run(sessionId, status);
    db.prepare(
      `INSERT INTO session_locks (sessionId, bridgeInstanceId, processLeaseSecret, processPid, processStartedAt, heartbeatAt)
       VALUES (?, 'instance-OLD', 'secret', ?, ?, ?)`,
    ).run(sessionId, pid, startedAt, T0);
  }

  it("expires stale foreign leases without signalling on PID identity mismatch", async () => {
    seedForeignLockedSession("sess-a", 999, 111_111, "running");
    const killed: Array<{ pid: number; sig: SignalName }> = [];
    const controller: ProcessController = {
      alive: () => true,
      kill: (pid, sig) => killed.push({ pid, sig }),
      // start time no longer matches: PID recycled by another process
      startedAt: () => 222_222,
    };
    const supervisor = buildSupervisor({ processController: controller });
    await supervisor.recoverOnStartup();
    expect(killed).toEqual([]);
    expect(lockRow("sess-a")).toBeUndefined();
    // session moved out of running (running → interrupting → interrupted)
    expect(sessionStatus("sess-a")).toBe("interrupted");
  });

  it("kills matching-identity leftover processes with the full signal order, then expires the lease", async () => {
    seedForeignLockedSession("sess-b", 31337, 111_111, "waiting_permission");
    const killed: SignalName[] = [];
    let alive = true;
    const controller: ProcessController = {
      alive: () => alive,
      kill: (_pid, sig) => {
        killed.push(sig);
        if (sig === "SIGKILL") alive = false;
      },
      startedAt: () => 111_111,
    };
    const supervisor = buildSupervisor({ processController: controller });
    await supervisor.recoverOnStartup();
    expect(killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(lockRow("sess-b")).toBeUndefined();
    expect(sessionStatus("sess-b")).toBe("interrupted");
  });

  it("denies old pending permissions and leaves commands untouched", async () => {
    seedForeignLockedSession("sess-c", 1, 1, "running");
    const denied: string[] = [];
    const supervisor = buildSupervisor({
      permissionBroker: {
        async denyAllForSession(sessionId) {
          denied.push(sessionId);
        },
      },
    });
    const requestId = await seedCommand(supervisor, "sess-c", "dispatched");
    await supervisor.recoverOnStartup();
    expect(denied).toEqual(["sess-c"]);
    // §7.6.6 is deferred to reconcileIndeterminateCommands (Task 19 wiring)
    expect((await ledger.get(requestId))?.status).toBe("dispatched");
  });

  it("keeps locks owned by the current instance", async () => {
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES ('sess-mine', 'proj-1', 's', 'idle', 'bridge', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO session_locks (sessionId, bridgeInstanceId, processLeaseSecret, heartbeatAt)
       VALUES ('sess-mine', 'instance-a', 'secret', ?)`,
    ).run(T0);
    const supervisor = buildSupervisor();
    await supervisor.recoverOnStartup();
    expect(lockRow("sess-mine")?.bridgeInstanceId).toBe("instance-a");
  });
});

// ---------------------------------------------------------------------------
// reconcileIndeterminateCommands (§7.6.6, called once Task 19 lands)
// ---------------------------------------------------------------------------

describe("reconcileIndeterminateCommands", () => {
  it("moves dispatching/dispatched to indeterminate and classifies by transcript evidence", async () => {
    const supervisor = buildSupervisor();
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES ('sess-r', 'proj-1', 's', 'interrupted', 'bridge', 0, 0)`,
    ).run();
    const completed = await seedCommand(supervisor, "sess-r", "dispatching");
    const interrupted = await seedCommand(supervisor, "sess-r", "dispatched");
    const absent = await seedCommand(supervisor, "sess-r", "dispatched");

    await supervisor.reconcileIndeterminateCommands({
      async findTurnEvidence(_sessionId, uuid) {
        if (uuid === completed) return { kind: "turn", outcome: "completed" };
        if (uuid === interrupted) return { kind: "turn", outcome: "interrupted" };
        return { kind: "absent" };
      },
    });

    expect((await ledger.get(completed))?.status).toBe("completed");
    expect((await ledger.get(interrupted))?.status).toBe("interrupted");
    expect((await ledger.get(absent))?.status).toBe("indeterminate");
  });

  it("keeps indeterminate on unparseable transcripts", async () => {
    const supervisor = buildSupervisor();
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES ('sess-u', 'proj-1', 's', 'interrupted', 'bridge', 0, 0)`,
    ).run();
    const requestId = await seedCommand(supervisor, "sess-u", "dispatched");
    await supervisor.reconcileIndeterminateCommands({
      async findTurnEvidence() {
        return { kind: "unparseable" };
      },
    });
    expect((await ledger.get(requestId))?.status).toBe("indeterminate");
  });
});

// ---------------------------------------------------------------------------
// Concurrent supervisors via session_locks (§7.3, §7.7)
// ---------------------------------------------------------------------------

describe("concurrent supervisor instances", () => {
  it("a second Bridge instance conflicts on a fresh foreign lock", async () => {
    const supervisorA = buildSupervisor();
    const { sessionId } = await supervisorA.createSession({ projectId: "proj-1" });

    const supervisorB = buildSupervisor({ bridgeInstanceId: "instance-b" });
    await expect(supervisorB.resumeSession({ sessionId })).rejects.toBeInstanceOf(
      SessionLockConflictError,
    );
    // the first instance is unaffected
    expect(lockRow(sessionId)?.bridgeInstanceId).toBe("instance-a");
    expect(sessionStatus(sessionId)).toBe("idle");
  });

  it("a fresh foreign lock also blocks createSession's lock insert path on resume", async () => {
    // A foreign lock with a FRESH heartbeat that the other instance renewed.
    db.prepare(
      `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
       VALUES ('sess-cc', 'proj-1', 's', 'idle', 'bridge', 0, 0)`,
    ).run();
    transaction(db, () => {
      db.prepare(
        `INSERT INTO session_locks (sessionId, bridgeInstanceId, processLeaseSecret, heartbeatAt)
         VALUES ('sess-cc', 'instance-B', 'b-secret', ?)`,
      ).run(T0);
    });
    const supervisor = buildSupervisor();
    await expect(supervisor.resumeSession({ sessionId: "sess-cc" })).rejects.toBeInstanceOf(
      SessionLockConflictError,
    );
  });
});
