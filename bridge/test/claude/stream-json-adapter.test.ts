// Task 16 Step 1: failing adapter tests against the fake-claude fixture.
//
// These tests drive the stream-json adapter through a REAL child process
// (bridge/test/fixtures/fake-claude.mjs), never the proprietary CLI — the
// spawn-arg and envelope contract was already proven 13/13 against real
// Claude Code 2.1.133 by the Phase 0 compatibility gate.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_PROMPT_TOOL,
  LineAssembler,
  ClaudeStreamJsonProcess,
  buildClaudeArgs,
  buildUserMessageEnvelope,
  classifyClaudeEvent,
  extractInitSessionId,
  type ClaudeStreamEvent,
} from "../../src/claude/stream-json-adapter.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fakeClaudePath = join(here, "../fixtures/fake-claude.mjs");

const PROBE_TOOL = "mcp__claude_remote_permission__decide";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface HarnessOptions {
  mode?: "create" | "resume";
  permissionPromptTool?: string;
  emitUnknown?: boolean;
}

interface Harness {
  proc: ClaudeStreamJsonProcess;
  sessionId: string;
  mcpConfigPath: string;
  argsLog: string;
  stdinLog: string;
  /** Driver args as seen by the child, sliced from the leading `-p`. */
  driverArgs(): string[];
  nextEvent(timeoutMs?: number): Promise<IteratorResult<ClaudeStreamEvent>>;
  nextWhere(pred: (ev: ClaudeStreamEvent) => boolean, timeoutMs?: number): Promise<ClaudeStreamEvent>;
}

describe("ClaudeStreamJsonProcess (fake child process)", () => {
  let workdir: string;
  let procs: ClaudeStreamJsonProcess[];

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "bridge-adapter-test-"));
    procs = [];
  });

  afterEach(() => {
    for (const proc of procs) {
      try {
        proc.closeInput();
      } catch {
        // already closed
      }
      try {
        proc.signal("SIGKILL");
      } catch {
        // already dead
      }
    }
    rmSync(workdir, { recursive: true, force: true });
  });

  function startFake(opts: HarnessOptions = {}): Harness {
    const sessionId = randomUUID();
    const mcpConfigPath = join(workdir, "mcp", `${sessionId}.json`);
    mkdirSync(join(workdir, "mcp"), { recursive: true });
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const argsLog = join(workdir, `${sessionId}.args.log`);
    const stdinLog = join(workdir, `${sessionId}.stdin.log`);
    const baseArgs = [
      fakeClaudePath,
      "--args-log",
      argsLog,
      "--stdin-log",
      stdinLog,
      ...(opts.emitUnknown ? ["--emit-unknown"] : []),
    ];
    const proc = ClaudeStreamJsonProcess.start({
      command: process.execPath,
      baseArgs,
      cwd: workdir,
      sessionId,
      mode: opts.mode ?? "create",
      mcpConfigPath,
      permissionPromptTool: opts.permissionPromptTool ?? PROBE_TOOL,
    });
    procs.push(proc);
    const iterator = proc.events();
    return {
      proc,
      sessionId,
      mcpConfigPath,
      argsLog,
      stdinLog,
      driverArgs(): string[] {
        const argv = JSON.parse(readFileSync(argsLog, "utf8").trim()) as string[];
        const start = argv.indexOf("-p");
        expect(start).toBeGreaterThanOrEqual(0);
        return argv.slice(start);
      },
      async nextEvent(timeoutMs = 5000): Promise<IteratorResult<ClaudeStreamEvent>> {
        const timeout = new Promise<IteratorResult<ClaudeStreamEvent>>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), timeoutMs),
        );
        return Promise.race([iterator.next(), timeout]);
      },
      async nextWhere(
        pred: (ev: ClaudeStreamEvent) => boolean,
        timeoutMs = 5000,
      ): Promise<ClaudeStreamEvent> {
        for (;;) {
          const res = await this.nextEvent(timeoutMs);
          if (res.done) throw new Error("event stream ended before matching event");
          if (pred(res.value)) return res.value;
        }
      },
    };
  }

  it(
    "sendUser writes exactly one NDJSON line equal to the candidate envelope",
    async () => {
      const h = startFake();
      await h.proc.awaitInit(5000);
      const requestUuid = randomUUID();
      h.proc.sendUser(requestUuid, h.sessionId, "hello adapter");

      await waitFor(
        () => existsSync(h.stdinLog) && readFileSync(h.stdinLog, "utf8").includes("\n"),
        "stdin log line",
      );
      const lines = readFileSync(h.stdinLog, "utf8").split("\n").filter((l) => l !== "");
      expect(lines).toHaveLength(1);
      const firstLine = lines[0] as string;
      // Pinned independently of buildUserMessageEnvelope so a builder regression
      // cannot make this assertion vacuous.
      expect(JSON.parse(firstLine)).toEqual({
        type: "user",
        uuid: requestUuid,
        session_id: h.sessionId,
        message: { role: "user", content: [{ type: "text", text: "hello adapter" }] },
        parent_tool_use_id: null,
      });
      expect(buildUserMessageEnvelope(requestUuid, h.sessionId, "hello adapter")).toEqual(
        JSON.parse(firstLine),
      );
    },
    10_000,
  );

  it(
    "events() yields parsed objects; partial lines are buffered until newline",
    async () => {
      const h = startFake();
      const init = await h.proc.awaitInit(5000);
      expect(init.session_id).toBe(h.sessionId);

      const requestUuid = randomUUID();
      h.proc.sendUser(requestUuid, h.sessionId, "frame me");

      // Every yielded frame must be a complete parsed object with a string
      // `type` — partial stdout chunks never surface as torn frames.
      const replay = await h.nextWhere(
        (ev) => ev.type === "user" && ev.uuid === requestUuid,
      );
      expect(replay.type).toBe("user");
      const assistant = await h.nextWhere((ev) => ev.type === "assistant");
      expect(assistant.type).toBe("assistant");
      const result = await h.nextWhere((ev) => ev.type === "result");
      expect(result.type).toBe("result");
      for (const ev of [replay, assistant, result]) {
        expect(typeof ev.type).toBe("string");
        expect(ev.type.length).toBeGreaterThan(0);
      }
    },
    10_000,
  );

  it(
    "system/init extraction returns the session_id",
    async () => {
      const h = startFake();
      const init = await h.proc.awaitInit(5000);
      // The fake echoes the --session-id value it was spawned with.
      expect(init).toEqual({ session_id: h.sessionId });
    },
    10_000,
  );

  it(
    "unknown event types yield a typed unknownClaudeEvent object, never throw",
    async () => {
      const h = startFake({ emitUnknown: true });
      await h.proc.awaitInit(5000);
      const ev = await h.nextWhere((e) => e.type === "unknownClaudeEvent");
      expect(ev).toEqual({
        type: "unknownClaudeEvent",
        raw: { type: "totally_new_event_kind", payload: { noise: true } },
      });
    },
    10_000,
  );

  it(
    "a result event does not close the process; only stdin close or stop does",
    async () => {
      const h = startFake();
      await h.proc.awaitInit(5000);
      const u1 = randomUUID();
      const u2 = randomUUID();
      h.proc.sendUser(u1, h.sessionId, "turn-1");
      await h.nextWhere((ev) => ev.type === "result");
      // The process survived the first result: stdin is still writable and
      // the child is still alive.
      expect(h.proc.alive()).toBe(true);
      h.proc.sendUser(u2, h.sessionId, "turn-2");
      // nextWhere consumed turn 1's result already, so the next result event
      // observed is turn 2's — proving stdin stayed open across a result.
      await h.nextWhere((ev) => ev.type === "result");
      expect(h.proc.alive()).toBe(true);
      // Explicit stdin close is what ends the fake cleanly.
      h.proc.closeInput();
      await waitFor(() => !h.proc.alive(), "process exit after stdin close");
    },
    10_000,
  );

  it(
    "sendUser racing a child-group SIGKILL never crashes the process (stdin EPIPE)",
    async () => {
      const h = startFake();
      await h.proc.awaitInit(5000);
      expect(h.proc.pid).toBeDefined();

      // The race window: the group dies while writes are still flowing —
      // before the adapter's exit hook has flipped `exited`, the guard
      // passes and the write lands on a pipe whose reader is gone. This is
      // the reviewer's stress scenario: a write barrage across the kill, so
      // flushes keep being attempted after the kernel closes the read end
      // (a lone write can still fit the pipe buffer and never EPIPE).
      h.proc.signal("SIGKILL");
      for (let i = 0; i < 200; i++) {
        try {
          h.proc.sendUser(randomUUID(), h.sessionId, "x".repeat(4096));
        } catch {
          // The exit hook caught up: sendUser's own `exited` guard threw a
          // normal typed error. The barrage has crossed the window.
          break;
        }
        if (i % 10 === 0) await sleep(1); // let the kernel catch up mid-barrage
      }
      // Give any asynchronous EPIPE time to surface INSIDE this test;
      // without the constructor's stdin error handler, the unhandled
      // 'error' event tears this worker down right here.
      await sleep(150);

      // Post-mortem, deterministic: once exit is fully observed, sendUser
      // throws the typed error instead of writing to the dead pipe.
      await waitFor(() => !h.proc.alive(), "process exit after SIGKILL");
      expect(() => h.proc.sendUser(randomUUID(), h.sessionId, "after exit")).toThrow(/exited/);
    },
    10_000,
  );

  it(
    "create mode spawns the exact Phase 0 arg order and never --resume",
    async () => {
      const h = startFake();
      await h.proc.awaitInit(5000);
      const args = h.driverArgs();
      expect(args).toEqual([
        "-p",
        "--session-id",
        h.sessionId,
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
        h.mcpConfigPath,
        "--permission-prompt-tool",
        PROBE_TOOL,
      ]);
      expect(args).not.toContain("--resume");
    },
    10_000,
  );

  it(
    "resume mode replaces --session-id with --resume and never combines them",
    async () => {
      const h = startFake({ mode: "resume" });
      await h.proc.awaitInit(5000);
      const args = h.driverArgs();
      expect(args.slice(0, 3)).toEqual(["-p", "--resume", h.sessionId]);
      expect(args).not.toContain("--session-id");
      expect(args).toContain("--resume");
    },
    10_000,
  );

  it(
    "permission-prompt tool name flows from the --permission-prompt-tool flag value",
    async () => {
      const tool = "mcp__custom_broker__decide_v2";
      const h = startFake({ permissionPromptTool: tool });
      await h.proc.awaitInit(5000);
      const args = h.driverArgs();
      const idx = args.indexOf("--permission-prompt-tool");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe(tool);
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// Pure-function units (no child process)
// ---------------------------------------------------------------------------

describe("LineAssembler", () => {
  it("buffers partial lines until a newline completes them", () => {
    const assembler = new LineAssembler();
    expect(assembler.feed('{"type":"sys')).toEqual([]);
    expect(assembler.feed('tem","sub')).toEqual([]);
    expect(assembler.feed('type":"init"}')).toEqual([]);
    expect(assembler.feed('\n{"x":1}\n{"y":2}')).toEqual([
      '{"type":"system","subtype":"init"}',
      '{"x":1}',
    ]);
  });

  it("splits CRLF-terminated lines on the newline", () => {
    const assembler = new LineAssembler();
    expect(assembler.feed('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}\r', '{"b":2}\r']);
  });

  it("flush() returns a trailing line without a terminator exactly once", () => {
    const assembler = new LineAssembler();
    expect(assembler.feed('{"complete":1}\n{"partial')).toEqual(['{"complete":1}']);
    expect(assembler.flush()).toBe('{"partial');
    expect(assembler.flush()).toBeUndefined();
  });
});

describe("classifyClaudeEvent", () => {
  it("passes known event types through unchanged", () => {
    for (const type of ["system", "assistant", "user", "result", "stream_event"]) {
      const ev = classifyClaudeEvent({ type, session_id: "s" });
      expect(ev).toEqual({ type, session_id: "s" });
    }
  });

  it("wraps unknown event types instead of throwing", () => {
    expect(classifyClaudeEvent({ type: "brand_new_kind", x: 1 })).toEqual({
      type: "unknownClaudeEvent",
      raw: { type: "brand_new_kind", x: 1 },
    });
  });

  it("wraps non-object payloads without throwing", () => {
    expect(classifyClaudeEvent("garbage")).toEqual({ type: "unknownClaudeEvent", raw: "garbage" });
    expect(classifyClaudeEvent(42)).toEqual({ type: "unknownClaudeEvent", raw: 42 });
    expect(classifyClaudeEvent(null)).toEqual({ type: "unknownClaudeEvent", raw: null });
    expect(classifyClaudeEvent([1, 2])).toEqual({ type: "unknownClaudeEvent", raw: [1, 2] });
    expect(classifyClaudeEvent({ subtype: "no-type-field" })).toEqual({
      type: "unknownClaudeEvent",
      raw: { subtype: "no-type-field" },
    });
  });
});

describe("extractInitSessionId", () => {
  it("returns session_id only for system/init events", () => {
    expect(
      extractInitSessionId({ type: "system", subtype: "init", session_id: "sid-1" }),
    ).toBe("sid-1");
    expect(extractInitSessionId({ type: "system", subtype: "other", session_id: "sid-1" })).toBeUndefined();
    expect(extractInitSessionId({ type: "user", session_id: "sid-1" })).toBeUndefined();
    expect(extractInitSessionId({ type: "system", subtype: "init" })).toBeUndefined();
    expect(
      extractInitSessionId({ type: "unknownClaudeEvent", raw: { subtype: "init" } }),
    ).toBeUndefined();
  });
});

describe("buildClaudeArgs", () => {
  it("builds the exact gate-verified order; resume never adds --session-id", () => {
    expect(
      buildClaudeArgs({
        sessionId: "sid",
        mode: "create",
        mcpConfigPath: "/abs/mcp.json",
        permissionPromptTool: "tool",
      }),
    ).toEqual([
      "-p",
      "--session-id",
      "sid",
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
      "/abs/mcp.json",
      "--permission-prompt-tool",
      "tool",
    ]);
    const resume = buildClaudeArgs({
      sessionId: "sid",
      mode: "resume",
      mcpConfigPath: "/abs/mcp.json",
      permissionPromptTool: "tool",
    });
    expect(resume).not.toContain("--session-id");
    expect(resume[1]).toBe("--resume");
    expect(resume[2]).toBe("sid");
  });

  it("defaults the permission prompt tool to the broker tool name", () => {
    expect(DEFAULT_PERMISSION_PROMPT_TOOL).toBe("mcp__claude_remote_permission__decide");
  });

  it("rejects a relative mcp-config path", () => {
    expect(() =>
      buildClaudeArgs({
        sessionId: "sid",
        mode: "create",
        mcpConfigPath: "relative/mcp.json",
        permissionPromptTool: "tool",
      }),
    ).toThrow(/absolute/);
  });
});
