// Minimal fake "claude" CLI for deterministic adapter/lease tests.
//
// Mirrors the Phase 0 (Claude Code 2.1.133) stream-json contract:
//
//   * records its full spawn args to a file (`--args-log <path>`)
//   * records every signal it receives (`--signals-log <path>`)
//   * records every raw stdin line verbatim (`--stdin-log <path>`)
//   * emits a `system/init` event echoing the `--session-id` (or `--resume`)
//     value
//   * optionally emits an event of an unknown type (`--emit-unknown`) so the
//     adapter's typed-unknown handling can be exercised
//   * replays each user message back with the same uuid and emits a synthetic
//     `assistant` + `result` event per turn
//   * stays alive until stdin closes; exits on SIGINT/SIGTERM
//
// Plain ESM, no dependencies, never talks to the network. The real CLI is
// only ever exercised by the (opt-in) compatibility gate in probes/.

import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

function parseArgs(argv) {
  const out = { argsLog: "", signalsLog: "", stdinLog: "", emitUnknown: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--args-log") {
      out.argsLog = next;
      i++;
    } else if (a === "--signals-log") {
      out.signalsLog = next;
      i++;
    } else if (a === "--stdin-log") {
      out.stdinLog = next;
      i++;
    } else if (a === "--emit-unknown") {
      out.emitUnknown = true;
    }
    // Every other flag belongs to the driver contract and is ignored here.
  }
  return out;
}

function parseSessionId(argv) {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--session-id" || argv[i] === "--resume") {
      return argv[i + 1];
    }
  }
  return "fake-session";
}

const opts = parseArgs(process.argv.slice(2));
const sessionId = parseSessionId(process.argv.slice(2));

// Record the exact spawn args (including our own fixture flags) as one JSON
// line so tests can assert the driver's argument order byte-for-byte.
if (opts.argsLog) {
  writeFileSync(opts.argsLog, JSON.stringify(process.argv.slice(2)) + "\n");
}

// Record received signals, then exit. appendFileSync is synchronous so the
// log entry lands before the process dies.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (opts.signalsLog) appendFileSync(opts.signalsLog, sig + "\n");
    process.exit(0);
  });
}

function write(obj) {
  output.write(JSON.stringify(obj) + "\n");
}

write({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  cwd: process.cwd(),
  tools: [],
  mcp_servers: [],
});

if (opts.emitUnknown) {
  // A well-formed NDJSON line whose `type` the adapter does not know.
  write({ type: "totally_new_event_kind", payload: { noise: true } });
}

const rl = readline.createInterface({ input, crlfDelay: Infinity });

try {
  for await (const line of rl) {
    if (opts.stdinLog) appendFileSync(opts.stdinLog, line + "\n");
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed?.type !== "user") continue;

    // Replay the user record so the adapter can verify uuid round-tripping.
    write({
      type: "user",
      uuid: parsed.uuid,
      session_id: sessionId,
      message: {
        role: "user",
        content: parsed.message?.content ?? [{ type: "text", text: "" }],
      },
      parent_tool_use_id: null,
    });

    write({
      type: "assistant",
      uuid: `assistant-${parsed.uuid}`,
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
      parent_tool_use_id: null,
    });

    // One result per turn; the process keeps running after this — only stdin
    // close or a signal ends it.
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      result: "ok",
      session_id: sessionId,
      total_cost_usd: 0,
    });
  }
} catch {
  // stdin closed mid-read; exit cleanly.
}

process.exitCode = 0;
