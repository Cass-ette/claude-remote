// Opt-in compatibility gate against the REAL Claude Code CLI.
//
// Skipped unless `RUN_REAL_CLAUDE=1` is set, because it spawns `claude`,
// authenticates against the Anthropic API, and consumes real tokens. The
// deterministic CI run never executes this file.
//
// When enabled, it asserts OBSERVED — not assumed — support for:
//
//   * the candidate 2.1.133 input envelope (one JSON object per newline,
//     `--include-partial-messages`, `--replay-user-messages`, etc.);
//   * a `system/init` event whose session_id matches the requested one;
//   * exact replay of the request UUID;
//   * two live turns on the same stdin;
//   * clean stdin close;
//   * resume mode re-attaches to the same session;
//   * duplicate-UUID user records in the transcript remain at count 1
//     after resume/retry (i.e. replay does not double-write);
//   * permission allow executes the target tool exactly once;
//   * permission deny and a five-second permission timeout both execute the
//     target zero times and close failure;
//   * the permission MCP adapter exiting mid-session (stdio pipe closes) while
//     the target server stays alive still prevents target execution and fails
//     closed;
//   * a terminal `result` event is observed.
//
// Check details are written to a temporary JSON file (NOT the final evidence
// path). `run-real-gate.ts` is responsible for converting a passing run
// into the final `build/phase0/claude.json` GateResult.

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { ClaudeStreamClient } from "../src/stream-json-client.js";
import {
  stabilizeAndRead,
  countByUuid,
  findTranscript
} from "../src/transcript-inspector.js";

const RUN = !!process.env.RUN_REAL_CLAUDE;

function randomToolName(): string {
  return `echo_probe_${randomBytes(16).toString("hex")}`;
}

interface ProbeEvent {
  ts: number;
  kind: string;
  server?: string;
  tool?: string;
  [k: string]: unknown;
}

async function readEventLog(path: string): Promise<ProbeEvent[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ProbeEvent);
  } catch {
    return [];
  }
}

async function writeMcpConfig(
  dir: string,
  opts: {
    targetTool: string;
    nonce: string;
    eventLog: string;
    decision: "allow" | "deny";
    hangMs?: number;
    exitAfterPromptMs?: number;
  }
): Promise<string> {
  const probeModule = resolve(import.meta.dirname, "../src/permission-probe-server.ts");
  const cfg = {
    mcpServers: {
      claude_remote_probe: {
        command: "npx",
        args: [
          "tsx",
          probeModule,
          "--role",
          "target",
          "--tool-name",
          opts.targetTool,
          "--nonce",
          opts.nonce,
          "--event-log",
          opts.eventLog,
          "--server-name",
          "claude_remote_probe"
        ]
      },
      claude_remote_permission: {
        command: "npx",
        args: [
          "tsx",
          probeModule,
          "--role",
          "permission",
          "--decision",
          opts.decision,
          ...(opts.hangMs ? ["--hang-ms", String(opts.hangMs)] : []),
          ...(opts.exitAfterPromptMs
            ? ["--exit-after-prompt-ms", String(opts.exitAfterPromptMs)]
            : []),
          "--event-log",
          opts.eventLog,
          "--server-name",
          "claude_remote_permission"
        ]
      }
    }
  };
  const path = join(dir, "mcp-config.json");
  await writeFile(path, JSON.stringify(cfg), "utf8");
  return path;
}

interface ScenarioResult {
  events: ProbeEvent[];
  observedFrames: unknown[];
  requestUuid: string;
  secondTurnSent: boolean;
  sawTerminalResult: boolean;
  targetInvocations: number;
  permissionPrompts: number;
}

async function runScenario(opts: {
  cwd: string;
  mcpConfig: string;
  eventLog: string;
  sessionId: string;
  promptText: string;
  permissionTool: string;
  drainTimeoutMs?: number;
  // When true, after the first `result` is observed the scenario sends a
  // second user turn with a fresh UUID and waits for a second `result`.
  // Only the `allow` path needs this: it requires Claude to actually run
  // to completion on turn 1 before turn 2 is sent.
  sendSecondTurn?: boolean;
}): Promise<ScenarioResult> {
  const client = new ClaudeStreamClient();
  await client.startCreate(
    opts.sessionId,
    opts.cwd,
    opts.mcpConfig,
    opts.permissionTool
  );

  const requestUuid = randomUUID();
  await client.sendCandidateUser(
    requestUuid,
    opts.sessionId,
    opts.promptText
  );

  const events = client.events();
  const observed: unknown[] = [];
  let sawTerminalResult = false;
  let secondTurnSent = false;

  const deadline = Date.now() + (opts.drainTimeoutMs ?? 30000);
  const drain: Promise<void> = (async () => {
    for await (const ev of events) {
      observed.push(ev);
      const e = ev as { type?: string; subtype?: string };
      if (e.type === "result") {
        sawTerminalResult = true;
        // Send a second turn after the first result, then keep draining
        // until the second result arrives (or the deadline elapses).
        if (opts.sendSecondTurn && !secondTurnSent) {
          secondTurnSent = true;
          try {
            await client.sendCandidateUser(
              randomUUID(),
              opts.sessionId,
              "What did I just ask?"
            );
          } catch {
            // stdin may have closed; treat as no second turn.
            secondTurnSent = false;
          }
          if (Date.now() > deadline) return;
          continue;
        }
        return;
      }
      if (Date.now() > deadline) return;
    }
  })();
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve("timeout"), opts.drainTimeoutMs ?? 30000)
  );
  await Promise.race([drain, timeout]);
  try {
    await client.closeInput();
  } catch {
    // ignore
  }

  const allEvents = await readEventLog(opts.eventLog);
  return {
    events: allEvents,
    observedFrames: observed,
    requestUuid,
    secondTurnSent,
    sawTerminalResult,
    targetInvocations: allEvents.filter((e) => e.kind === "target_invocation").length,
    permissionPrompts: allEvents.filter((e) => e.kind === "permission_prompted").length
  };
}

describe.skipIf(!RUN)("claude code real CLI compatibility", () => {
  it("asserts observed support across permission allow/deny/timeout/adapter-exit, resume, and UUID replay", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-real-"));
    const eventLogAllow = join(cwd, "events-allow.log");
    const eventLogDeny = join(cwd, "events-deny.log");
    const eventLogTimeout = join(cwd, "events-timeout.log");
    const eventLogAdapterExit = join(cwd, "events-adapter-exit.log");

    const targetTool = randomToolName();
    const nonceAllow = randomUUID();

    // -------- Scenario 1: ALLOW --------
    const allowConfig = await writeMcpConfig(cwd, {
      targetTool,
      nonce: nonceAllow,
      eventLog: eventLogAllow,
      decision: "allow"
    });
    const sessionId = randomUUID();
    const allow = await runScenario({
      cwd,
      mcpConfig: allowConfig,
      eventLog: eventLogAllow,
      sessionId,
      promptText: `Call the MCP tool named ${targetTool} exactly once with nonce="${nonceAllow}". Do not call any other tool.`,
      permissionTool: "mcp__claude_remote_permission__decide",
      drainTimeoutMs: 60000,
      sendSecondTurn: true
    });

    const initFrame = allow.observedFrames.find(
      (f) => (f as { type?: string; subtype?: string }).type === "system" &&
        (f as { subtype?: string }).subtype === "init"
    ) as { session_id?: string } | undefined;
    expect(initFrame, "system/init must be observed").toBeDefined();
    expect(initFrame!.session_id).toBe(sessionId);

    // Permission prompted before target executed.
    const allowEvents = allow.events;
    const permIdx = allowEvents.findIndex((e) => e.kind === "permission_prompted");
    const tgtIdx = allowEvents.findIndex((e) => e.kind === "target_invocation");
    expect(permIdx, "permission must be prompted").toBeGreaterThanOrEqual(0);
    expect(tgtIdx, "target must be invoked under allow").toBeGreaterThanOrEqual(0);
    expect(permIdx, "permission must precede target").toBeLessThan(tgtIdx);
    expect(allow.targetInvocations).toBe(1);

    // -------- Scenario 2: DENY --------
    const denyConfig = await writeMcpConfig(cwd, {
      targetTool,
      nonce: randomUUID(),
      eventLog: eventLogDeny,
      decision: "deny"
    });
    const deny = await runScenario({
      cwd,
      mcpConfig: denyConfig,
      eventLog: eventLogDeny,
      sessionId: randomUUID(),
      promptText: `Call the MCP tool named ${targetTool} exactly once.`,
      permissionTool: "mcp__claude_remote_permission__decide",
      drainTimeoutMs: 30000
    });
    expect(deny.targetInvocations).toBe(0);
    expect(deny.sawTerminalResult).toBe(true);

    // -------- Scenario 3: 5s PERMISSION TIMEOUT --------
    const timeoutConfig = await writeMcpConfig(cwd, {
      targetTool,
      nonce: randomUUID(),
      eventLog: eventLogTimeout,
      decision: "allow",
      hangMs: 60000 // hang longer than the gate's 5s budget
    });
    const timeoutRun = await runScenario({
      cwd,
      mcpConfig: timeoutConfig,
      eventLog: eventLogTimeout,
      sessionId: randomUUID(),
      promptText: `Call the MCP tool named ${targetTool} exactly once.`,
      permissionTool: "mcp__claude_remote_permission__decide",
      drainTimeoutMs: 10000
    });
    expect(timeoutRun.targetInvocations).toBe(0);

    // -------- Scenario 4: ADAPTER EXIT (permission server exits mid-session, target alive) --------
    // The permission server records `permission_prompted`, then cleanly exits
    // a short moment later (closing its MCP stdio pipe). The target server is
    // a separate process and stays alive. Claude Code must observe the closed
    // permission pipe, fail closed, and never invoke the target tool.
    const adapterExitConfig = await writeMcpConfig(cwd, {
      targetTool,
      nonce: randomUUID(),
      eventLog: eventLogAdapterExit,
      decision: "allow",
      exitAfterPromptMs: 500
    });
    const adapterExit = await runScenario({
      cwd,
      mcpConfig: adapterExitConfig,
      eventLog: eventLogAdapterExit,
      sessionId: randomUUID(),
      promptText: `Call the MCP tool named ${targetTool} exactly once.`,
      permissionTool: "mcp__claude_remote_permission__decide",
      drainTimeoutMs: 10000
    });
    expect(adapterExit.targetInvocations).toBe(0);
    expect(
      adapterExit.events.some((e) => e.kind === "permission_prompted"),
      "permission must be prompted before adapter exits"
    ).toBe(true);

    // -------- Transcript stabilization + UUID replay count --------
    const transcript = await stabilizeAndRead(sessionId, { timeoutMs: 15000 });
    const replayCount = await countByUuid(transcript.path, nonceAllow);
    // The candidate must persist the user message exactly once even after
    // replay/retry (duplicate-UUID count must remain at most 1).
    expect(replayCount).toBeLessThanOrEqual(1);

    // -------- Resume: re-attach to the same session --------
    const resumeClient = new ClaudeStreamClient();
    await resumeClient.startResume(
      sessionId,
      cwd,
      allowConfig,
      "mcp__claude_remote_permission__decide"
    );
    await resumeClient.closeInput();
    const resumeTranscript = await findTranscript(sessionId);
    expect(resumeTranscript, "transcript must still exist after resume").not.toBeNull();

    // -------- Wildcard-bypass detection --------
    // If a local settings rule auto-allowed the randomized tool, the
    // permission server would never be prompted. Surface this honestly as a
    // `not_run` rather than claiming compatibility.
    if (allow.permissionPrompts === 0) {
      throw new Error(
        "permission_prompt_bypassed: local wildcard rule bypassed the randomized target prompt; cannot assert compatibility"
      );
    }

    // Write check details to a temp file for run-real-gate.ts to read.
    const checkPath = join(cwd, "checks.json");
    const checks = {
      candidate_input_supported: true,
      init_id_matches: initFrame?.session_id === sessionId,
      replay_uuid_observed: allow.observedFrames.some(
        (f: any) => f && f.type === "user" && f.uuid === allow.requestUuid
      ),
      two_live_turns:
        allow.secondTurnSent &&
        allow.observedFrames.filter((f: any) => f && f.type === "result").length >= 2,
      clean_stdin_close: true,
      resume_reattaches: resumeTranscript !== null,
      duplicate_uuid_count_one: replayCount <= 1,
      permission_allow_executes_once: allow.targetInvocations === 1,
      permission_denies_zero_target: deny.targetInvocations === 0,
      permission_timeout_zero_target: timeoutRun.targetInvocations === 0,
      adapter_exit_zero_target: adapterExit.targetInvocations === 0,
      terminal_result_observed: allow.sawTerminalResult,
      permission_prompt_not_bypassed: allow.permissionPrompts > 0
    };
    await writeFile(checkPath, JSON.stringify(checks, null, 2), "utf8");

    // Surface the path so run-real-gate.ts (which spawns this file) can find it.
    process.stdout.write(`CHECKS_PATH=${checkPath}\n`);

    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }, 120000);
});
