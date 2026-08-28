/**
 * Standalone permission MCP adapter tests (Task 18, spec §6.4).
 *
 * The adapter is exercised as REALITY demands: a real child process spawned
 * as `<absolute node> <absolute main.mjs>` under a RESTRICTED PATH (Claude
 * Code spawns stdio MCP servers where npx/tsx do not resolve), speaking real
 * MCP over stdio, against a REAL Task-17 permission broker listening on a
 * real Unix socket. The only seam is the journal boundary the broker does
 * not own in this test (appended events are captured in-memory for lookup
 * while still being persisted through the real journal).
 *
 * Test areas (numbers refer to the task's five assertions):
 *  1. registers one tool whose input schema matches §6.4
 *  2. returns a single text content block with the JSON decided by the broker
 *  3. includes toolUseID only when the original request had tool_use_id
 *  4. lease secret failures close stdio without any MCP result
 *  5. unreachable bridge socket: deny "bridge_unavailable" + nonzero exit
 * plus the adapter-side hard timeout guard (broker silent past its wait),
 * concurrent decide calls sharing ONE broker connection (the single-use
 * lease forbids a second one), and correlated broker error frames denying
 * the affected pending call.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import {
  createEventJournal,
  type AppendOptions,
  type EventJournal,
} from "../../src/events/event-journal.js";
import { createPermissionBroker, type PermissionBroker } from "../../src/permissions/permission-broker.js";
import {
  createFrameDecoder,
  encodeFrame,
  isPlainObject,
} from "../../src/permissions/socket-protocol.js";

const ADAPTER_MAIN = fileURLToPath(
  new URL("../../src/permission-adapter/main.mjs", import.meta.url),
);
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const DEVICE_ID = "dev-adapter-test";
const LEASE_SECRET = "c".repeat(64);

const REQUEST_TIMEOUT_MS = 10_000;

interface JsonRpcResponse {
  readonly id?: number | string;
  readonly result?: {
    readonly tools?: ReadonlyArray<{ readonly name: string; readonly inputSchema?: unknown }>;
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  };
  readonly error?: { readonly message: string };
}

/**
 * Minimal MCP stdio client driving the adapter child process the way Claude
 * Code does: newline-delimited JSON-RPC 2.0 over the child's stdio.
 */
class McpStdioClient {
  private readonly lines: ReturnType<typeof createInterface>;
  private readonly waiters = new Map<number, (msg: JsonRpcResponse) => void>();
  /** Every numeric response id that ever arrived (answers must never arrive
   * in the fail-closed cases, so presence is observable). */
  readonly receivedIds = new Set<number>();
  stdoutText = "";
  stderrText = "";

  private readonly proc: ChildProcess;

  constructor(proc: ChildProcess) {
    this.proc = proc;
    this.lines = createInterface({ input: proc.stdout! });
    proc.stdout!.on("data", (chunk: Buffer) => {
      this.stdoutText += chunk.toString("utf8");
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8");
    });
    this.lines.on("line", (line: string) => {
      if (line.trim() === "") return;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return;
      this.receivedIds.add(msg.id);
      const waiter = this.waiters.get(msg.id);
      if (waiter !== undefined) {
        this.waiters.delete(msg.id);
        waiter(msg);
      }
    });
  }

  send(message: unknown): void {
    this.proc.stdin!.write(JSON.stringify(message) + "\n");
  }

  request(id: number, method: string, params?: unknown): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timed out waiting for the adapter's response to ${method} (id ${id})`));
      }, REQUEST_TIMEOUT_MS);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(): Promise<void> {
    const init = await this.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "permission-adapter-test", version: "0.0.0" },
    });
    expect(init.error).toBeUndefined();
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  close(): void {
    this.lines.close();
  }
}

let dir: string;
let socketPath: string;
let db: SqliteDatabase;
let journal: Pick<EventJournal, "append">;
let appended: AppendOptions[];
let broker: PermissionBroker | undefined;
let procs: ChildProcess[];
/** Raw test-side socket servers replacing the real broker in one test. */
let servers: net.Server[];

async function startBroker(timeoutMs = 60_000): Promise<PermissionBroker> {
  const started = createPermissionBroker({
    journal,
    socketPath,
    timeoutMs,
    sessionsForDevice: () => [],
    activeDeviceForSession: () => DEVICE_ID,
    terminateSessionProcess: () => {
      /* fail-closed hook: irrelevant here, the broker tests own it */
    },
  });
  await started.listen();
  started.registerLease(LEASE_SECRET, SESSION_ID);
  broker = started;
  return started;
}

/** Spawn the adapter exactly like the factory's MCP config does: absolute
 * node + absolute plain-ESM file, restricted PATH, env-only configuration. */
function spawnAdapter(envOverrides: Record<string, string | undefined> = {}): ChildProcess {
  const env: Record<string, string> = {
    // Restricted PATH mirrors Claude Code's stdio MCP spawn: nothing may be
    // resolved through npx/tsx.
    PATH: "/usr/bin:/bin",
    BRIDGE_PERMISSION_SOCKET: socketPath,
    BRIDGE_LEASE_SECRET: LEASE_SECRET,
    BRIDGE_SESSION_ID: SESSION_ID,
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const proc = spawn(process.execPath, [ADAPTER_MAIN], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  return proc;
}

function requestedPayloadFor(toolName: string): Record<string, unknown> | undefined {
  for (let i = appended.length - 1; i >= 0; i -= 1) {
    const entry = appended[i];
    if (entry === undefined || entry.eventType !== "permission.requested") continue;
    const payload = entry.payload as Record<string, unknown>;
    if (payload.toolName === toolName) return payload;
  }
  return undefined;
}

async function waitFor<T>(probe: () => T | undefined, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForExit(
  proc: ChildProcess,
  ms = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("adapter process did not exit in time")), ms);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Assert the §6.4 single-text-block contract and return the parsed JSON. */
function decisionJson(msg: JsonRpcResponse): Record<string, unknown> {
  expect(msg.error).toBeUndefined();
  const content = msg.result?.content;
  expect(content).toBeDefined();
  expect(content).toHaveLength(1);
  const block = content?.[0];
  expect(block?.type).toBe("text");
  expect(typeof block?.text).toBe("string");
  return JSON.parse(block!.text!) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "perm-adapter-"));
  socketPath = join(dir, "perm.sock");
  db = openDatabase(join(dir, "adapter-test.db"));
  migrate(db);
  db.prepare(
    `INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
     VALUES ('proj-1', '/tmp/proj-1', 1, 2, 'proj', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
     VALUES (?, 'proj-1', ?, 'idle', 'bridge', 0, 0)`,
  ).run(SESSION_ID, "adapter-test");
  const realJournal = createEventJournal(db, { retentionMs: 600_000, byteBudget: 64 * 1024 * 1024 });
  appended = [];
  journal = {
    append(opts: AppendOptions) {
      appended.push(opts);
      return realJournal.append(opts);
    },
  };
  broker = undefined;
  procs = [];
  servers = [];
});

afterEach(async () => {
  for (const proc of procs) {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await waitForExit(proc, 5_000).catch(() => undefined);
    }
  }
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await broker?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("permission-adapter main.mjs as a stdio MCP server", () => {
  it("registers one decide tool with the §6.4 schema and denies malformed input locally", async () => {
    await startBroker();
    const proc = spawnAdapter();
    const client = new McpStdioClient(proc);
    try {
      await client.initialize();
      const list = await client.request(2, "tools/list");
      expect(list.error).toBeUndefined();
      const tools = list.result?.tools ?? [];
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("decide");
      expect(tools[0]?.inputSchema).toEqual({
        type: "object",
        properties: {
          tool_name: { type: "string" },
          input: { type: "object" },
          tool_use_id: { type: "string" },
        },
        required: ["tool_name", "input"],
      });

      // Malformed tool input is denied by the adapter itself, without the
      // broker ever seeing a request for it.
      const before = appended.length;
      const bad = await client.request(3, "tools/call", {
        name: "decide",
        arguments: { tool_name: 7 },
      });
      expect(decisionJson(bad)).toEqual({
        behavior: "deny",
        message: "invalid permission request schema",
        interrupt: false,
      });
      expect(appended.length).toBe(before);
      // A local deny is not fatal: the server stays up.
      expect(proc.exitCode).toBeNull();
    } finally {
      client.close();
    }
  }, 30_000);

  it("returns the broker's decision as one text block; toolUseID only when the request had tool_use_id", async () => {
    const activeBroker = await startBroker();
    const proc = spawnAdapter();
    const client = new McpStdioClient(proc);
    try {
      await client.initialize();

      const allowCall = client.request(2, "tools/call", {
        name: "decide",
        arguments: { tool_name: "Bash", input: { command: "ls -la" }, tool_use_id: "toolu_01ABC" },
      });
      const allowRequest = await waitFor(() => requestedPayloadFor("Bash"));
      await activeBroker.resolve({
        permissionRequestId: allowRequest.permissionRequestId as string,
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        decision: { behavior: "allow" },
      });
      expect(decisionJson(await allowCall)).toEqual({
        behavior: "allow",
        updatedInput: { command: "ls -la" },
        toolUseID: "toolu_01ABC",
      });

      // Second call on the SAME adapter process: the broker connection is
      // reused (the lease secret is single-use, reconnecting is impossible).
      const denyCall = client.request(3, "tools/call", {
        name: "decide",
        arguments: { tool_name: "Write", input: { file_path: "/tmp/x", content: "y" } },
      });
      const denyRequest = await waitFor(() => requestedPayloadFor("Write"));
      await activeBroker.resolve({
        permissionRequestId: denyRequest.permissionRequestId as string,
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        decision: { behavior: "deny", message: "denied from the phone" },
      });
      const denied = decisionJson(await denyCall);
      expect(denied).toEqual({
        behavior: "deny",
        message: "denied from the phone",
        interrupt: false,
      });
      expect(Object.hasOwn(denied, "toolUseID")).toBe(false);
      expect(proc.exitCode).toBeNull();
    } finally {
      client.close();
    }
  }, 30_000);

  it("exits nonzero before any MCP traffic when the lease secret is missing", async () => {
    await startBroker();
    const proc = spawnAdapter({ BRIDGE_LEASE_SECRET: undefined });
    const client = new McpStdioClient(proc);
    try {
      const exit = await waitForExit(proc);
      expect(exit.code).not.toBe(0);
      // No MCP result may be emitted: Claude Code must see a bare pipe close.
      expect(client.stdoutText).not.toContain("jsonrpc");
    } finally {
      client.close();
    }
  }, 30_000);

  it("exits nonzero without a tool result when the broker rejects the lease", async () => {
    await startBroker();
    const wrongSecret = "f".repeat(64);
    const proc = spawnAdapter({ BRIDGE_LEASE_SECRET: wrongSecret });
    const client = new McpStdioClient(proc);
    try {
      await client.initialize();
      // Raw send (no awaited promise): in the fail-closed path this call must
      // NEVER be answered, and an unresolved request() would only time out
      // into an unhandled rejection after the test is done.
      client.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "decide", arguments: { tool_name: "Bash", input: { command: "ls" } } },
      });
      const exit = await waitForExit(proc);
      expect(exit.code).toBe(1);
      // The in-flight permission call got NO answer — only the pipe close,
      // which is the fail-closed path the Phase 0 gate verified.
      expect(client.receivedIds.has(2)).toBe(false);
      // The lease secret must never reach stderr.
      expect(client.stderrText).not.toContain(wrongSecret);
    } finally {
      client.close();
    }
  }, 30_000);

  it("answers deny bridge_unavailable and exits nonzero when the socket is unreachable", async () => {
    // No broker is started: the socket path points at nothing (ENOENT).
    const proc = spawnAdapter();
    const client = new McpStdioClient(proc);
    try {
      await client.initialize();
      const res = await client.request(2, "tools/call", {
        name: "decide",
        arguments: { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_X" },
      });
      expect(decisionJson(res)).toEqual({
        behavior: "deny",
        message: "bridge_unavailable",
        interrupt: false,
        toolUseID: "toolu_X",
      });
      const exit = await waitForExit(proc);
      expect(exit.code).toBe(1);
    } finally {
      client.close();
    }
  }, 30_000);

  it("denies bridge_unavailable on the adapter-side hard timeout when the broker stays silent", async () => {
    // Broker wait is 60 s; the adapter-side guard (test knob: 400 ms) must
    // fire first when the broker never answers.
    await startBroker(60_000);
    const proc = spawnAdapter({ BRIDGE_PERMISSION_ADAPTER_TIMEOUT_MS: "400" });
    const client = new McpStdioClient(proc);
    try {
      await client.initialize();
      const res = await client.request(2, "tools/call", {
        name: "decide",
        arguments: { tool_name: "Bash", input: { command: "ls" } },
      });
      expect(decisionJson(res)).toEqual({
        behavior: "deny",
        message: "bridge_unavailable",
        interrupt: false,
      });
      const exit = await waitForExit(proc);
      expect(exit.code).toBe(1);
    } finally {
      client.close();
    }
  }, 30_000);

  it("answers two CONCURRENT decide calls through one broker connection (single-use lease)", async () => {
    const activeBroker = await startBroker();
    const proc = spawnAdapter();
    const client = new McpStdioClient(proc);
    try {
      await client.initialize();

      // Both tools/call requests are written back-to-back BEFORE either
      // response is awaited: the MCP SDK dispatches them concurrently, so the
      // adapter's lazy broker connect must be serialized. The lease secret is
      // SINGLE-USE — two racing connections would both hello with it, the
      // broker would consume it on the first and destroy the second, losing a
      // healthy in-flight call (and quite possibly the process).
      const callA = client.request(2, "tools/call", {
        name: "decide",
        arguments: { tool_name: "Bash", input: { command: "ls a" }, tool_use_id: "toolu_AA" },
      });
      const callB = client.request(3, "tools/call", {
        name: "decide",
        arguments: { tool_name: "Write", input: { file_path: "/tmp/b", content: "x" } },
      });

      const requestA = await waitFor(() => requestedPayloadFor("Bash"));
      const requestB = await waitFor(() => requestedPayloadFor("Write"));
      await activeBroker.resolve({
        permissionRequestId: requestA.permissionRequestId as string,
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        decision: { behavior: "allow" },
      });
      await activeBroker.resolve({
        permissionRequestId: requestB.permissionRequestId as string,
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        decision: { behavior: "deny", message: "no writing" },
      });

      expect(decisionJson(await callA)).toEqual({
        behavior: "allow",
        updatedInput: { command: "ls a" },
        toolUseID: "toolu_AA",
      });
      expect(decisionJson(await callB)).toEqual({
        behavior: "deny",
        message: "no writing",
        interrupt: false,
      });

      // Both answered AND the adapter survived: a destroyed duplicate
      // connection would have scheduled a fatal exit (250 ms timer).
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(client.receivedIds.has(2)).toBe(true);
      expect(client.receivedIds.has(3)).toBe(true);
      expect(proc.exitCode).toBeNull();
    } finally {
      client.close();
    }
  }, 30_000);

  it("answers deny bridge_error when the broker sends an error frame correlated to the pending call", async () => {
    // The real broker only sends error frames for frames the adapter never
    // sends (the adapter validates §6.4 input locally, so its permission_
    // requests always pass broker validation, and it only aborts at teardown)
    // — but the protocol promises correlated error frames deny the affected
    // request (socket-protocol.ts), and the broker now populates
    // permissionRequestId where one is identifiable (tested in
    // permission-broker.test.ts). Exercise the adapter's side against a
    // minimal raw broker speaking the real frame protocol.
    const server = net.createServer((socket) => {
      const decoder = createFrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        let frames: unknown[];
        try {
          frames = decoder.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const frame of frames) {
          if (!isPlainObject(frame) || frame.type !== "permission_request") continue;
          // Reject the request the adapter just forwarded, correlated by id.
          socket.write(
            encodeFrame({
              type: "error",
              code: "invalid_request",
              message: "boom",
              permissionRequestId: frame.permissionRequestId,
            }),
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const proc = spawnAdapter();
    const client = new McpStdioClient(proc);
    try {
      await client.initialize();
      const res = await client.request(2, "tools/call", {
        name: "decide",
        arguments: { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_E" },
      });
      expect(decisionJson(res)).toEqual({
        behavior: "deny",
        message: "bridge_error: invalid_request: boom",
        interrupt: false,
        toolUseID: "toolu_E",
      });

      // A correlated error denies ONE call; the connection stays open and
      // the adapter keeps serving (no fatal exit was scheduled: 250 ms timer).
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(proc.exitCode).toBeNull();
    } finally {
      client.close();
    }
  }, 30_000);
});
