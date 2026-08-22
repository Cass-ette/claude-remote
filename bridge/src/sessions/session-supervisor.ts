/**
 * Session supervisor (spec §6.3, §7.2, §7.3, §7.5, §7.6).
 *
 * Owns the lifecycle of the Claude Code child process of every active
 * session: create/resume with `system/init.session_id` validation, the
 * deterministic stop signal order, clean release with transcript
 * stabilization, cancellation of undispatched commands, and Bridge restart
 * recovery.
 *
 * Process launches are delegated to an injectable {@link ClaudeProcessFactory}
 * (the real spawn wiring is Task 16); tests inject a fake. All timing
 * constants are injectable with defaults from config.ts.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { transaction } from "../db/database.js";
import type { SqliteDatabase } from "../db/database.js";
import { SIGNAL_WAIT_SECONDS } from "../config.js";
import type { EventJournalPort } from "../events/event-journal-types.js";
import { assertTransition } from "./session-state-machine.js";
import type { SessionStatus } from "./session-state-machine.js";
import {
  createSessionLockStore,
  isStaleLock,
  SessionLockConflictError,
  type SessionLockStore,
} from "./session-locks.js";

// ---------------------------------------------------------------------------
// Process abstraction
// ---------------------------------------------------------------------------

export type SignalName = "SIGINT" | "SIGTERM" | "SIGKILL";

/**
 * A live Claude Code child process. `alive()` lets the supervisor poll exit
 * without depending on a specific event-emitter shape; the real handle
 * (Task 16) answers from the child_process handle.
 */
export interface ClaudeProcessHandle {
  readonly sessionId: string;
  readonly pid: number | undefined;
  /** Transcript JSONL path, when known; absent → stabilization is skipped. */
  readonly transcriptPath?: string | undefined;
  sendUser(requestId: string, text: string): void;
  closeInput(): void;
  signal(sig: SignalName): void;
  alive(): boolean;
  /** Resolves with the first `system/init` payload or rejects on timeout. */
  awaitInit(timeoutMs: number): Promise<{ session_id: string }>;
}

export interface ClaudeProcessFactory {
  start(opts: {
    sessionId: string;
    mode: "create" | "resume";
    cwd: string;
  }): Promise<ClaudeProcessHandle>;
}

/** OS-process inspection for restart recovery (§7.6); faked in tests. */
export interface ProcessController {
  alive(pid: number): boolean;
  kill(pid: number, sig: SignalName): void;
  startedAt(pid: number): number | null;
}

/** Task 17 (permission broker) integration point; optional for now. */
export interface PermissionDenier {
  denyAllForSession(sessionId: string, reason: string): Promise<void> | void;
}

/**
 * Transcript evidence for an indeterminate command's turn (§7.4). The real
 * classification lives in the history adapter (Task 19); the supervisor only
 * maps evidence to a command status transition.
 */
export type TurnEvidence =
  | { kind: "absent" } // UUID not in transcript → maybe undelivered
  | { kind: "unparseable" } // transcript unreadable → no guess
  | { kind: "turn"; outcome: "completed" | "failed" | "interrupted" };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`unknown session ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

export class InvalidSessionStateError extends Error {
  constructor(
    readonly sessionId: string,
    readonly operation: string,
    readonly actual: string,
    readonly required: readonly string[],
  ) {
    super(`${operation} requires session ${sessionId} in [${required.join("|")}], got ${actual}`);
    this.name = "InvalidSessionStateError";
  }
}

export class InitSessionMismatchError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reportedSessionId: string,
  ) {
    super(
      `system/init reported session_id ${reportedSessionId}, expected ${sessionId}; ` +
        "the process was terminated and the session marked failed",
    );
    this.name = "InitSessionMismatchError";
  }
}

export class CancelNotAllowedError extends Error {
  constructor(
    readonly requestId: string,
    readonly status: string,
  ) {
    super(
      `command ${requestId} cannot be cancelled: status is ${status}, ` +
        "only accepted (not yet dispatched) commands can be cancelled",
    );
    this.name = "CancelNotAllowedError";
  }
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export interface SessionSupervisor {
  createSession(input: {
    projectId: string;
    displayName?: string;
  }): Promise<{ sessionId: string }>;
  resumeSession(input: { sessionId: string }): Promise<void>;
  stop(input: { sessionId: string }): Promise<void>;
  release(input: { sessionId: string }): Promise<void>;
  cancel(input: { requestId: string }): Promise<void>;
  recoverOnStartup(): Promise<void>;
  reconcileIndeterminateCommands(history: {
    findTurnEvidence(sessionId: string, uuid: string): Promise<TurnEvidence>;
  }): Promise<void>;
}

export interface SessionSupervisorOptions {
  readonly bridgeInstanceId: string;
  readonly processFactory: ClaudeProcessFactory;
  /** Resolves a projectId to the canonical project directory for cwd. */
  readonly resolveProjectDir: (projectId: string) => string;
  readonly ledger: {
    get(requestId: string): Promise<import("../commands/command-ledger.js").CommandRecord | undefined>;
    transition(
      requestId: string,
      next: import("../protocol/v1/types.js").CommandStatus,
      options: { now: number },
    ): Promise<import("../commands/command-ledger.js").CommandRecord>;
    transitionWithStatusEvent(
      requestId: string,
      next: import("../protocol/v1/types.js").CommandStatus,
      options: import("../commands/command-ledger.js").TransitionWithStatusEventOptions,
    ): Promise<{
      record: import("../commands/command-ledger.js").CommandRecord;
      event: import("../events/event-journal-types.js").PersistedEvent;
    }>;
  };
  readonly journal: EventJournalPort;
  readonly permissionBroker?: PermissionDenier;
  readonly processController?: ProcessController;
  readonly now?: () => number;
  /** Default: SIGNAL_WAIT_SECONDS from config.ts (5 s). */
  readonly signalWaitMs?: number;
  /** Default: 10 s. */
  readonly initTimeoutMs?: number;
  /** Default: DEFAULT_STALE_HEARTBEAT_MS (30 s). */
  readonly staleHeartbeatMs?: number;
  /** Default: 200 ms. */
  readonly stabilizationIntervalMs?: number;
  /** Default: 5 s. */
  readonly stabilizationTimeoutMs?: number;
}

interface SessionRow {
  sessionId: string;
  projectId: string;
  status: SessionStatus;
}

const STOP_SIGNAL_ORDER: readonly SignalName[] = ["SIGINT", "SIGTERM", "SIGKILL"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSessionSupervisor(
  db: SqliteDatabase,
  options: SessionSupervisorOptions,
): SessionSupervisor {
  const locks: SessionLockStore = createSessionLockStore(db);
  const now = options.now ?? Date.now;
  const signalWaitMs = options.signalWaitMs ?? SIGNAL_WAIT_SECONDS * 1000;
  const initTimeoutMs = options.initTimeoutMs ?? 10_000;
  const staleHeartbeatMs = options.staleHeartbeatMs ?? 30_000;
  const stabilizationIntervalMs = options.stabilizationIntervalMs ?? 200;
  const stabilizationTimeoutMs = options.stabilizationTimeoutMs ?? 5_000;

  const getSessionStmt = db.prepare("SELECT sessionId, projectId, status FROM sessions WHERE sessionId = ?");
  const insertSessionStmt = db.prepare(
    `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
     VALUES (?, ?, ?, ?, 'bridge', ?, ?)`,
  );
  const updateStatusStmt = db.prepare(
    "UPDATE sessions SET status = ?, lastActivityAt = ? WHERE sessionId = ?",
  );

  /** Live handles started by THIS supervisor instance, keyed by sessionId. */
  const processes = new Map<string, ClaudeProcessHandle>();

  function getSession(sessionId: string): SessionRow {
    const row = getSessionStmt.get(sessionId) as SessionRow | undefined;
    if (row === undefined) throw new UnknownSessionError(sessionId);
    return row;
  }

  function emitStateChange(sessionId: string, previous: string, status: string, at: number): void {
    options.journal.appendWithinTransaction({
      db,
      sessionId,
      eventType: "session.state.changed",
      payload: { sessionId, previousStatus: previous, status },
      now: at,
    });
  }

  /** Guarded, persisted, event-emitting status change. */
  function setStatus(sessionId: string, to: SessionStatus): void {
    const at = now();
    transaction(db, () => {
      const row = getSession(sessionId);
      assertTransition(row.status, to);
      updateStatusStmt.run(to, at, sessionId);
      emitStateChange(sessionId, row.status, to, at);
    });
  }

  /** Process start failure / init mismatch: kill, fail the session, drop lock. */
  async function failStartup(sessionId: string, handle: ClaudeProcessHandle | undefined): Promise<void> {
    if (handle !== undefined) {
      await terminateProcess(handle);
      processes.delete(sessionId);
    }
    transaction(db, () => {
      locks.delete(sessionId);
    });
    setStatus(sessionId, "failed");
  }

  /**
   * §7.5 stop order: SIGINT → wait → SIGTERM → wait → SIGKILL. Resolves once
   * the process is no longer alive (or after the final signal).
   */
  async function terminateProcess(handle: ClaudeProcessHandle): Promise<void> {
    for (const sig of STOP_SIGNAL_ORDER) {
      handle.signal(sig);
      if (await exitedWithin(handle, signalWaitMs)) return;
    }
  }

  async function exitedWithin(handle: ClaudeProcessHandle, waitMs: number): Promise<boolean> {
    const pollMs = Math.max(1, Math.min(20, Math.floor(waitMs / 10)));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!handle.alive()) return true;
      await sleep(pollMs);
    }
    return !handle.alive();
  }

  /**
   * §7.5 release: transcript file size must be unchanged across three
   * consecutive observations (or the timeout elapses).
   */
  async function waitForTranscriptStabilization(path: string): Promise<boolean> {
    const deadline = Date.now() + stabilizationTimeoutMs;
    let last1 = -2;
    let last2 = -3;
    for (;;) {
      const size = fileSize(path);
      if (size === last1 && size === last2) return true;
      last2 = last1;
      last1 = size;
      if (Date.now() >= deadline) return false;
      await sleep(stabilizationIntervalMs);
    }
  }

  function recordProcessInLock(handle: ClaudeProcessHandle): void {
    const lock = locks.get(handle.sessionId);
    locks.put({
      sessionId: handle.sessionId,
      bridgeInstanceId: options.bridgeInstanceId,
      processLeaseSecret: lock?.processLeaseSecret ?? randomUUID(),
      processPid: handle.pid ?? null,
      processStartedAt:
        (handle.pid !== undefined ? options.processController?.startedAt(handle.pid) : null) ??
        now(),
      heartbeatAt: now(),
    });
  }

  /**
   * §7.3 lock acquisition: fresh foreign lock conflicts; stale foreign lock or
   * our own row is (re)taken.
   */
  function acquireLock(sessionId: string): void {
    const at = now();
    const lock = locks.get(sessionId);
    if (lock === undefined) {
      locks.insert({
        sessionId,
        bridgeInstanceId: options.bridgeInstanceId,
        processLeaseSecret: randomUUID(),
        now: at,
      });
      return;
    }
    if (lock.bridgeInstanceId === options.bridgeInstanceId) {
      locks.updateHeartbeat(sessionId, at);
      return;
    }
    if (!isStaleLock(lock, at, staleHeartbeatMs)) {
      throw new SessionLockConflictError(sessionId, lock.bridgeInstanceId);
    }
    locks.put({ ...lock, bridgeInstanceId: options.bridgeInstanceId, heartbeatAt: at });
  }

  // -------------------------------------------------------------------------
  // createSession (§7.2)
  // -------------------------------------------------------------------------

  async function createSession(input: {
    projectId: string;
    displayName?: string;
  }): Promise<{ sessionId: string }> {
    const sessionId = randomUUID();
    const cwd = options.resolveProjectDir(input.projectId);
    const at = now();
    // §7.2.4: session row, lock and lease in ONE transaction.
    transaction(db, () => {
      insertSessionStmt.run(
        sessionId,
        input.projectId,
        input.displayName ?? sessionId,
        "starting",
        at,
        at,
      );
      locks.insert({
        sessionId,
        bridgeInstanceId: options.bridgeInstanceId,
        processLeaseSecret: randomUUID(),
        now: at,
      });
      emitStateChange(sessionId, "inactive", "starting", at);
    });

    let handle: ClaudeProcessHandle | undefined;
    try {
      handle = await options.processFactory.start({ sessionId, mode: "create", cwd });
      const init = await handle.awaitInit(initTimeoutMs);
      if (init.session_id !== sessionId) {
        throw new InitSessionMismatchError(sessionId, init.session_id);
      }
    } catch (error) {
      await failStartup(sessionId, handle);
      throw error;
    }
    processes.set(sessionId, handle);
    recordProcessInLock(handle);
    setStatus(sessionId, "idle");
    return { sessionId };
  }

  // -------------------------------------------------------------------------
  // resumeSession (§7.3)
  // -------------------------------------------------------------------------

  async function resumeSession(input: { sessionId: string }): Promise<void> {
    const row = getSession(input.sessionId);
    if (row.status !== "idle" && row.status !== "interrupted") {
      throw new InvalidSessionStateError(input.sessionId, "resume", row.status, [
        "idle",
        "interrupted",
      ]);
    }
    const cwd = options.resolveProjectDir(row.projectId);
    acquireLock(input.sessionId);

    const existing = processes.get(input.sessionId);
    if (existing !== undefined && existing.alive()) {
      // §7.3.4: same-instance healthy process is reused.
      locks.updateHeartbeat(input.sessionId, now());
      if (row.status === "interrupted") {
        setStatus(input.sessionId, "starting");
        setStatus(input.sessionId, "idle");
      }
      return;
    }

    // A new --resume process must be spawned. From `interrupted` the session
    // passes through `starting` (legal transition); from `idle` (our own
    // process died) the session stays semantically idle and only the process
    // is swapped — an init failure then takes idle → failed.
    if (row.status === "interrupted") {
      setStatus(input.sessionId, "starting");
    }
    let handle: ClaudeProcessHandle | undefined;
    try {
      handle = await options.processFactory.start({
        sessionId: input.sessionId,
        mode: "resume",
        cwd,
      });
      const init = await handle.awaitInit(initTimeoutMs);
      if (init.session_id !== input.sessionId) {
        throw new InitSessionMismatchError(input.sessionId, init.session_id);
      }
    } catch (error) {
      await failStartup(input.sessionId, handle);
      throw error;
    }
    processes.set(input.sessionId, handle);
    recordProcessInLock(handle);
    setStatus(input.sessionId, "idle");
  }

  // -------------------------------------------------------------------------
  // stop (§7.5)
  // -------------------------------------------------------------------------

  async function stop(input: { sessionId: string }): Promise<void> {
    const row = getSession(input.sessionId);
    if (row.status === "running" || row.status === "waiting_permission") {
      // Pending permissions are denied FIRST, before any signal.
      await options.permissionBroker?.denyAllForSession(input.sessionId, "session stopped");
      setStatus(input.sessionId, "interrupting");
    } else if (row.status !== "interrupting" && row.status !== "interrupted") {
      throw new InvalidSessionStateError(input.sessionId, "stop", row.status, [
        "running",
        "waiting_permission",
        "interrupting",
        "interrupted",
      ]);
    }
    const handle = processes.get(input.sessionId);
    if (handle !== undefined) {
      await terminateProcess(handle);
      processes.delete(input.sessionId);
    }
    const after = getSession(input.sessionId);
    if (after.status === "interrupting") {
      setStatus(input.sessionId, "interrupted");
    }
  }

  // -------------------------------------------------------------------------
  // release (§7.5)
  // -------------------------------------------------------------------------

  async function release(input: { sessionId: string }): Promise<void> {
    const row = getSession(input.sessionId);
    if (row.status !== "idle" && row.status !== "interrupted") {
      throw new InvalidSessionStateError(input.sessionId, "release", row.status, [
        "idle",
        "interrupted",
      ]);
    }
    setStatus(input.sessionId, "releasing");
    const handle = processes.get(input.sessionId);
    if (handle !== undefined) {
      handle.closeInput();
      if (!(await exitedWithin(handle, signalWaitMs))) {
        // Graceful exit did not happen; fall back to the signal order before
        // releasing the lock.
        await terminateProcess(handle);
      }
      processes.delete(input.sessionId);
      if (handle.transcriptPath !== undefined) {
        await waitForTranscriptStabilization(handle.transcriptPath);
      }
    }
    transaction(db, () => {
      locks.delete(input.sessionId);
    });
    setStatus(input.sessionId, "inactive");
  }

  // -------------------------------------------------------------------------
  // cancel (§7.5)
  // -------------------------------------------------------------------------

  async function cancel(input: { requestId: string }): Promise<void> {
    const record = await options.ledger.get(input.requestId);
    if (record === undefined) {
      throw new Error(`unknown requestId ${input.requestId}`);
    }
    if (record.status !== "accepted") {
      throw new CancelNotAllowedError(input.requestId, record.status);
    }
    // Design choice: a cancelled accepted command transitions accepted →
    // failed with result { cancelled: true }. `interrupted` is reserved for
    // commands that reached Claude and were cut short; a cancelled command
    // was never dispatched (§7.5: 已派发消息不能撤回，只能停止进程).
    await options.ledger.transitionWithStatusEvent(input.requestId, "failed", {
      now: now(),
      buildEventPayload: (rec) => ({
        requestId: rec.requestId,
        idempotencyKey: rec.idempotencyKey,
        commandType: rec.commandType,
        result: { cancelled: true },
      }),
    });
  }

  // -------------------------------------------------------------------------
  // recoverOnStartup (§7.6 steps 1–5)
  // -------------------------------------------------------------------------

  /**
   * Kill a persisted PID only while its start time still matches the recorded
   * identity; re-check identity before each signal (§7.6.3: 身份不匹配的 PID
   * 不执行信号操作). Returns true if the identity held throughout.
   */
  async function killPersistedProcess(
    pid: number,
    startedAt: number,
    controller: ProcessController,
  ): Promise<boolean> {
    for (const sig of STOP_SIGNAL_ORDER) {
      if (!controller.alive(pid) || controller.startedAt(pid) !== startedAt) return false;
      controller.kill(pid, sig);
      if (await pidExitedWithin(controller, pid, signalWaitMs)) return true;
    }
    return true;
  }

  async function pidExitedWithin(
    controller: ProcessController,
    pid: number,
    waitMs: number,
  ): Promise<boolean> {
    const pollMs = Math.max(1, Math.min(20, Math.floor(waitMs / 10)));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!controller.alive(pid)) return true;
      await sleep(pollMs);
    }
    return !controller.alive(pid);
  }

  async function recoverOnStartup(): Promise<void> {
    const controller = options.processController;
    // §7.6.1–3: expire locks held by other Bridge instances; kill their
    // processes only when the PID identity matches.
    for (const lock of locks.list()) {
      if (lock.bridgeInstanceId === options.bridgeInstanceId) continue;
      if (controller !== undefined && lock.processPid !== null && lock.processStartedAt !== null) {
        if (
          controller.alive(lock.processPid) &&
          controller.startedAt(lock.processPid) === lock.processStartedAt
        ) {
          await killPersistedProcess(lock.processPid, lock.processStartedAt, controller);
        }
      }
      locks.delete(lock.sessionId);
    }

    // §7.6.5: running/waiting_permission/interrupting sessions → interrupted
    // (running passes through interrupting per the state machine).
    const active = db
      .prepare(
        "SELECT sessionId, status FROM sessions WHERE status IN ('running','waiting_permission','interrupting')",
      )
      .all() as Array<{ sessionId: string; status: SessionStatus }>;
    for (const row of active) {
      if (row.status === "running") setStatus(row.sessionId, "interrupting");
      // §7.6.4: all old pending permission requests resolve as denied.
      await options.permissionBroker?.denyAllForSession(row.sessionId, "bridge restarted");
      setStatus(row.sessionId, "interrupted");
    }

    // §7.6.6 (dispatching/dispatched → indeterminate → transcript evidence)
    // is deliberately NOT done here: it requires the history adapter's
    // findTurnEvidence (Task 19). Call reconcileIndeterminateCommands after
    // the adapter is wired. `accepted` commands stay cancellable (§7.4).
  }

  // -------------------------------------------------------------------------
  // reconcileIndeterminateCommands (§7.6 step 6, called by Task 19 wiring)
  // -------------------------------------------------------------------------

  async function reconcileIndeterminateCommands(history: {
    findTurnEvidence(sessionId: string, uuid: string): Promise<TurnEvidence>;
  }): Promise<void> {
    const rows = db
      .prepare("SELECT requestId FROM commands WHERE status IN ('dispatching','dispatched')")
      .all() as Array<{ requestId: string }>;
    for (const { requestId } of rows) {
      const record = await options.ledger.get(requestId);
      if (record === undefined) continue;
      await moveToIndeterminate(record.requestId, record.sessionId);
      const evidence = await history.findTurnEvidence(record.sessionId, requestId);
      if (evidence.kind !== "turn") continue; // absent / unparseable: no guess
      await options.ledger.transitionWithStatusEvent(requestId, evidence.outcome, {
        now: now(),
        buildEventPayload: (rec) => ({
          requestId: rec.requestId,
          idempotencyKey: rec.idempotencyKey,
          commandType: rec.commandType,
          result: { reconciledFrom: "transcript" },
        }),
      });
    }
  }

  async function moveToIndeterminate(requestId: string, sessionId: string): Promise<void> {
    try {
      await options.ledger.transitionWithStatusEvent(requestId, "indeterminate", {
        now: now(),
        buildEventPayload: (rec) => ({
          requestId: rec.requestId,
          idempotencyKey: rec.idempotencyKey,
          commandType: rec.commandType,
        }),
      });
    } catch (error) {
      // Sessionless sync commands cannot carry a status event; fall back to a
      // bare transition so the ledger row still moves.
      if ((error as Error).name === "SessionlessTransitionError") {
        await options.ledger.transition(requestId, "indeterminate", { now: now() });
        return;
      }
      // Already-terminal (concurrently reconciled) rows are fine.
      if ((error as Error).name === "IllegalTransitionError") return;
      throw error;
    }
    void sessionId;
  }

  return {
    createSession,
    resumeSession,
    stop,
    release,
    cancel,
    recoverOnStartup,
    reconcileIndeterminateCommands,
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1; // missing file: treated as a distinct, stable size
  }
}
