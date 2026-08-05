// Minimal fake "claude" CLI for deterministic driver tests.
//
// Mirrors the candidate 2.1.133 stream-json contract that the driver targets:
//
//   * reads NDJSON user messages from stdin (one JSON object per newline)
//   * emits a `system/init` event on stdout referencing the requested session_id
//   * echoes each replayed user message back as a `user` record with the same uuid
//   * emits a synthetic `assistant` + `result` event for each turn
//   * keeps stdin open after each `result` until the caller closes it
//
// Real Claude is the actual gate of compatibility; this fixture exists only to
// exercise the driver's framing, lifecycle, and replay handling without
// consuming API tokens.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// `--session-id <id>` is the canonical flag the driver uses for create mode.
// We accept either `--session-id` or `--resume` so resume-mode framing tests
// can reuse the same fixture; both yield the same init payload shape.
function parseSessionId(argv) {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--session-id" || argv[i] === "--resume") {
      return argv[i + 1];
    }
  }
  return "fake-session";
}

const sessionId = parseSessionId(process.argv.slice(2));

function write(obj) {
  output.write(JSON.stringify(obj) + "\n");
}

write({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  cwd: process.cwd(),
  tools: [],
  mcp_servers: []
});

const rl = readline.createInterface({ input, crlfDelay: Infinity });

try {
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // The driver is contractually required to send valid NDJSON; ignore
      // malformed input rather than crashing, so the framing tests stay
      // deterministic.
      continue;
    }
    if (parsed?.type !== "user") continue;

    // Echo the replayed user record back so the driver can verify UUID replay.
    write({
      type: "user",
      uuid: parsed.uuid,
      session_id: sessionId,
      message: {
        role: "user",
        content: parsed.message?.content ?? [{ type: "text", text: "" }]
      },
      parent_tool_use_id: null
    });

    // Synthetic assistant turn so the driver sees a non-user frame too.
    write({
      type: "assistant",
      uuid: `assistant-${parsed.uuid}`,
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }]
      },
      parent_tool_use_id: null
    });

    // One result per turn; the driver keeps stdin open after this until the
    // caller closes it.
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      result: "ok",
      session_id: sessionId,
      total_cost_usd: 0
    });
  }
} catch {
  // stdin closed mid-read in some Node versions before `for await` finalizes;
  // exit cleanly so the driver observes a zero exit code.
}

process.exitCode = 0;
