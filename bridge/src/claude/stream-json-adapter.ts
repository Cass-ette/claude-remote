/**
 * Claude Code stream-json adapter (spec §4, §6.3).
 *
 * Drives the child Claude Code CLI over the Phase 0 (candidate 2.1.133)
 * stream-json contract, verified 13/13 by the compatibility gate:
 *
 *   * spawn args (exact order):
 *     `-p --session-id <uuid> --input-format stream-json --output-format
 *     stream-json --verbose --include-partial-messages --replay-user-messages
 *     --permission-mode default --strict-mcp-config --mcp-config <absolute>
 *     --permission-prompt-tool <name>`
 *     Resume mode replaces `--session-id <id>` with `--resume <id>` — never
 *     both.
 *   * user messages are written as one NDJSON line per turn using the exact
 *     candidate envelope (including `parent_tool_use_id: null`).
 *   * stdout is parsed line-by-line; a frame is only yielded once a complete
 *     JSON object terminated by `\n` has been received (partial chunks are
 *     buffered).
 *   * a `result` event NEVER closes the process: stdin stays open until the
 *     caller closes it or explicitly signals the process group.
 *
 * Unknown event types are wrapped as a typed {@link UnknownClaudeEvent}
 * instead of thrown so a newer CLI cannot crash the Bridge.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

/**
 * Default `--permission-prompt-tool` value: the permission broker tool
 * exposed by the per-session MCP server `claude_remote_permission` (the
 * broker itself is Task 17; the tool name is part of the Phase 0 contract).
 */
export const DEFAULT_PERMISSION_PROMPT_TOOL = "mcp__claude_remote_permission__decide";

/** Flags shared by create and resume mode, in gate-verified order. */
const SHARED_ARGS: readonly string[] = [
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
];

export interface ClaudeArgsInput {
  readonly sessionId: string;
  readonly mode: "create" | "resume";
  /** Absolute path of the per-session `--strict-mcp-config` JSON. */
  readonly mcpConfigPath: string;
  readonly permissionPromptTool: string;
}

/** Build the exact Phase 0 spawn args. Resume never emits `--session-id`. */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  if (!isAbsolute(input.mcpConfigPath)) {
    throw new Error(`mcpConfigPath must be an absolute path; got ${JSON.stringify(input.mcpConfigPath)}`);
  }
  if (input.permissionPromptTool === "") {
    throw new Error("permissionPromptTool must not be empty");
  }
  const sessionFlag = input.mode === "create" ? "--session-id" : "--resume";
  return [
    "-p",
    sessionFlag,
    input.sessionId,
    ...SHARED_ARGS,
    "--mcp-config",
    input.mcpConfigPath,
    "--permission-prompt-tool",
    input.permissionPromptTool,
  ];
}

/** The exact Phase 0 candidate user-message envelope. */
export function buildUserMessageEnvelope(
  uuid: string,
  sessionId: string,
  text: string,
): {
  type: "user";
  uuid: string;
  session_id: string;
  message: { role: "user"; content: Array<{ type: "text"; text: string }> };
  parent_tool_use_id: null;
} {
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

export type KnownClaudeEventType = "system" | "assistant" | "user" | "result" | "stream_event";

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<KnownClaudeEventType>([
  "system",
  "assistant",
  "user",
  "result",
  "stream_event",
]);

export interface KnownClaudeEvent {
  readonly type: KnownClaudeEventType;
  readonly [key: string]: unknown;
}

/** A well-formed NDJSON event whose `type` this Bridge version does not know. */
export interface UnknownClaudeEvent {
  readonly type: "unknownClaudeEvent";
  readonly raw: unknown;
}

export type ClaudeStreamEvent = KnownClaudeEvent | UnknownClaudeEvent;

/**
 * Classify one parsed stdout object. Known event types pass through
 * unchanged; everything else (unknown types, non-objects) is wrapped —
 * classification never throws.
 */
export function classifyClaudeEvent(obj: unknown): ClaudeStreamEvent {
  if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    const type = (obj as { type?: unknown }).type;
    if (typeof type === "string" && KNOWN_EVENT_TYPES.has(type)) {
      return obj as KnownClaudeEvent;
    }
  }
  return { type: "unknownClaudeEvent", raw: obj };
}

/** Extract `session_id` from a `system/init` event, else undefined. */
export function extractInitSessionId(ev: ClaudeStreamEvent): string | undefined {
  if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
    return ev.session_id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Line assembly
// ---------------------------------------------------------------------------

/**
 * Reassembles arbitrary stdout chunk boundaries into complete `\n`-terminated
 * lines. `feed` returns the complete lines contained in all chunks so far;
 * `flush` returns a trailing unterminated line exactly once (stdout closed
 * mid-line).
 */
export class LineAssembler {
  private buffer = "";
  private flushed = false;

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      lines.push(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
    return lines;
  }

  flush(): string | undefined {
    if (this.flushed || this.buffer === "") return undefined;
    this.flushed = true;
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }
}

// ---------------------------------------------------------------------------
// Child process
// ---------------------------------------------------------------------------

export interface StreamJsonProcessOptions {
  /** Executable to spawn (the real `claude` binary, or a test double). */
  readonly command: string;
  /** Leading args before the driver args (e.g. a fixture script path). */
  readonly baseArgs?: readonly string[];
  readonly cwd: string;
  readonly sessionId: string;
  readonly mode: "create" | "resume";
  readonly mcpConfigPath: string;
  readonly permissionPromptTool: string;
  /**
   * Spawn the child detached so it leads its own process group (default
   * true). Required for group-scoped stop signals and the lease wrapper.
   */
  readonly detached?: boolean;
  /** Extra env layered over the Bridge's environment. */
  readonly env?: Record<string, string | undefined>;
}

/**
 * A live Claude Code child process speaking stream-json on stdin/stdout.
 * Implements the process-facing half of the supervisor's
 * `ClaudeProcessHandle` contract (the factory composes it with the lease).
 */
export class ClaudeStreamJsonProcess {
  readonly pid: number | undefined;

  private readonly child: ChildProcess;
  private readonly detachedGroup: boolean;
  private readonly assembler = new LineAssembler();
  private readonly pending: ClaudeStreamEvent[] = [];
  private readonly waiters: Array<(r: IteratorResult<ClaudeStreamEvent>) => void> = [];
  private readonly exitCallbacks: Array<() => void> = [];
  private stdinClosed = false;
  private stdoutEnded = false;
  private exited = false;
  private initSettled = false;
  private readonly initPromise: Promise<{ session_id: string }>;

  private constructor(child: ChildProcess, detachedGroup: boolean) {
    this.child = child;
    this.pid = child.pid;
    this.detachedGroup = detachedGroup;

    this.initPromise = new Promise((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });
    // The init promise can reject on process exit even when nobody awaits it;
    // mark it handled so it never surfaces as an unhandled rejection.
    this.initPromise.catch(() => {});

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    child.stdout?.on("end", () => {
      this.stdoutEnded = true;
      const trailing = this.assembler.flush();
      if (trailing !== undefined && trailing.trim() !== "") {
        this.enqueueParsed(trailing.trim());
      }
      this.drainEnd();
    });
    child.stdout?.on("error", (err) => this.handleExit(err));
    // stderr is swallowed: it can echo transcript content and the stream-json
    // contract never uses it for frames.
    child.stderr?.resume();
    child.on("error", (err) => this.handleExit(err));
    child.on("exit", () => this.handleExit());
  }

  static start(options: StreamJsonProcessOptions): ClaudeStreamJsonProcess {
    const detachedGroup = options.detached ?? true;
    const args = [
      ...(options.baseArgs ?? []),
      ...buildClaudeArgs({
        sessionId: options.sessionId,
        mode: options.mode,
        mcpConfigPath: options.mcpConfigPath,
        permissionPromptTool: options.permissionPromptTool,
      }),
    ];
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: detachedGroup,
      env: { ...process.env, ...options.env },
    });
    return new ClaudeStreamJsonProcess(child, detachedGroup);
  }

  // -- lifecycle ----------------------------------------------------------

  alive(): boolean {
    return !this.exited && this.child.pid !== undefined;
  }

  /** Stop signal (§7.5): targets the whole process group when detached. */
  signal(sig: NodeJS.Signals): void {
    if (this.child.pid === undefined || this.exited) return;
    try {
      if (this.detachedGroup) {
        process.kill(-this.child.pid, sig);
      } else {
        this.child.kill(sig);
      }
    } catch {
      // ESRCH: the group already exited between the alive check and here.
    }
  }

  /** Register a callback fired exactly once when the process is gone. */
  onExit(callback: () => void): void {
    if (this.exited) {
      callback();
      return;
    }
    this.exitCallbacks.push(callback);
  }

  // -- stdin --------------------------------------------------------------

  /** Write one user-message NDJSON line (exact candidate envelope). */
  sendUser(uuid: string, sessionId: string, text: string): void {
    if (this.exited) throw new Error("claude process has exited");
    if (this.stdinClosed || this.child.stdin === null) {
      throw new Error("claude stdin is not writable (already closed)");
    }
    this.child.stdin.write(JSON.stringify(buildUserMessageEnvelope(uuid, sessionId, text)) + "\n");
  }

  /** Close stdin; a well-behaved CLI exits after finishing its turn. */
  closeInput(): void {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    this.child.stdin?.end();
  }

  // -- system/init --------------------------------------------------------

  /** Resolves with the first `system/init` payload or rejects on timeout. */
  async awaitInit(timeoutMs: number): Promise<{ session_id: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms waiting for system/init`)),
        timeoutMs,
      );
      this.initPromise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // -- stdout frames ------------------------------------------------------

  /** Async iterator over parsed, classified stdout events. */
  events(): AsyncIterableIterator<ClaudeStreamEvent> {
    const self = this;
    const iterator: AsyncIterableIterator<ClaudeStreamEvent> = {
      next(): Promise<IteratorResult<ClaudeStreamEvent>> {
        if (self.pending.length > 0) {
          const value = self.pending.shift();
          return Promise.resolve({ value, done: false } as IteratorResult<ClaudeStreamEvent>);
        }
        if (self.exited || self.stdoutEnded) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<ClaudeStreamEvent>);
        }
        return new Promise<IteratorResult<ClaudeStreamEvent>>((resolve) => {
          self.waiters.push(resolve);
        });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  // -- internals ----------------------------------------------------------

  private resolveInit!: (value: { session_id: string }) => void;
  private rejectInit!: (reason: Error) => void;

  private onStdoutChunk(chunk: string): void {
    for (const line of this.assembler.feed(chunk)) {
      const trimmed = line.trim();
      if (trimmed !== "") this.enqueueParsed(trimmed);
    }
  }

  private enqueueParsed(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A non-JSON line violates the stream-json contract; skip it rather
      // than crash the Bridge.
      return;
    }
    const event = classifyClaudeEvent(parsed);
    if (!this.initSettled) {
      const sessionId = extractInitSessionId(event);
      if (sessionId !== undefined) {
        this.initSettled = true;
        this.resolveInit({ session_id: sessionId });
      }
    }
    if (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: event, done: false });
    } else {
      this.pending.push(event);
    }
  }

  private handleExit(error?: Error): void {
    if (error !== undefined) {
      this.exited = true;
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.exited = true;
    }
    if (!this.exited) return;
    if (!this.initSettled) {
      this.initSettled = true;
      this.rejectInit(
        new Error(
          error !== undefined
            ? `claude process failed: ${error.message}`
            : "claude process exited before system/init",
        ),
      );
    }
    this.drainEnd();
    for (const callback of this.exitCallbacks.splice(0)) {
      try {
        callback();
      } catch {
        // A teardown callback must not break other teardown callbacks.
      }
    }
  }

  private drainEnd(): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }
}
