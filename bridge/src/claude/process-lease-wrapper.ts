/**
 * Process lease wrapper (spec §7.6).
 *
 * Every Claude child gets a dedicated lease: a 0600 FIFO plus a DETACHED
 * watcher process (`lease-watcher.mjs`). The Bridge opens the FIFO's write
 * end with O_RDWR|O_NONBLOCK — which never blocks and avoids the ENXIO
 * no-reader race — BEFORE spawning the watcher (for determinism), and holds
 * that fd for its whole lifetime.
 *
 *   * Bridge dies (any reason)  → kernel closes the fd → watcher sees EOF →
 *     escalates SIGINT → SIGTERM → SIGKILL against the Claude process group.
 *   * Claude dies first (clean  → watcher sees EOF, observes a dead pid,
 *     stop / release)            and exits without sending any signal.
 *
 * The watcher MUST be a separate process: an in-process watcher dies with
 * the Bridge and cannot act on its death.
 */

import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants as fsConstants, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutableFromPath } from "./process-factory.js";

const DEFAULT_MKFIFO_PATH = "/usr/bin/mkfifo";

/**
 * Resolve `mkfifo` from PATH the same way the factory resolves `claude`
 * (`resolveExecutableFromPath`): NixOS/Alpine do not guarantee
 * `/usr/bin/mkfifo`. Falls back to the historical absolute default only
 * when PATH has no match.
 */
export function resolveMkfifoPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveExecutableFromPath("mkfifo", env) ?? DEFAULT_MKFIFO_PATH;
}

export interface ProcessLeaseOptions {
  /** FIFO path, conventionally `<dataDir>/leases/<sessionId>.fifo`. */
  readonly fifoPath: string;
  /** Pid of the (detached, group-leading) Claude child. */
  readonly claudePid: number;
  /** Per-signal escalation wait in the watcher. Default: 5 s. */
  readonly waitMs?: number;
  /** Override for tests; defaults to the sibling lease-watcher.mjs. */
  readonly watcherScriptPath?: string;
  /** Override for tests; defaults to PATH-resolved mkfifo. */
  readonly mkfifoPath?: string;
}

export interface ProcessLease {
  readonly fifoPath: string;
  readonly watcherPid: number | undefined;
  /** Close the Bridge's write end (simulates Bridge death / ends the lease). */
  close(): void;
  /** Remove the FIFO file from disk. */
  cleanup(): void;
  /** Resolves with the watcher's exit code once it terminates. */
  exited(): Promise<number | null>;
}

function defaultWatcherScriptPath(): string {
  return fileURLToPath(new URL("./lease-watcher.mjs", import.meta.url));
}

/**
 * Create the lease FIFO, take the never-blocking write end, and spawn the
 * detached watcher. Idempotent-safe: a stale FIFO entry at {@link
 * ProcessLeaseOptions.fifoPath} is removed first.
 */
export function startProcessLeaseWrapper(options: ProcessLeaseOptions): ProcessLease {
  const waitMs = options.waitMs ?? 5000;
  const watcherScriptPath = options.watcherScriptPath ?? defaultWatcherScriptPath();
  const mkfifoPath = options.mkfifoPath ?? resolveMkfifoPath();

  mkdirSync(dirname(options.fifoPath), { recursive: true, mode: 0o700 });
  // Remove a stale entry from a previous (crashed) run; an existing open fd
  // on the old inode keeps working, so this never disturbs a live watcher.
  rmSync(options.fifoPath, { force: true });
  execFileSync(mkfifoPath, ["-m", "0600", options.fifoPath]);

  // Hold the write end for the Bridge's lifetime. O_RDWR|O_NONBLOCK never
  // blocks and cannot fail with ENXIO; opened BEFORE the watcher spawns for
  // determinism. The watcher opens its own end non-blocking too, so it can
  // never get stuck before its first read (see lease-watcher.mjs).
  let writeFd: number | undefined = openSync(
    options.fifoPath,
    fsConstants.O_RDWR | fsConstants.O_NONBLOCK,
  );

  const watcherArgs = [
    watcherScriptPath,
    "--fifo",
    options.fifoPath,
    "--pid",
    String(options.claudePid),
    "--wait-ms",
    String(waitMs),
  ];
  const watcher = spawn(process.execPath, watcherArgs, {
    stdio: "ignore",
    detached: true, // survives Bridge death — that is its whole purpose
  });
  watcher.unref();

  let closed = false;
  let cleaned = false;
  const exitedPromise = new Promise<number | null>((resolve) => {
    if (watcher.exitCode !== null || watcher.signalCode !== null) {
      resolve(watcher.exitCode);
      return;
    }
    // 'error' (e.g. ENOENT script path) fires without 'exit'; resolve either way.
    watcher.on("exit", (code) => resolve(code));
    watcher.on("error", () => resolve(null));
  });

  return {
    fifoPath: options.fifoPath,
    watcherPid: watcher.pid,
    close(): void {
      if (closed) return;
      closed = true;
      if (writeFd !== undefined) {
        const fd = writeFd;
        writeFd = undefined;
        try {
          closeSync(fd);
        } catch {
          // fd already closed by teardown ordering.
        }
      }
    },
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      rmSync(options.fifoPath, { force: true });
    },
    exited: () => exitedPromise,
  };
}
