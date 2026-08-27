/**
 * Real Claude process factory (Task 16).
 *
 * Implements the supervisor's {@link ClaudeProcessFactory} with real child
 * processes: it composes the stream-json adapter (spawn args + NDJSON
 * framing) with a per-session process lease (§7.6). The supervisor itself
 * works unchanged — this module only fills in the injectable factory.
 *
 * Per session it:
 *   * generates a fresh 256-bit lease secret (`crypto.randomBytes(32)`),
 *   * writes a per-session `--strict-mcp-config` JSON whose single MCP
 *     server is the permission adapter, spawned as
 *     `<absolute node> <absolute adapter .mjs>` (Claude launches MCP servers
 *     with a restricted PATH — `npx`/`tsx` do not resolve there),
 *   * spawns the Claude child detached (own process group) via the adapter,
 *   * starts the lease wrapper (FIFO + detached watcher) and tears it down
 *     automatically once the child exits.
 */

import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { SIGNAL_WAIT_SECONDS } from "../config.js";
import type {
  ClaudeProcessFactory,
  ClaudeProcessHandle,
  SignalName,
} from "../sessions/session-supervisor.js";
import {
  ClaudeStreamJsonProcess,
  DEFAULT_PERMISSION_PROMPT_TOOL,
} from "./stream-json-adapter.js";
import { startProcessLeaseWrapper, type ProcessLease } from "./process-lease-wrapper.js";

/** Env keys whose values must never reach logs or error messages. */
export const ENV_REDACT_KEYS: readonly string[] = ["BRIDGE_LEASE_SECRET"];

/** Copy `env` with every redact-listed key replaced by a placeholder. */
export function redactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value === undefined ? "" : ENV_REDACT_KEYS.includes(key) ? "[redacted]" : value;
  }
  return out;
}

/** Fresh 256-bit lease secret (64 hex chars), one per session. */
export function generateLeaseSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Resolve an executable name against a PATH-style environment. A name
 * containing a path separator is returned as-is when it exists; a bare name
 * is searched in each PATH entry for an executable file. Used to resolve the
 * default `claude` binary at factory construction.
 */
export function resolveExecutableFromPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (name.includes("/")) {
    return isExecutable(name) ? name : undefined;
  }
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface GenerateMcpConfigInput {
  readonly dataDir: string;
  readonly sessionId: string;
  /** Absolute path of the permission adapter entry script (.mjs). */
  readonly adapterEntry: string;
  /** Env forwarded to the MCP server subprocess. */
  readonly env: {
    BRIDGE_LEASE_SECRET: string;
    BRIDGE_PERMISSION_SOCKET: string;
    BRIDGE_SESSION_ID: string;
  };
}

/**
 * Write the per-session `--strict-mcp-config` JSON to
 * `<dataDir>/mcp/<sessionId>.json` and return its absolute path.
 *
 * The MCP server command is `<process.execPath>` (absolute node binary) with
 * the absolute adapter entry as its only arg — Claude Code spawns MCP
 * servers with a restricted PATH where `npx`/`tsx` do not resolve.
 */
export function generateMcpConfig(input: GenerateMcpConfigInput): string {
  if (!isAbsolute(input.adapterEntry)) {
    throw new Error(`adapterEntry must be an absolute path; got ${JSON.stringify(input.adapterEntry)}`);
  }
  const dir = join(input.dataDir, "mcp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configPath = join(dir, `${input.sessionId}.json`);
  const config = {
    mcpServers: {
      claude_remote_permission: {
        command: process.execPath,
        args: [input.adapterEntry],
        env: {
          BRIDGE_LEASE_SECRET: input.env.BRIDGE_LEASE_SECRET,
          BRIDGE_PERMISSION_SOCKET: input.env.BRIDGE_PERMISSION_SOCKET,
          BRIDGE_SESSION_ID: input.env.BRIDGE_SESSION_ID,
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return configPath;
}

export interface RealProcessFactoryOptions {
  readonly dataDir: string;
  /**
   * Claude executable (BRIDGE_CLAUDE_BIN). Default: resolve `claude` from
   * PATH at construction and store the absolute path.
   */
  readonly claudeBin?: string;
  /** Leading args before the driver args (used by tests to point at a fixture). */
  readonly claudeBinArgs?: readonly string[];
  /** Absolute path of the permission MCP adapter entry (Task 17/18). */
  readonly permissionAdapterEntry: string;
  /** Unix socket path the permission broker listens on (Task 17). */
  readonly permissionSocketPath: string;
  /** `--permission-prompt-tool` value. Default: the broker tool name. */
  readonly permissionPromptTool?: string;
  /** Lease-watcher escalation wait. Default: SIGNAL_WAIT_SECONDS (5 s). */
  readonly leaseWaitMs?: number;
  /** Override for tests; defaults to the sibling lease-watcher.mjs. */
  readonly watcherScriptPath?: string;
  /** Override for tests; defaults to PATH-resolved mkfifo. */
  readonly mkfifoPath?: string;
}

export function createRealProcessFactory(options: RealProcessFactoryOptions): ClaudeProcessFactory {
  if (!isAbsolute(options.permissionAdapterEntry)) {
    throw new Error(
      `permissionAdapterEntry must be an absolute path; got ${JSON.stringify(options.permissionAdapterEntry)}`,
    );
  }
  const claudeBin = options.claudeBin ?? resolveExecutableFromPath("claude");
  if (claudeBin === undefined) {
    throw new Error("claude binary not found: set BRIDGE_CLAUDE_BIN or put `claude` on PATH");
  }
  const leaseWaitMs = options.leaseWaitMs ?? SIGNAL_WAIT_SECONDS * 1000;
  const permissionPromptTool = options.permissionPromptTool ?? DEFAULT_PERMISSION_PROMPT_TOOL;

  return {
    async start(opts: {
      sessionId: string;
      mode: "create" | "resume";
      cwd: string;
    }): Promise<ClaudeProcessHandle> {
      const { sessionId, mode, cwd } = opts;
      const leaseSecret = generateLeaseSecret();
      const mcpConfigPath = generateMcpConfig({
        dataDir: options.dataDir,
        sessionId,
        adapterEntry: options.permissionAdapterEntry,
        env: {
          BRIDGE_LEASE_SECRET: leaseSecret,
          BRIDGE_PERMISSION_SOCKET: options.permissionSocketPath,
          BRIDGE_SESSION_ID: sessionId,
        },
      });

      const process_ = ClaudeStreamJsonProcess.start({
        command: claudeBin,
        ...(options.claudeBinArgs !== undefined ? { baseArgs: options.claudeBinArgs } : {}),
        cwd,
        sessionId,
        mode,
        mcpConfigPath,
        permissionPromptTool,
        detached: true, // own process group: group-scoped stop + lease target
      });
      if (process_.pid === undefined) {
        // Spawn failure (e.g. ENOENT): no pid exists, so there is nothing to
        // signal or leak — awaitInit also rejects via the error hook. Fail
        // fast so the supervisor's failStartup never sees a half-started child.
        throw new Error(`failed to start claude process for session ${sessionId}`);
      }

      const fifoPath = join(options.dataDir, "leases", `${sessionId}.fifo`);
      let lease: ProcessLease;
      try {
        lease = startProcessLeaseWrapper({
          fifoPath,
          claudePid: process_.pid,
          waitMs: leaseWaitMs,
          ...(options.watcherScriptPath !== undefined
            ? { watcherScriptPath: options.watcherScriptPath }
            : {}),
          ...(options.mkfifoPath !== undefined ? { mkfifoPath: options.mkfifoPath } : {}),
        });
      } catch (error) {
        // The child is spawned but has no lease, no watcher, and no onExit
        // teardown registered. Kill its process group now and wait for the
        // exit hook before rethrowing, or it leaks as an orphaned Claude.
        process_.signal("SIGKILL");
        await new Promise<void>((resolve) => {
          process_.onExit(resolve);
          setTimeout(resolve, SIGNAL_WAIT_SECONDS * 1000);
        });
        throw error;
      }

      // When the child exits (graceful stdin close, supervisor stop, crash),
      // end the lease and remove the FIFO. The watcher sees EOF, observes a
      // dead pid, and exits without signalling.
      process_.onExit(() => {
        lease.close();
        lease.cleanup();
      });

      return {
        sessionId,
        get pid(): number | undefined {
          return process_.pid;
        },
        // Transcript path is not yet derivable without the history adapter
        // (Task 19); undefined skips release-time transcript stabilization.
        transcriptPath: undefined,
        sendUser(requestId: string, text: string): void {
          process_.sendUser(requestId, sessionId, text);
        },
        closeInput(): void {
          process_.closeInput();
        },
        signal(sig: SignalName): void {
          process_.signal(sig);
        },
        alive(): boolean {
          return process_.alive();
        },
        awaitInit(timeoutMs: number): Promise<{ session_id: string }> {
          return process_.awaitInit(timeoutMs);
        },
      };
    },
  };
}
