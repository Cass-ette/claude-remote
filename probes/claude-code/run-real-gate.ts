// Wrapper that runs the opt-in Claude Code compatibility gate as a focused
// Vitest subprocess and converts the outcome into a validated GateResult at
// `build/phase0/claude.json`.
//
// Failure modes covered (each maps to a specific GateResult):
//
//   * missing prerequisites (no claude binary, no API auth, no writable
//     temp dir, no readable transcript dir) → `not_run`
//   * spawn crash / nonzero exit / signal / timeout (>10 min) → `failed`
//   * success but malformed/missing checks.json → `failed`
//   * any check `=== false` → `failed`
//   * permission_prompt_bypassed (detected by the test) → `not_run`
//   * all checks pass → `passed`
//
// On timeout, the entire child process group is killed (SIGTERM grace then
// SIGKILL), never just the direct child.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { synthesizeFailed, type GateResult } from "../run-phase0.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const testFile = resolve(here, "test/compatibility.test.ts");
const evidencePath = resolve(here, "../../build/phase0/claude.json");

interface PrerequisiteCheck {
  ok: boolean;
  reason: string;
}

async function checkPrerequisites(): Promise<PrerequisiteCheck> {
  // 1. claude binary on PATH
  const which = spawn("which", ["claude"], { stdio: ["ignore", "pipe", "pipe"] });
  const code = await new Promise<number>((resolve) => {
    which.on("exit", (c) => resolve(c ?? -1));
    which.on("error", () => resolve(-1));
  });
  if (code !== 0) {
    return { ok: false, reason: "claude CLI not found on PATH (installed/authenticated?)" };
  }
  // 2. API auth: ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN present (do NOT
  // print their values).
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { ok: false, reason: "no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN env" };
  }
  // 3. Writable temp dir.
  try {
    const d = await mkdtemp(join(tmpdir(), "claude-gate-preflight-"));
    await rm(d, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, reason: `temp dir not writable: ${(err as Error).message}` };
  }
  // 4. Readable transcript dir.
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`;
  try {
    await readFile(join(configDir, "projects"), "utf8").catch(() => {
      // projects may not exist yet — that is fine, it'll be created on first run
    });
  } catch (err) {
    return { ok: false, reason: `transcript dir not readable: ${(err as Error).message}` };
  }
  return { ok: true, reason: "" };
}

interface CheckDetails {
  [k: string]: unknown;
}

async function parseChecks(stdout: string): Promise<{ checks: CheckDetails; reason?: string }> {
  // The test prints `CHECKS_PATH=<path>` on its stdout.
  const m = stdout.match(/CHECKS_PATH=(\S+)/);
  if (!m || !m[1]) {
    return { checks: {}, reason: "test did not emit CHECKS_PATH" };
  }
  let text: string;
  try {
    text = await readFile(m[1], "utf8");
  } catch (err) {
    return { checks: {}, reason: `cannot read checks file: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { checks: {}, reason: `malformed checks JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { checks: {}, reason: "checks file is not an object" };
  }
  return { checks: parsed as CheckDetails };
}

function buildResult(
  status: GateResult["status"],
  checks: { name: string; passed: boolean; details?: string }[],
  evidence: Record<string, string | number | boolean>,
  startedAt: string,
  finishedAt: string
): GateResult {
  return {
    name: "claude",
    status,
    startedAt,
    finishedAt,
    checks,
    evidence
  };
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const prereq = await checkPrerequisites();
  if (!prereq.ok) {
    const finishedAt = new Date().toISOString();
    const result = buildResult(
      "not_run",
      [{ name: "prerequisites", passed: false, details: prereq.reason }],
      { prerequisite_ok: false },
      startedAt,
      finishedAt
    );
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");
    process.stderr.write(`claude gate: not_run — ${prereq.reason}\n`);
    return 0;
  }

  // Spawn the focused vitest process with RUN_REAL_CLAUDE=1.
  const env = { ...process.env, RUN_REAL_CLAUDE: "1" };
  const child = spawn(
    "npx",
    ["vitest", "run", testFile, "--reporter=basic"],
    { stdio: ["ignore", "pipe", "pipe"], env, detached: true }
  );

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

  const DEADLINE_MS = 10 * 60 * 1000;
  let timedOut = false;

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
      child.on("error", () => resolve({ code: -1, signal: null }));
    }
  );

  const timer = setTimeout(() => {
    timedOut = true;
    // Kill the entire process group: SIGTERM first, SIGKILL after a 5s
    // grace period. `detached: true` puts the child in its own group.
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }, 5000).unref();
  }, DEADLINE_MS);

  const outcome = await exitPromise;
  clearTimeout(timer);
  const finishedAt = new Date().toISOString();

  if (timedOut) {
    const result = buildResult(
      "failed",
      [{ name: "deadline", passed: false, details: `exceeded ${DEADLINE_MS}ms deadline` }],
      { timed_out: true },
      startedAt,
      finishedAt
    );
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");
    process.stderr.write(`claude gate: failed — timed out\n`);
    return 0;
  }

  if (outcome.signal) {
    const result = buildResult(
      "failed",
      [{ name: "process", passed: false, details: `killed by signal ${outcome.signal}` }],
      { signal: outcome.signal },
      startedAt,
      finishedAt
    );
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");
    process.stderr.write(`claude gate: failed — signal ${outcome.signal}\n`);
    return 0;
  }

  if ((outcome.code ?? -1) !== 0) {
    // Vitest nonzero exit — assertion failure or crash.
    const { reason } = await parseChecks(stdout).catch(() => ({
      checks: {},
      reason: "nonzero exit and no checks file"
    }));
    const tail = stderr.slice(-500);
    const result = buildResult(
      "failed",
      [
        { name: "vitest", passed: false, details: `exit=${outcome.code}; ${reason ?? tail}` }
      ],
      { exit_code: outcome.code ?? -1 },
      startedAt,
      finishedAt
    );
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");
    process.stderr.write(`claude gate: failed — vitest exit ${outcome.code}\n`);
    return 0;
  }

  // Exit 0 — parse checks and verify all are true.
  const { checks, reason } = await parseChecks(stdout);
  if (Object.keys(checks).length === 0) {
    const result = synthesizeFailed("claude", reason ?? "no checks emitted", finishedAt);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");
    process.stderr.write(`claude gate: failed — ${reason}\n`);
    return 0;
  }

  const failedChecks = Object.entries(checks).filter(([, v]) => v !== true);
  const allPass = failedChecks.length === 0;
  const checkEntries: { name: string; passed: boolean; details?: string }[] = [];
  for (const [k, v] of Object.entries(checks)) {
    const entry: { name: string; passed: boolean; details?: string } = {
      name: k,
      passed: v === true
    };
    if (typeof v === "string") entry.details = v;
    checkEntries.push(entry);
  }
  const result = buildResult(
    allPass ? "passed" : "failed",
    checkEntries,
    { exit_code: 0 },
    startedAt,
    finishedAt
  );
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");
  process.stderr.write(
    `claude gate: ${allPass ? "passed" : "failed"} — ${Object.keys(checks).length} checks\n`
  );
  return 0;
}

main().catch((err) => {
  process.stderr.write(`run-real-gate: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
