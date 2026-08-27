// Task 16 Step 4: process-lease-wrapper tests + real process-factory tests.
//
// Spec §7.6: every Claude child is watched by an OUT-OF-PROCESS lease
// watcher. When the Bridge's control FIFO closes (Bridge crash simulation),
// the watcher escalates SIGINT → SIGTERM → SIGKILL against the Claude process
// GROUP. When Claude exited cleanly first, the watcher exits without
// signalling. All tests use real child processes and a short --wait-ms 100.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveMkfifoPath,
  startProcessLeaseWrapper,
  type ProcessLease,
} from "../../src/claude/process-lease-wrapper.js";
import {
  ENV_REDACT_KEYS,
  createRealProcessFactory,
  generateLeaseSecret,
  generateMcpConfig,
  redactEnv,
  resolveExecutableFromPath,
} from "../../src/claude/process-factory.js";
import type { ClaudeProcessHandle } from "../../src/sessions/session-supervisor.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fakeClaudePath = join(here, "../fixtures/fake-claude.mjs");
const pidLoggingSleeperPath = join(here, "pid-logging-sleeper.mjs");

const WATCH_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface FakeChild {
  pid: number;
  stdin: { end(): void };
  exit: Promise<{ code: number | null; signal: string | null }>;
}

function spawnFakeDetached(extraArgs: string[]): FakeChild {
  const child = spawn(process.execPath, [fakeClaudePath, ...extraArgs], {
    detached: true, // own process group, exactly as the factory spawns Claude
    stdio: ["pipe", "ignore", "ignore"],
  });
  if (child.pid === undefined || child.stdin === null) throw new Error("fake-claude failed to spawn");
  const exit = once(child, "exit").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as string | null,
  }));
  // Reap the detached child so it never lingers as a zombie.
  child.unref();
  return { pid: child.pid, stdin: child.stdin, exit };
}

describe("process lease wrapper (real processes)", () => {
  let workdir: string;
  let leases: ProcessLease[];

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "bridge-lease-test-"));
    leases = [];
  });

  afterEach(() => {
    for (const lease of leases) {
      try {
        lease.close();
        lease.cleanup();
      } catch {
        // already torn down
      }
    }
    rmSync(workdir, { recursive: true, force: true });
  });

  function fifoPath(): string {
    const path = join(workdir, "leases", `${randomUUID()}.fifo`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return path;
  }

  it(
    "Bridge death (write end closes while Claude lives) escalates SIGINT to the group",
    async () => {
      const signalsLog = join(workdir, "signals.log");
      const fake = spawnFakeDetached(["--signals-log", signalsLog]);
      const lease = startProcessLeaseWrapper({ fifoPath: fifoPath(), claudePid: fake.pid, waitMs: WATCH_MS });
      leases.push(lease);

      // Watcher is up and the FIFO exists while the Bridge holds the write end.
      await sleep(150);
      expect(existsSync(lease.fifoPath)).toBe(true);
      expect(existsSync(signalsLog)).toBe(false);

      // Simulate Bridge death: the only write end closes.
      lease.close();
      const [fakeExit, watcherCode] = await Promise.all([fake.exit, lease.exited()]);

      // The fake HANDLES SIGINT (logs it, exits 0), so the proof of group
      // signal delivery is the fake's own signal log, not its exit signal.
      expect(readFileSync(signalsLog, "utf8").trim()).toBe("SIGINT");
      expect(fakeExit.code).toBe(0);
      expect(watcherCode).toBe(0);
      lease.cleanup();
      expect(existsSync(lease.fifoPath)).toBe(false);
    },
    15_000,
  );

  it(
    "clean Claude exit: closing the write end afterwards sends no signals",
    async () => {
      const signalsLog = join(workdir, "signals.log");
      const fake = spawnFakeDetached(["--signals-log", signalsLog]);
      const lease = startProcessLeaseWrapper({ fifoPath: fifoPath(), claudePid: fake.pid, waitMs: WATCH_MS });
      leases.push(lease);

      // Claude exits on its own (stdin EOF), while the Bridge still lives.
      fake.stdin.end();
      const fakeExit = await fake.exit;
      expect(fakeExit.signal).toBe(null);

      lease.close();
      const watcherCode = await lease.exited();
      expect(watcherCode).toBe(0);
      expect(existsSync(signalsLog)).toBe(false);
      lease.cleanup();
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// process-factory pure helpers
// ---------------------------------------------------------------------------

describe("generateMcpConfig", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "bridge-factory-test-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("writes the per-session MCP config with absolute node path and lease env", async () => {
    const fakeAdapter = join(workdir, "fake-permission-adapter.mjs");
    writeFileSync(fakeAdapter, "// tiny fake MCP adapter entry\nexport {};\n", "utf8");
    const sessionId = randomUUID();
    const leaseSecret = generateLeaseSecret();
    const socketPath = join(workdir, "permission.sock");

    const configPath = generateMcpConfig({
      dataDir: workdir,
      sessionId,
      adapterEntry: fakeAdapter,
      env: {
        BRIDGE_LEASE_SECRET: leaseSecret,
        BRIDGE_PERMISSION_SOCKET: socketPath,
        BRIDGE_SESSION_ID: sessionId,
      },
    });

    expect(configPath).toBe(join(workdir, "mcp", `${sessionId}.json`));
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      mcpServers: {
        claude_remote_permission: {
          // Claude spawns MCP servers with a restricted PATH: the command must
          // be the absolute node binary and the entry an absolute JS path.
          command: process.execPath,
          args: [fakeAdapter],
          env: {
            BRIDGE_LEASE_SECRET: leaseSecret,
            BRIDGE_PERMISSION_SOCKET: socketPath,
            BRIDGE_SESSION_ID: sessionId,
          },
        },
      },
    });
  });

  it("rejects a relative adapter entry", () => {
    expect(() =>
      generateMcpConfig({
        dataDir: "/tmp/bridge-x",
        sessionId: "sid",
        adapterEntry: "relative/adapter.mjs",
        env: { BRIDGE_LEASE_SECRET: "s", BRIDGE_PERMISSION_SOCKET: "/s", BRIDGE_SESSION_ID: "sid" },
      }),
    ).toThrow(/absolute/);
  });
});

describe("lease secret and env redaction", () => {
  it("generates a fresh 256-bit hex secret", () => {
    const a = generateLeaseSecret();
    const b = generateLeaseSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("redactEnv masks the lease secret and leaks it nowhere", () => {
    const secret = generateLeaseSecret();
    const masked = redactEnv({
      BRIDGE_LEASE_SECRET: secret,
      BRIDGE_PERMISSION_SOCKET: "/run/bridge/perm.sock",
      PATH: "/usr/bin:/bin",
    });
    expect(ENV_REDACT_KEYS).toContain("BRIDGE_LEASE_SECRET");
    expect(masked.BRIDGE_LEASE_SECRET).not.toBe(secret);
    expect(JSON.stringify(masked)).not.toContain(secret);
    expect(masked.PATH).toBe("/usr/bin:/bin");
    expect(masked.BRIDGE_PERMISSION_SOCKET).toBe("/run/bridge/perm.sock");
  });
});

describe("resolveExecutableFromPath", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "bridge-resolve-test-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("resolves an executable from PATH and reports misses", () => {
    const binPath = join(workdir, "claude");
    writeFileSync(binPath, "#!/bin/sh\n", "utf8");
    chmodSync(binPath, 0o755);
    expect(resolveExecutableFromPath("claude", { PATH: workdir })).toBe(binPath);
    expect(resolveExecutableFromPath("claude", { PATH: "/definitely/not/here" })).toBeUndefined();
  });
});

describe("resolveMkfifoPath", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "bridge-mkfifo-resolve-test-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("resolves mkfifo from PATH, falling back to the absolute default", () => {
    // NixOS/Alpine footgun: mkfifo is not guaranteed to live at /usr/bin.
    const fakeMkfifo = join(workdir, "mkfifo");
    writeFileSync(fakeMkfifo, "#!/bin/sh\n", "utf8");
    chmodSync(fakeMkfifo, 0o755);
    expect(resolveMkfifoPath({ PATH: workdir })).toBe(fakeMkfifo);
    expect(resolveMkfifoPath({ PATH: "/definitely/not/here" })).toBe("/usr/bin/mkfifo");
  });
});

// ---------------------------------------------------------------------------
// Real factory integration (fake-claude binary, real lease + watcher)
// ---------------------------------------------------------------------------

describe("createRealProcessFactory (fake-claude end to end)", () => {
  let workdir: string;
  let handles: ClaudeProcessHandle[];

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "bridge-factory-e2e-"));
    handles = [];
  });

  afterEach(() => {
    for (const handle of handles) {
      try {
        handle.closeInput();
      } catch {
        // already closed
      }
      try {
        handle.signal("SIGKILL");
      } catch {
        // already dead
      }
    }
    rmSync(workdir, { recursive: true, force: true });
  });

  function makeFactory(sessionId: string) {
    const fakeAdapter = join(workdir, "fake-permission-adapter.mjs");
    writeFileSync(fakeAdapter, "// tiny fake MCP adapter entry\nexport {};\n", "utf8");
    return createRealProcessFactory({
      dataDir: workdir,
      claudeBin: process.execPath,
      claudeBinArgs: [
        fakeClaudePath,
        "--args-log",
        join(workdir, "args.log"),
        "--signals-log",
        join(workdir, `${sessionId}.signals.log`),
      ],
      permissionAdapterEntry: fakeAdapter,
      permissionSocketPath: join(workdir, "permission.sock"),
      leaseWaitMs: WATCH_MS,
    });
  }

  it(
    "implements ClaudeProcessHandle: start → init → sendUser → graceful closeInput exit",
    async () => {
      const sessionId = randomUUID();
      const factory = makeFactory(sessionId);
      const handle = await factory.start({ sessionId, mode: "create", cwd: workdir });
      handles.push(handle);

      expect(handle.sessionId).toBe(sessionId);
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.alive()).toBe(true);

      const init = await handle.awaitInit(5000);
      expect(init.session_id).toBe(sessionId);

      // Supervisor contract: sendUser(requestId, text) delivers one envelope.
      handle.sendUser("request-uuid-1", "hello factory");
      const argsLog = join(workdir, "args.log");
      await waitFor(() => existsSync(argsLog), "fake-claude args log");
      const argv = JSON.parse(readFileSync(argsLog, "utf8").trim()) as string[];
      const driverArgs = argv.slice(argv.indexOf("-p"));
      expect(driverArgs).toEqual([
        "-p",
        "--session-id",
        sessionId,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
        "--permission-mode",
        "default",
        "--strict-mcp-config",
        "--mcp-config",
        join(workdir, "mcp", `${sessionId}.json`),
        "--permission-prompt-tool",
        "mcp__claude_remote_permission__decide",
      ]);

      // Per-session MCP config written with the lease secret.
      const mcpConfig = JSON.parse(readFileSync(join(workdir, "mcp", `${sessionId}.json`), "utf8"));
      expect(mcpConfig.mcpServers.claude_remote_permission.env.BRIDGE_SESSION_ID).toBe(sessionId);
      expect(mcpConfig.mcpServers.claude_remote_permission.env.BRIDGE_LEASE_SECRET).toMatch(
        /^[0-9a-f]{64}$/,
      );

      // Graceful release path: stdin close → exit → lease FIFO cleaned up.
      const fifoPath = join(workdir, "leases", `${sessionId}.fifo`);
      expect(existsSync(fifoPath)).toBe(true);
      handle.closeInput();
      await waitFor(() => !handle.alive(), "fake-claude exit after stdin close");
      await waitFor(() => !existsSync(fifoPath), "lease FIFO cleanup after exit");
      expect(existsSync(join(workdir, `${sessionId}.signals.log`))).toBe(false);
    },
    15_000,
  );

  it(
    "signal() escalates to the process group and the watcher stays silent afterwards",
    async () => {
      const fakeAdapter = join(workdir, "fake-permission-adapter.mjs");
      writeFileSync(fakeAdapter, "// tiny fake MCP adapter entry\nexport {};\n", "utf8");
      const sessionId = randomUUID();
      const signalsLog = join(workdir, `${sessionId}.signals.log`);
      const factory = createRealProcessFactory({
        dataDir: workdir,
        claudeBin: process.execPath,
        claudeBinArgs: [fakeClaudePath, "--signals-log", signalsLog],
        permissionAdapterEntry: fakeAdapter,
        permissionSocketPath: join(workdir, "permission.sock"),
        leaseWaitMs: WATCH_MS,
      });
      const handle = await factory.start({ sessionId, mode: "create", cwd: workdir });
      handles.push(handle);
      await handle.awaitInit(5000);

      // Supervisor stop order starts with SIGINT; the handle must target the
      // whole process group.
      handle.signal("SIGINT");
      await waitFor(() => !handle.alive(), "fake-claude exit after SIGINT");
      await waitFor(() => existsSync(signalsLog), "fake-claude signal log");
      // Exactly one signal: the one WE sent. The lease watcher observed the
      // already-dead pid and sent nothing.
      expect(readFileSync(signalsLog, "utf8").trim()).toBe("SIGINT");
    },
    15_000,
  );

  it(
    "lease setup failure (failing mkfifo) kills the spawned child — no orphan",
    async () => {
      const sessionId = randomUUID();
      const pidLog = join(workdir, `${sessionId}.pid`);
      const fakeAdapter = join(workdir, "fake-permission-adapter.mjs");
      writeFileSync(fakeAdapter, "// tiny fake MCP adapter entry\nexport {};\n", "utf8");
      // A mkfifo stand-in that FAILS (exit 1) after a short delay: the delay
      // lets the child boot far enough to log its pid, so the test can watch
      // THAT exact pid die — a deterministic orphan check, no ps needed.
      const failingMkfifo = join(workdir, "failing-mkfifo.sh");
      writeFileSync(failingMkfifo, "#!/bin/sh\nsleep 1\nexit 1\n", "utf8");
      chmodSync(failingMkfifo, 0o755);
      const factory = createRealProcessFactory({
        dataDir: workdir,
        claudeBin: process.execPath,
        claudeBinArgs: [pidLoggingSleeperPath, pidLog],
        permissionAdapterEntry: fakeAdapter,
        permissionSocketPath: join(workdir, "permission.sock"),
        leaseWaitMs: WATCH_MS,
        mkfifoPath: failingMkfifo,
      });

      await expect(factory.start({ sessionId, mode: "create", cwd: workdir })).rejects.toThrow(
        /Command failed/,
      );

      // The child really did run before the failure...
      await waitFor(() => existsSync(pidLog), "child pid log");
      const pid = Number.parseInt(readFileSync(pidLog, "utf8").trim(), 10);
      expect(pid).toBeGreaterThan(0);
      // ...and the failed lease setup left it DEAD (ESRCH when probed), not
      // orphaned waiting on a stdin that will never close.
      await waitFor(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        "orphaned child to die after lease-setup failure",
        2000,
      );
      // The FIFO was never created, so nothing else leaked either.
      expect(existsSync(join(workdir, "leases", `${sessionId}.fifo`))).toBe(false);
    },
    15_000,
  );

  it(
    "lease setup failure (missing mkfifo binary) throws without an orphan",
    async () => {
      const sessionId = randomUUID();
      const fakeAdapter = join(workdir, "fake-permission-adapter.mjs");
      writeFileSync(fakeAdapter, "// tiny fake MCP adapter entry\nexport {};\n", "utf8");
      const factory = createRealProcessFactory({
        dataDir: workdir,
        claudeBin: process.execPath,
        claudeBinArgs: [pidLoggingSleeperPath, join(workdir, `${sessionId}.pid`)],
        permissionAdapterEntry: fakeAdapter,
        permissionSocketPath: join(workdir, "permission.sock"),
        leaseWaitMs: WATCH_MS,
        mkfifoPath: join(workdir, "definitely-not-mkfifo"),
      });

      // Same teardown path as above with the other failure kind: ENOENT.
      await expect(factory.start({ sessionId, mode: "create", cwd: workdir })).rejects.toThrow(
        /ENOENT/,
      );
      expect(existsSync(join(workdir, "leases", `${sessionId}.fifo`))).toBe(false);
    },
    15_000,
  );
});
