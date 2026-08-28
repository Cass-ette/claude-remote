/**
 * Permission broker tests (Task 17, spec §6.4 / §9 / §11.5).
 *
 * All adapter interactions go through REAL Unix domain sockets with real
 * length-prefixed JSON frames — the only fake is the boundary the broker
 * does not own (device→session lookup, subprocess termination).
 *
 * Test areas (numbers refer to the task's 12 assertions):
 *  1. lease-secret authentication; mismatch closes without response
 *  2. lease secret is single-use
 *  3. lease secret is session-bound
 *  4. pending request journaled + visible within 200 ms
 *  5. resolve from correct device+session; double resolve rejects
 *  6. timeout auto-deny
 *  7. denyAllForSession (session.stop)
 *  8. graceful shutdown denies everything
 *  9. device revocation denies pending
 * 10. allow returns input verbatim; deny carries message + interrupt:false
 * 11. fail-closed on adapter crash / undeliverable deny → terminate
 * 12. schema mismatch denies + terminates; malformed frames get error frames
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { createEventJournal, type EventJournal } from "../../src/events/event-journal.js";
import {
  createPermissionBroker,
  InvalidLeaseError,
  type PermissionBroker,
} from "../../src/permissions/permission-broker.js";
import {
  createFrameDecoder,
  encodeFrame,
  type BrokerFrame,
  type DecisionFrame,
} from "../../src/permissions/socket-protocol.js";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const DEVICE = "dev-active";
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const BAD_SECRET = "f".repeat(64);

let dir: string;
let socketPath: string;
let db: SqliteDatabase;
let journal: EventJournal;
let broker: PermissionBroker | undefined;
let terminated: Array<{ sessionId: string; reason: string }>;
let deviceSessions: Map<string, string[]>;
let adapters: TestAdapter[];
let idCounter: number;

function nextId(): string {
  idCounter += 1;
  return `perm-${idCounter}`;
}

async function makeBroker(opts: { timeoutMs?: number } = {}): Promise<PermissionBroker> {
  broker = createPermissionBroker({
    journal,
    socketPath,
    timeoutMs: opts.timeoutMs ?? 60_000,
    sessionsForDevice: (deviceId) => deviceSessions.get(deviceId) ?? [],
    activeDeviceForSession: () => DEVICE,
    terminateSessionProcess: (sessionId, reason) => {
      terminated.push({ sessionId, reason });
    },
    generateId: nextId,
  });
  await broker.listen();
  return broker;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "perm-broker-"));
  socketPath = join(dir, "perm.sock");
  db = openDatabase(join(dir, "test.db"));
  migrate(db);
  db.prepare(
    `INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
     VALUES ('proj-1', '/tmp/proj-1', 1, 2, 'proj', 0, 0)`,
  ).run();
  const insertSession = db.prepare(
    `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
     VALUES (?, 'proj-1', ?, 'idle', 'bridge', 0, 0)`,
  );
  insertSession.run(SESSION_A, "a");
  insertSession.run(SESSION_B, "b");
  journal = createEventJournal(db, { retentionMs: 600_000, byteBudget: 64 * 1024 * 1024 });
  terminated = [];
  deviceSessions = new Map([[DEVICE, [SESSION_A, SESSION_B]]]);
  adapters = [];
  idCounter = 0;
  broker = undefined;
});

afterEach(async () => {
  for (const adapter of adapters) adapter.destroy();
  await broker?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test-side adapter: a real socket client speaking the frame protocol.
// ---------------------------------------------------------------------------

class TestAdapter {
  private socket: net.Socket | undefined;
  private decoder = createFrameDecoder();
  private readonly buffered: BrokerFrame[] = [];
  private readonly frameWaiters: Array<(frame: BrokerFrame) => void> = [];
  private readonly closeWaiters: Array<() => void> = [];
  private closedFlag = false;
  frameCount = 0;

  async connect(leaseSecret: string, sessionId: string): Promise<void> {
    const socket = net.connect(socketPath);
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = this.decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        this.frameCount += 1;
        const waiter = this.frameWaiters.shift();
        if (waiter !== undefined) waiter(frame as BrokerFrame);
        else this.buffered.push(frame as BrokerFrame);
      }
    });
    socket.on("close", () => {
      this.closedFlag = true;
      for (const waiter of this.closeWaiters.splice(0)) waiter();
    });
    socket.on("error", () => {
      /* close always follows; surfaced via waitClosed() */
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    this.send({ type: "hello", leaseSecret, sessionId });
  }

  send(frame: unknown): void {
    if (this.socket === undefined || !this.socket.writable) {
      throw new Error("test adapter socket is not connected");
    }
    this.socket.write(encodeFrame(frame));
  }

  /** Write raw bytes (garbage-JSON / protocol-abuse cases). */
  sendRaw(bytes: Buffer): void {
    this.socket?.write(bytes);
  }

  async nextFrame(timeoutMs = 2000): Promise<BrokerFrame> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) return buffered;
    return new Promise<BrokerFrame>((resolve, reject) => {
      let waiter!: (frame: BrokerFrame) => void;
      const timer = setTimeout(() => {
        // Remove the dead waiter or it would swallow the NEXT frame.
        const index = this.frameWaiters.indexOf(waiter);
        if (index >= 0) this.frameWaiters.splice(index, 1);
        reject(new Error(`no frame within ${timeoutMs}ms`));
      }, timeoutMs);
      waiter = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.frameWaiters.push(waiter);
    });
  }

  async waitClosed(timeoutMs = 2000): Promise<boolean> {
    if (this.closedFlag) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.closedFlag;
  }

  destroy(): void {
    this.socket?.destroy();
  }
}

function openAdapter(leaseSecret: string, sessionId: string): Promise<TestAdapter> {
  const adapter = new TestAdapter();
  adapters.push(adapter);
  return adapter.connect(leaseSecret, sessionId).then(async () => {
    // connect() resolves on TCP establishment; give the broker a few event
    // loop turns to process the hello frame so the session connection is
    // bound before the test calls broker.request() directly.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return adapter;
  });
}

/** Send one permission_request over the socket and await its registration. */
async function submit(
  adapter: TestAdapter,
  input: { toolName: string; input: Record<string, unknown>; toolUseId?: string },
): Promise<string> {
  adapter.send({ type: "permission_request", ...input });
  const frame = await adapter.nextFrame();
  if (frame.type !== "request_registered") {
    throw new Error(`expected request_registered, got ${JSON.stringify(frame)}`);
  }
  return frame.permissionRequestId;
}

function journalPayloads(eventType: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const sessionId of [SESSION_A, SESSION_B]) {
    for (const event of journal.replayAfter(sessionId, 0n)) {
      if (event.eventType !== eventType) continue;
      out.push((JSON.parse(event.payloadJson) as { payload: Record<string, unknown> }).payload);
    }
  }
  return out;
}

async function decisionFrameOf(adapter: TestAdapter): Promise<DecisionFrame> {
  const frame = await adapter.nextFrame();
  if (frame.type !== "decision") {
    throw new Error(`expected decision frame, got ${JSON.stringify(frame)}`);
  }
  return frame;
}

// ---------------------------------------------------------------------------

describe("permission broker", () => {
  it("listens on a 0600 unix socket at the configured path", async () => {
    await makeBroker();
    expect(existsSync(socketPath)).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("destroys the connection when the first frame is not a hello", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = new TestAdapter();
    adapters.push(adapter);
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(encodeFrame({ type: "permission_request", toolName: "Bash", input: {} }));
    socket.destroy();
    // No crash, broker still serves a proper hello afterwards.
    const ok = await openAdapter(SECRET_A, SESSION_A);
    expect(await submit(ok, { toolName: "Bash", input: { command: "ls" } })).toBeTruthy();
  });

  // Area 1 — lease secret authentication.
  it("authenticates the per-process lease secret; mismatch closes without response", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);

    // Correct secret: a request flows through (authentication succeeded).
    const adapter = await openAdapter(SECRET_A, SESSION_A);
    const id = await submit(adapter, { toolName: "Bash", input: { command: "ls" } });
    expect(id).toMatch(/^perm-/);

    // Mismatched secret: socket closed, zero frames back.
    const bad = new TestAdapter();
    adapters.push(bad);
    await bad.connect(BAD_SECRET, SESSION_A);
    expect(await bad.waitClosed()).toBe(true);
    expect(bad.frameCount).toBe(0);
  });

  // Area 2 — single use.
  it("consumes the lease secret on first use; a second connection is rejected", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);

    const first = await openAdapter(SECRET_A, SESSION_A);
    expect(await submit(first, { toolName: "Read", input: { file_path: "/tmp/x" } })).toBeTruthy();

    const second = new TestAdapter();
    adapters.push(second);
    await second.connect(SECRET_A, SESSION_A);
    expect(await second.waitClosed()).toBe(true);
    expect(second.frameCount).toBe(0);

    // Still single-use after the legitimate adapter disconnects.
    first.destroy();
    expect(await first.waitClosed()).toBe(true);
    const third = new TestAdapter();
    adapters.push(third);
    await third.connect(SECRET_A, SESSION_A);
    expect(await third.waitClosed()).toBe(true);
    expect(third.frameCount).toBe(0);
  });

  // Area 3 — session binding.
  it("rejects a lease secret registered for session A when presented for session B", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const evil = new TestAdapter();
    adapters.push(evil);
    await evil.connect(SECRET_A, SESSION_B);
    expect(await evil.waitClosed()).toBe(true);
    expect(evil.frameCount).toBe(0);
  });

  // Area 4 — journaled and visible within 200 ms.
  it("stores the pending request in pending_events, visible within 200 ms", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = await openAdapter(SECRET_A, SESSION_A);

    const startedAt = Date.now();
    const id = await submit(adapter, {
      toolName: "Bash",
      input: { command: "git status" },
      toolUseId: "toolu-1",
    });
    expect(Date.now() - startedAt).toBeLessThan(200);

    const requested = journalPayloads("permission.requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      permissionRequestId: id,
      toolName: "Bash",
      toolUseId: "toolu-1",
      displayCategory: "command_execution",
    });
    expect(requested[0]!.input).toEqual({ command: "git status" });
    expect(typeof requested[0]!.expiresAt).toBe("string");
  });

  // Area 5 — resolve happy path + rejects.
  it("resolves from the correct device+session; rejects repeat, wrong session, wrong device", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = await openAdapter(SECRET_A, SESSION_A);
    const id = await submit(adapter, { toolName: "Bash", input: { command: "ls" } });

    await broker!.resolve({
      permissionRequestId: id,
      sessionId: SESSION_A,
      deviceId: DEVICE,
      decision: { behavior: "deny", message: "not on my watch" },
    });
    const denied = await decisionFrameOf(adapter);
    expect(denied.behavior).toBe("deny");
    expect(denied).toMatchObject({
      permissionRequestId: id,
      message: "not on my watch",
      interrupt: false,
    });

    // Same request twice: the second resolve is rejected (already resolved).
    await expect(
      broker!.resolve({
        permissionRequestId: id,
        sessionId: SESSION_A,
        deviceId: DEVICE,
        decision: { behavior: "allow" },
      }),
    ).rejects.toThrow(/unknown|resolved/i);

    // Wrong session rejects.
    const id2 = await submit(adapter, { toolName: "Read", input: { file_path: "/tmp/f" } });
    await expect(
      broker!.resolve({
        permissionRequestId: id2,
        sessionId: SESSION_B,
        deviceId: DEVICE,
        decision: { behavior: "allow" },
      }),
    ).rejects.toThrow(/session/i);

    // Wrong device rejects (spec §11.5).
    await expect(
      broker!.resolve({
        permissionRequestId: id2,
        sessionId: SESSION_A,
        deviceId: "dev-evil",
        decision: { behavior: "allow" },
      }),
    ).rejects.toThrow(/device/i);

    // The correct device+session can still resolve it.
    await broker!.resolve({
      permissionRequestId: id2,
      sessionId: SESSION_A,
      deviceId: DEVICE,
      decision: { behavior: "allow" },
    });
    const allowed = await decisionFrameOf(adapter);
    expect(allowed.behavior).toBe("allow");
  });

  // Area 6 — timeout.
  it("auto-denies when the wait timer expires", async () => {
    await makeBroker({ timeoutMs: 50 });
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = await openAdapter(SECRET_A, SESSION_A);
    const id = await submit(adapter, { toolName: "Bash", input: { command: "sleep 1" } });

    const frame = await decisionFrameOf(adapter);
    expect(frame.behavior).toBe("deny");
    expect(frame).toMatchObject({
      permissionRequestId: id,
      message: "permission timeout",
      interrupt: false,
    });

    const resolved = journalPayloads("permission.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      permissionRequestId: id,
      behavior: "deny",
      reason: "timeout",
    });

    // The deny WAS delivered to the adapter: no subprocess termination.
    expect(terminated).toEqual([]);
  });

  // Area 7 — session stop.
  it("denyAllForSession denies only that session's pending requests", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    broker!.registerLease(SECRET_B, SESSION_B);
    const adapterA = await openAdapter(SECRET_A, SESSION_A);
    const adapterB = await openAdapter(SECRET_B, SESSION_B);

    const idA1 = await submit(adapterA, { toolName: "Bash", input: { command: "a1" } });
    const idA2 = await submit(adapterA, { toolName: "Write", input: { file_path: "/tmp/a2" } });
    const idB = await submit(adapterB, { toolName: "Read", input: { file_path: "/tmp/b" } });

    await broker!.denyAllForSession(SESSION_A, "session stopped");

    const d1 = await decisionFrameOf(adapterA);
    const d2 = await decisionFrameOf(adapterA);
    expect(d1).toMatchObject({ permissionRequestId: idA1, behavior: "deny", message: "session stopped" });
    expect(d2).toMatchObject({ permissionRequestId: idA2, behavior: "deny", message: "session stopped" });

    // Session B is untouched: no frame, and its request is still resolvable.
    await expect(adapterB.nextFrame(150)).rejects.toThrow(/no frame/);
    await broker!.resolve({
      permissionRequestId: idB,
      sessionId: SESSION_B,
      deviceId: DEVICE,
      decision: { behavior: "allow" },
    });
    const okB = await decisionFrameOf(adapterB);
    expect(okB).toMatchObject({ permissionRequestId: idB, behavior: "allow" });

    const resolved = journalPayloads("permission.resolved");
    expect(resolved.filter((p) => p.reason === "session_stopped")).toHaveLength(2);
    expect(terminated).toEqual([]);
  });

  // Area 8 — graceful shutdown.
  it("close() denies every pending request and stops listening", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    broker!.registerLease(SECRET_B, SESSION_B);
    const adapterA = await openAdapter(SECRET_A, SESSION_A);
    const adapterB = await openAdapter(SECRET_B, SESSION_B);
    const idA = await submit(adapterA, { toolName: "Bash", input: { command: "a" } });
    const idB = await submit(adapterB, { toolName: "Bash", input: { command: "b" } });

    await broker!.close();

    expect(await decisionFrameOf(adapterA)).toMatchObject({
      permissionRequestId: idA,
      behavior: "deny",
      message: "bridge shutdown",
    });
    expect(await decisionFrameOf(adapterB)).toMatchObject({
      permissionRequestId: idB,
      behavior: "deny",
      message: "bridge shutdown",
    });
    expect(existsSync(socketPath)).toBe(false);

    // Idempotent; post-close resolves are rejected.
    await broker!.close();
    await expect(
      broker!.resolve({
        permissionRequestId: idA,
        sessionId: SESSION_A,
        deviceId: DEVICE,
        decision: { behavior: "allow" },
      }),
    ).rejects.toThrow(/unknown|resolved/i);
  });

  // Area 9 — device revocation.
  it("denyAllForDevice denies pending requests of that device's sessions", async () => {
    deviceSessions = new Map([[DEVICE, [SESSION_A]]]); // session B has no device
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    broker!.registerLease(SECRET_B, SESSION_B);
    const adapterA = await openAdapter(SECRET_A, SESSION_A);
    const adapterB = await openAdapter(SECRET_B, SESSION_B);
    const idA = await submit(adapterA, { toolName: "Bash", input: { command: "a" } });
    const idB = await submit(adapterB, { toolName: "Bash", input: { command: "b" } });

    await broker!.denyAllForDevice(DEVICE, "device revoked");

    expect(await decisionFrameOf(adapterA)).toMatchObject({
      permissionRequestId: idA,
      behavior: "deny",
      message: "device revoked",
    });
    await expect(adapterB.nextFrame(150)).rejects.toThrow(/no frame/);

    // Session B (not bound to the revoked device) still resolves.
    await broker!.resolve({
      permissionRequestId: idB,
      sessionId: SESSION_B,
      deviceId: DEVICE,
      decision: { behavior: "allow" },
    });
    expect((await decisionFrameOf(adapterB)).behavior).toBe("allow");
    expect(terminated).toEqual([]);
  });

  // Area 10 — verbatim allow / deny shape.
  it("allow returns the original input verbatim; deny carries message and interrupt:false", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = await openAdapter(SECRET_A, SESSION_A);
    const input = {
      command: "rm -rf /tmp/x",
      z: 1,
      opts: { b: [1, 2, { deep: true }], a: "keep-order" },
    };

    const decisionPromise = broker!.request({ sessionId: SESSION_A, toolName: "Bash", input });
    const registered = await adapter.nextFrame();
    expect(registered).toMatchObject({ type: "request_registered", permissionRequestId: "perm-1" });

    await broker!.resolve({
      permissionRequestId: "perm-1",
      sessionId: SESSION_A,
      deviceId: DEVICE,
      decision: { behavior: "allow" },
    });

    const decision = await decisionPromise;
    expect(decision.behavior).toBe("allow");
    if (decision.behavior !== "allow") throw new Error("unreachable");
    // VERBATIM: byte-identical serialization, key order included.
    expect(JSON.stringify(decision.updatedInput)).toBe(JSON.stringify(input));
    const frame = await decisionFrameOf(adapter);
    if (frame.behavior !== "allow") throw new Error("expected allow frame");
    expect(JSON.stringify(frame.updatedInput)).toBe(JSON.stringify(input));

    // Deny shape: user message, interrupt always false.
    const denyPromise = broker!.request({
      sessionId: SESSION_A,
      toolName: "Bash",
      input: { command: "x" },
    });
    await adapter.nextFrame(); // request_registered
    await broker!.resolve({
      permissionRequestId: "perm-2",
      sessionId: SESSION_A,
      deviceId: DEVICE,
      decision: { behavior: "deny", message: "user says no" },
    });
    expect(await denyPromise).toEqual({
      behavior: "deny",
      message: "user says no",
      interrupt: false,
    });
  });

  // Area 11 — fail closed on adapter loss / undeliverable deny.
  it("denies pending on adapter crash and terminates the process when the deny is undeliverable", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = await openAdapter(SECRET_A, SESSION_A);

    const decisionPromise = broker!.request({
      sessionId: SESSION_A,
      toolName: "Bash",
      input: { command: "long-running" },
    });
    await adapter.nextFrame(); // request_registered

    // Adapter crash: socket destroyed under the broker.
    adapter.destroy();
    const decision = await decisionPromise;
    expect(decision).toEqual({
      behavior: "deny",
      message: "permission adapter disconnected",
      interrupt: false,
    });
    // The deny could not be delivered → the bound Claude process group dies.
    expect(terminated).toContainEqual({
      sessionId: SESSION_A,
      reason: expect.stringContaining("undeliverable"),
    });
  });

  it("terminates the process when the broker is reachable but no adapter can receive the decision", async () => {
    await makeBroker();
    // In-process adapter connection (registerAdapter without a socket):
    // broker-reachable, but the decision has nowhere to be written.
    broker!.registerLease(SECRET_B, SESSION_B);
    const conn = await broker!.registerAdapter(SECRET_B, SESSION_B);

    const decisionPromise = broker!.request({
      sessionId: SESSION_B,
      toolName: "Read",
      input: { file_path: "/tmp/f" },
    });
    await broker!.resolve({
      permissionRequestId: "perm-1",
      sessionId: SESSION_B,
      deviceId: DEVICE,
      decision: { behavior: "allow" },
    });
    await decisionPromise;
    expect(terminated.some((t) => t.sessionId === SESSION_B)).toBe(true);

    // An explicit connection close with a pending request fails closed too.
    const pending2 = broker!.request({ sessionId: SESSION_B, toolName: "Read", input: {} });
    conn.close("adapter exiting");
    expect(await pending2).toMatchObject({ behavior: "deny" });
    expect(terminated.filter((t) => t.sessionId === SESSION_B).length).toBeGreaterThanOrEqual(2);
  });

  // Area 12 — schema mismatch / malformed frames.
  it("treats an invalid decision schema as deny + subprocess termination", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = await openAdapter(SECRET_A, SESSION_A);

    for (const badDecision of [{}, { behavior: "explode" }, null]) {
      const decisionPromise = broker!.request({
        sessionId: SESSION_A,
        toolName: "Bash",
        input: { command: "x" },
      });
      await adapter.nextFrame(); // request_registered
      const id = `perm-${idCounter}`;
      await expect(
        broker!.resolve({
          permissionRequestId: id,
          sessionId: SESSION_A,
          deviceId: DEVICE,
          decision: badDecision,
        }),
      ).rejects.toThrow(/behavior/i);
      const decision = await decisionPromise;
      expect(decision.behavior).toBe("deny");
      if (decision.behavior !== "deny") throw new Error("unreachable");
      expect(decision.message).toMatch(/invalid/i);
      expect(decision.interrupt).toBe(false);
      const frame = await decisionFrameOf(adapter);
      expect(frame.behavior).toBe("deny");
    }
    // The broken decision path terminates the subprocess (fail closed).
    expect(terminated.some((t) => t.sessionId === SESSION_A)).toBe(true);
  });

  it("answers malformed adapter frames with error frames and destroys non-JSON streams", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = await openAdapter(SECRET_A, SESSION_A);

    // Missing toolName.
    adapter.send({ type: "permission_request", input: { command: "x" } });
    const err1 = (await adapter.nextFrame()) as { type: string; code: string };
    expect(err1.type).toBe("error");
    expect(err1.code).toBe("invalid_request");

    // Non-object input.
    adapter.send({ type: "permission_request", toolName: "Bash", input: "ls -la" });
    const err2 = (await adapter.nextFrame()) as { type: string; code: string };
    expect(err2.type).toBe("error");
    expect(err2.code).toBe("invalid_request");

    // Unknown frame type.
    adapter.send({ type: "definitely_not_a_frame" });
    const err3 = (await adapter.nextFrame()) as { type: string; code: string };
    expect(err3.type).toBe("error");

    // Nothing was registered and nothing was terminated.
    expect(journalPayloads("permission.requested")).toHaveLength(0);
    expect(terminated).toEqual([]);

    // Garbage bytes: connection destroyed.
    const garbage = Buffer.alloc(4 + 5);
    garbage.writeUInt32BE(5, 0);
    garbage.write("not{(", 4);
    adapter.sendRaw(garbage);
    expect(await adapter.waitClosed()).toBe(true);
  });

  // -- async-error / sync-throw hardening -----------------------------------

  it("rejects (never throws synchronously) on invalid direct input or lease", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);

    // request() validation errors must surface as rejections so that
    // `broker.request(...).catch(...)` callers never crash.
    await expect(
      broker!.request({ sessionId: "", toolName: "Bash", input: {} }),
    ).rejects.toThrow(/sessionId/);
    await expect(
      broker!.request({
        sessionId: SESSION_A,
        toolName: "Bash",
        input: "ls" as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/input/);

    // registerAdapter() lease failures likewise reject.
    await expect(broker!.registerAdapter(BAD_SECRET, SESSION_A)).rejects.toThrow(
      InvalidLeaseError,
    );
  });

  // -- abort frames ----------------------------------------------------------

  it("resolves the adapter's own abort as a denied decision and journals it", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = await openAdapter(SECRET_A, SESSION_A);
    const id = await submit(adapter, { toolName: "Bash", input: { command: "x" } });

    adapter.send({ type: "abort", permissionRequestId: id });

    const frame = await decisionFrameOf(adapter);
    expect(frame.behavior).toBe("deny");
    expect(frame).toMatchObject({
      permissionRequestId: id,
      message: "aborted by permission adapter",
      interrupt: false,
    });
    expect(journalPayloads("permission.resolved")).toMatchObject([
      { permissionRequestId: id, behavior: "deny", reason: "aborted" },
    ]);
    // The deny was delivered to the (still open) adapter: no termination.
    expect(terminated).toEqual([]);
  });

  it("answers an abort for ANOTHER connection's request with unknown_permission_request", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    broker!.registerLease(SECRET_B, SESSION_B);
    const adapterA = await openAdapter(SECRET_A, SESSION_A);
    const adapterB = await openAdapter(SECRET_B, SESSION_B);
    const idB = await submit(adapterB, { toolName: "Bash", input: { command: "b" } });

    // Adapter A tries to abort adapter B's request.
    adapterA.send({ type: "abort", permissionRequestId: idB });
    const err = (await adapterA.nextFrame()) as { type: string; code: string };
    expect(err.type).toBe("error");
    expect(err.code).toBe("unknown_permission_request");

    // B's pending was untouched: still resolvable and deliverable.
    await broker!.resolve({
      permissionRequestId: idB,
      sessionId: SESSION_B,
      deviceId: DEVICE,
      decision: { behavior: "allow" },
    });
    expect((await decisionFrameOf(adapterB)).behavior).toBe("allow");
    expect(terminated).toEqual([]);
  });

  it("answers an abort for a nonexistent request id with unknown_permission_request", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter = await openAdapter(SECRET_A, SESSION_A);

    adapter.send({ type: "abort", permissionRequestId: "never-existed" });
    const err = (await adapter.nextFrame()) as { type: string; code: string };
    expect(err.type).toBe("error");
    expect(err.code).toBe("unknown_permission_request");
    expect(terminated).toEqual([]);
  });

  // -- adapter replacement -----------------------------------------------------

  it("denies the replaced adapter's pending WITHOUT terminating; the new adapter is unaffected", async () => {
    await makeBroker();
    broker!.registerLease(SECRET_A, SESSION_A);
    const adapter1 = await openAdapter(SECRET_A, SESSION_A);

    const decisionPromise = broker!.request({
      sessionId: SESSION_A,
      toolName: "Bash",
      input: { command: "old-process" },
    });
    await adapter1.nextFrame(); // request_registered

    // A fresh process (new lease, same session) takes over the connection.
    broker!.registerLease(SECRET_B, SESSION_A);
    const adapter2 = await openAdapter(SECRET_B, SESSION_A);

    const decision = await decisionPromise;
    expect(decision).toEqual({
      behavior: "deny",
      message: "session adapter replaced",
      interrupt: false,
    });

    // THE regression this guards: terminateSessionProcess is keyed by
    // sessionId only, which by now belongs to the FRESH process — the
    // replacement must not kill it.
    expect(terminated).toEqual([]);

    const replaced = journalPayloads("permission.resolved").find(
      (p) => p.permissionRequestId === "perm-1",
    );
    expect(replaced).toMatchObject({
      behavior: "deny",
      reason: "adapter_disconnected",
      message: "session adapter replaced",
    });

    // Old socket reclaimed; the new adapter works end to end.
    expect(await adapter1.waitClosed()).toBe(true);
    const id2 = await submit(adapter2, { toolName: "Read", input: { file_path: "/tmp/new" } });
    await broker!.resolve({
      permissionRequestId: id2,
      sessionId: SESSION_A,
      deviceId: DEVICE,
      decision: { behavior: "allow" },
    });
    expect((await decisionFrameOf(adapter2)).behavior).toBe("allow");
    expect(terminated).toEqual([]);
  });

  // NOTE (socket.write async-error path): sendToConnection routes write
  // COMPLETION errors into closeConnection (deny-pending +
  // terminate-if-current), but that path is not deterministically testable
  // here: the broker-side socket is never handed out to tests, and with real
  // Unix sockets the kernel surfaces peer death via the socket 'close' event
  // before (and indistinguishably from) any pending write callback, so a test
  // would race rather than assert. The synchronous guards (destroyed /
  // non-writable / write-throw) and the close-event fail-closed path are
  // covered by the adapter-crash tests above; the callback shares their
  // closeConnection code path.
});
