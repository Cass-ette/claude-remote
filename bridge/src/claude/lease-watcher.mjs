// Lease watcher (spec §7.6) — runs as a SEPARATE, detached process.
//
// An in-process watcher would die with the Bridge and could not act, so the
// Bridge spawns this script for every Claude child. The Bridge holds the
// write end of a 0600 FIFO for its whole lifetime; when that end closes
// (normal teardown OR Bridge crash), the read side sees EOF.
//
// On EOF:
//   * Claude pid already dead  → exit 0 silently (clean stop/release path —
//     the supervisor killed Claude first, so no signals are needed).
//   * Claude pid still alive   → escalate SIGINT → wait → SIGTERM → wait →
//     SIGKILL against the whole process GROUP (process.kill(-pid, sig)), so
//     orphaned MCP servers die with the CLI, then exit 0.
//
// Usage: node lease-watcher.mjs --fifo <path> --pid <claudePid> --wait-ms <n>
//
// Plain ESM, no dependencies, no imports from the Bridge build: it must run
// from source or dist with only the Node runtime present.

function parseArgs(argv) {
  const out = { fifo: "", pid: 0, waitMs: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--fifo") {
      out.fifo = next ?? "";
      i++;
    } else if (a === "--pid") {
      out.pid = Number(next);
      i++;
    } else if (a === "--wait-ms") {
      out.waitMs = Number(next);
      i++;
    } else {
      throw new Error(`unknown lease-watcher argument: ${a}`);
    }
  }
  if (!out.fifo) throw new Error("--fifo is required");
  if (!Number.isInteger(out.pid) || out.pid <= 0) {
    throw new Error(`--pid must be a positive integer, got ${out.pid}`);
  }
  if (!Number.isFinite(out.waitMs) || out.waitMs < 0) {
    throw new Error(`--wait-ms must be a non-negative number, got ${out.waitMs}`);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Signal-0 probe: true when the pid is still alive (or an unreaped zombie). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Send a signal to the entire process group led by `pid`; never throws. */
function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    // ESRCH (group gone) / EPERM — nothing left to signal.
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { open } = await import("node:fs/promises");
  const { constants } = await import("node:fs");

  // O_RDONLY|O_NONBLOCK never blocks and never fails, so the watcher cannot
  // get stuck before its first read even when the Bridge already died and
  // the write end no longer exists. Read semantics (verified on macOS and
  // per POSIX):
  //   * writers exist, no data → EAGAIN  → the Bridge still lives, wait
  //   * no writer at all       → 0 (EOF) → the Bridge end closed — act
  const fh = await open(opts.fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let bytesRead;
    try {
      bytesRead = (await fh.read(buf, 0, buf.length, null)).bytesRead;
    } catch (err) {
      if (err && typeof err === "object" && err.code === "EAGAIN") {
        await sleep(50); // writer alive, nothing to read yet
        continue;
      }
      throw err;
    }
    if (bytesRead === 0) break; // EOF: every writer (the Bridge) is gone
    // Any written bytes are drained and ignored; only the write end's
    // lifetime matters.
  }
  await fh.close();

  // Clean-exit path: the supervisor already stopped Claude.
  if (!pidAlive(opts.pid)) process.exit(0);

  // Bridge-death path: escalate against the group.
  const order = ["SIGINT", "SIGTERM", "SIGKILL"];
  for (const sig of order) {
    if (!pidAlive(opts.pid)) break;
    killGroup(opts.pid, sig);
    if (sig !== "SIGKILL") await sleep(opts.waitMs);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`lease-watcher: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
