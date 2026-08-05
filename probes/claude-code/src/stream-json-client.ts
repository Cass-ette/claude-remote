// Claude Code stream-json driver.
//
// This module ONLY drives the candidate 2.1.133 stream-json contract:
//
//   * spawn `claude` with `--input-format stream-json --output-format
//     stream-json --verbose --include-partial-messages
//     --replay-user-messages --permission-mode default
//     --strict-mcp-config --mcp-config <absolute>
//     --permission-prompt-tool <name>`
//   * create mode passes `--session-id <id>`; resume mode passes
//     `--resume <id>` and never the two combined.
//   * write candidate user messages as one NDJSON object per newline and keep
//     stdin open after each `result` until the caller closes it.
//
// Whether the real CLI actually accepts this envelope is decided by the
// compatibility gate, not by this driver. The driver is contractually
// tolerant: it parses partial stdout chunks line-by-line and only yields a
// frame once a complete JSON object terminated by `\n` has been received.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface IClaudeStreamClient {
  startCreate(
    sessionId: string,
    cwd: string,
    mcpConfig: string,
    permissionTool: string
  ): Promise<void>;
  startResume(
    sessionId: string,
    cwd: string,
    mcpConfig: string,
    permissionTool: string
  ): Promise<void>;
  sendCandidateUser(uuid: string, sessionId: string, text: string): Promise<void>;
  events(): AsyncIterableIterator<unknown>;
  closeInput(): Promise<void>;
}

const SHARED_FLAGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--permission-mode",
  "default",
  "--strict-mcp-config"
] as const;

/**
 * Resolve the executable + leading args. Tests override these via the
 * `CLAUDE_BIN` (path to binary) and `CLAUDE_BIN_ARGS` (JSON-encoded leading
 * argument array) environment variables so the real `claude` is never
 * invoked in deterministic tests.
 */
function resolveSpawn(): { cmd: string; leadingArgs: string[] } {
  const cmd = process.env.CLAUDE_BIN ?? "claude";
  const raw = process.env.CLAUDE_BIN_ARGS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return { cmd, leadingArgs: parsed };
      }
    } catch {
      // fall through to default
    }
  }
  return { cmd, leadingArgs: [] };
}

interface FrameQueue {
  next(): Promise<IteratorResult<unknown>>;
}

export class ClaudeStreamClient implements IClaudeStreamClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending: unknown[] = [];
  private waiters: Array<(r: IteratorResult<unknown>) => void> = [];
  private stdinClosed = false;
  private stdoutEnded = false;
  private childExitCode: number | null = null;
  private childExitSignal: NodeJS.Signals | null = null;
  private exitErr: Error | null = null;

  async startCreate(
    sessionId: string,
    cwd: string,
    mcpConfig: string,
    permissionTool: string
  ): Promise<void> {
    const args = [
      ...SHARED_FLAGS,
      "--session-id",
      sessionId,
      "--mcp-config",
      mcpConfig,
      "--permission-prompt-tool",
      permissionTool
    ];
    await this.spawn(args, cwd);
  }

  async startResume(
    sessionId: string,
    cwd: string,
    mcpConfig: string,
    permissionTool: string
  ): Promise<void> {
    // IMPORTANT: `--resume` is never combined with `--session-id`.
    const args = [
      ...SHARED_FLAGS,
      "--resume",
      sessionId,
      "--mcp-config",
      mcpConfig,
      "--permission-prompt-tool",
      permissionTool
    ];
    await this.spawn(args, cwd);
  }

  private spawn(args: string[], cwd: string): Promise<void> {
    if (this.child) {
      throw new Error("ClaudeStreamClient already started");
    }
    const { cmd, leadingArgs } = resolveSpawn();
    const fullArgs = [...leadingArgs, ...args];
    const child = spawn(cmd, fullArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.onStdoutChunk(chunk);
    });
    child.stdout.on("end", () => {
      this.stdoutEnded = true;
      // Flush any trailing line without a terminator.
      if (this.buffer.length > 0) {
        const trimmed = this.buffer.trim();
        this.buffer = "";
        if (trimmed) this.enqueueParsed(trimmed);
      }
      this.drainEnd();
    });
    child.stdout.on("error", (err) => this.handleStreamError(err));
    child.stderr.on("data", () => {
      // Swallow stderr by default — the compatibility gate does not use it
      // for assertions and we must never echo transcript content.
    });
    child.on("error", (err) => {
      this.exitErr = err;
      this.drainEnd();
    });
    child.on("exit", (code, signal) => {
      this.childExitCode = code;
      this.childExitSignal = signal;
      this.drainEnd();
    });

    // Resolve once the child process is actually running (has a pid and has
    // not immediately errored). A next-tick delay lets `error` events fire.
    return new Promise((resolve, reject) => {
      if (!child.pid || child.exitCode !== null || child.signalCode) {
        reject(new Error("claude process failed to start"));
        return;
      }
      setImmediate(resolve);
    });
  }

  private onStdoutChunk(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.enqueueParsed(trimmed);
    }
  }

  private enqueueParsed(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A non-JSON line is a contract violation by the candidate, but the
      // driver should not crash. Skip the malformed line; the compatibility
      // gate surfaces framing problems via missing-event timeouts.
      return;
    }
    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w({ value: parsed, done: false });
    } else {
      this.pending.push(parsed);
    }
  }

  private handleStreamError(err: Error): void {
    this.exitErr = err;
    this.drainEnd();
  }

  private drainEnd(): void {
    // Only signal end when both stdout has finished AND the child has exited
    // (or errored). This avoids a race where exit fires before the final
    // stdout frame is delivered to listeners.
    const finished =
      this.stdoutEnded ||
      this.childExitCode !== null ||
      this.childExitSignal !== null ||
      this.exitErr !== null;
    if (!finished) return;
    // Resolve all pending waiters with done.
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  }

  async sendCandidateUser(uuid: string, sessionId: string, text: string): Promise<void> {
    if (!this.child || !this.child.stdin || this.stdinClosed) {
      throw new Error("ClaudeStreamClient stdin is not writable");
    }
    const candidate = {
      type: "user",
      uuid,
      session_id: sessionId,
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null
    };
    const line = JSON.stringify(candidate) + "\n";
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin!.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  events(): AsyncIterableIterator<unknown> {
    const self = this;
    const iterator: AsyncIterableIterator<unknown> = {
      next(): Promise<IteratorResult<unknown>> {
        if (self.pending.length > 0) {
          const value = self.pending.shift();
          return Promise.resolve({ value, done: false } as IteratorResult<unknown>);
        }
        const finished =
          self.stdoutEnded ||
          self.childExitCode !== null ||
          self.childExitSignal !== null ||
          self.exitErr !== null;
        if (finished) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<unknown>);
        }
        return new Promise<IteratorResult<unknown>>((resolve) => {
          self.waiters.push(resolve);
        });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      }
    };
    return iterator;
  }

  async closeInput(): Promise<void> {
    if (this.stdinClosed || !this.child || !this.child.stdin) {
      this.stdinClosed = true;
      return;
    }
    this.stdinClosed = true;
    await new Promise<void>((resolve) => {
      this.child!.stdin!.end(() => resolve());
    });
  }
}

/**
 * Generate a fresh request UUID. Exposed so the compatibility gate can mint
 * nonces that the transcript inspector later counts.
 */
export function newRequestUuid(): string {
  return randomUUID();
}
