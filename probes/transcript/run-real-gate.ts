// Process-level wrapper for the opt-in transcript compatibility gate.
//
// Requires `REAL_TRANSCRIPT_MANIFEST=/abs/path/to/manifest.json`. The manifest
// is an array of `{ path: string, expectedCoverage: string[] }` pointing at
// COPIES (never originals) of transcript files. The wrapper:
//
//   1. Validates the manifest env var and every path (absolute + readable).
//   2. Hashes every file BEFORE running the focused test.
//   3. Spawns `vitest run adapter.test.ts` with REAL_TRANSCRIPT_MANIFEST
//      exported in the child env and a two-minute deadline.
//   4. On timeout: SIGTERM (5s grace) then SIGKILL on the process group.
//   5. Hashes every file AFTER; mismatch -> `failed`.
//   6. Validates the aggregate coverage union includes user/assistant/tool/
//      completed/failed/interrupted.
//   7. Emits a GateResult to `build/phase0/transcript.json`.
//
// Failure modes -> GateResult mapping:
//   * missing REAL_TRANSCRIPT_MANIFEST / unreadable manifest / missing path -> not_run
//   * spawn crash / signal / nonzero exit / malformed output / timeout -> failed
//   * all checks pass + every hash unchanged + coverage union complete -> passed
//   * hash mismatch on any input -> failed
//   * coverage union missing a label -> failed

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateResult } from "../run-phase0.js";
import { mapOutcomeToGateResult, type RealChecksOutput } from "./map-outcome.js";

export { mapOutcomeToGateResult, REQUIRED_COVERAGE_LABELS } from "./map-outcome.js";
export type { Outcome, RealChecksOutput, MapOptions } from "./map-outcome.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const testFile = resolve(here, "test/adapter.test.ts");
const evidencePath = resolve(here, "../../build/phase0/transcript.json");

interface ManifestEntry {
  path: string;
  expectedCoverage: string[];
}

async function sha256(p: string): Promise<string> {
  const bytes = await readFile(p);
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathReadable(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function emit(result: GateResult): Promise<void> {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");
}

function prereqNotRun(
  checkName: string,
  reason: string,
  evidenceKey: string,
  evidenceValue: string | number | boolean,
  startedAt: string
): GateResult {
  return mapOutcomeToGateResult(
    { kind: "missing_prereq", checkName, reason, evidenceKey, evidenceValue },
    { startedAt, finishedAt: new Date().toISOString() }
  );
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const manifestPath = process.env.REAL_TRANSCRIPT_MANIFEST;

  // 1. Prerequisites.
  if (!manifestPath) {
    await emit(
      prereqNotRun(
        "manifest_env",
        "REAL_TRANSCRIPT_MANIFEST not set",
        "manifest_set",
        false,
        startedAt
      )
    );
    process.stderr.write("transcript gate: not_run — REAL_TRANSCRIPT_MANIFEST not set\n");
    return 0;
  }
  if (!manifestPath.startsWith("/")) {
    await emit(
      prereqNotRun(
        "manifest_absolute",
        "REAL_TRANSCRIPT_MANIFEST must be an absolute path",
        "manifest_absolute",
        false,
        startedAt
      )
    );
    process.stderr.write("transcript gate: not_run — manifest path not absolute\n");
    return 0;
  }
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (err) {
    await emit(
      prereqNotRun(
        "manifest_readable",
        `cannot read manifest: ${(err as Error).message}`,
        "manifest_readable",
        false,
        startedAt
      )
    );
    process.stderr.write(`transcript gate: not_run — manifest unreadable\n`);
    return 0;
  }
  let manifest: ManifestEntry[];
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    await emit(
      prereqNotRun(
        "manifest_json",
        `manifest is not valid JSON: ${(err as Error).message}`,
        "manifest_json",
        false,
        startedAt
      )
    );
    process.stderr.write(`transcript gate: not_run — manifest not JSON\n`);
    return 0;
  }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    await emit(
      prereqNotRun(
        "manifest_entries",
        "manifest must be a non-empty array",
        "manifest_entries",
        0,
        startedAt
      )
    );
    process.stderr.write("transcript gate: not_run — manifest empty\n");
    return 0;
  }
  for (const entry of manifest) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !Array.isArray(entry.expectedCoverage)
    ) {
      await emit(
        prereqNotRun(
          "manifest_shape",
          "manifest entry must have path:string and expectedCoverage:string[]",
          "manifest_shape",
          false,
          startedAt
        )
      );
      process.stderr.write("transcript gate: not_run — malformed manifest entry\n");
      return 0;
    }
    if (!entry.path.startsWith("/")) {
      await emit(
        prereqNotRun(
          "manifest_path_absolute",
          `manifest path must be absolute: ${entry.path}`,
          "manifest_path_absolute",
          false,
          startedAt
        )
      );
      process.stderr.write(`transcript gate: not_run — path not absolute: ${entry.path}\n`);
      return 0;
    }
    if (!(await pathReadable(entry.path))) {
      await emit(
        prereqNotRun(
          "manifest_path_readable",
          `manifest path not readable: ${entry.path}`,
          "manifest_path_readable",
          false,
          startedAt
        )
      );
      process.stderr.write(`transcript gate: not_run — path unreadable: ${entry.path}\n`);
      return 0;
    }
  }

  // 2. Hash every input BEFORE.
  const before: Record<string, string> = {};
  for (const entry of manifest) {
    before[entry.path] = await sha256(entry.path);
  }

  // 3. Spawn focused vitest with REAL_TRANSCRIPT_MANIFEST exported.
  const child = spawn(
    "npx",
    ["vitest", "run", testFile, "--reporter=basic"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, REAL_TRANSCRIPT_MANIFEST: manifestPath },
      detached: true
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

  const DEADLINE_MS = 2 * 60 * 1000;
  let timedOut = false;

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (res) => {
      child.on("exit", (code, signal) => res({ code, signal }));
      child.on("error", () => res({ code: -1, signal: null }));
    }
  );
  const timer = setTimeout(() => {
    timedOut = true;
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

  const exitOutcome = await exitPromise;
  clearTimeout(timer);
  const finishedAt = new Date().toISOString();

  if (timedOut) {
    await emit(
      mapOutcomeToGateResult(
        { kind: "timeout", deadlineMs: DEADLINE_MS },
        { startedAt, finishedAt }
      )
    );
    process.stderr.write("transcript gate: failed — timed out\n");
    return 0;
  }

  if (exitOutcome.signal) {
    await emit(
      mapOutcomeToGateResult(
        { kind: "signal", signal: exitOutcome.signal },
        { startedAt, finishedAt }
      )
    );
    process.stderr.write(`transcript gate: failed — signal ${exitOutcome.signal}\n`);
    return 0;
  }

  if ((exitOutcome.code ?? -1) !== 0) {
    const tail = stderr.slice(-500);
    await emit(
      mapOutcomeToGateResult(
        { kind: "nonzero", code: exitOutcome.code, stderrTail: tail },
        { startedAt, finishedAt }
      )
    );
    process.stderr.write(`transcript gate: failed — vitest exit ${exitOutcome.code}\n`);
    return 0;
  }

  // 4. Parse the CHECKS_PATH emitted by the test.
  const m = stdout.match(/CHECKS_PATH=(\S+)/);
  if (!m || !m[1]) {
    await emit(
      mapOutcomeToGateResult(
        { kind: "checks_not_emitted", reason: "test did not emit CHECKS_PATH" },
        { startedAt, finishedAt }
      )
    );
    process.stderr.write("transcript gate: failed — no CHECKS_PATH\n");
    return 0;
  }
  let checksText: string;
  try {
    checksText = await readFile(m[1], "utf8");
  } catch (err) {
    await emit(
      mapOutcomeToGateResult(
        { kind: "checks_unreadable", reason: `cannot read checks file: ${(err as Error).message}` },
        { startedAt, finishedAt }
      )
    );
    process.stderr.write("transcript gate: failed — checks file unreadable\n");
    return 0;
  }
  let checksParsed: unknown;
  try {
    checksParsed = JSON.parse(checksText);
  } catch (err) {
    await emit(
      mapOutcomeToGateResult(
        { kind: "checks_malformed_json", reason: `malformed checks JSON: ${(err as Error).message}` },
        { startedAt, finishedAt }
      )
    );
    process.stderr.write("transcript gate: failed — checks JSON malformed\n");
    return 0;
  }

  const checks = checksParsed as Partial<RealChecksOutput> | null;
  if (!checks || !Array.isArray(checks.coverageUnion) || !Array.isArray(checks.perEntry)) {
    await emit(
      mapOutcomeToGateResult(
        { kind: "checks_bad_shape", reason: "checks file missing coverageUnion/perEntry" },
        { startedAt, finishedAt }
      )
    );
    process.stderr.write("transcript gate: failed — checks shape\n");
    return 0;
  }

  // 5. Independent re-hash to confirm the test's claim.
  const after: Record<string, string> = {};
  for (const entry of manifest) {
    after[entry.path] = await sha256(entry.path);
  }

  const result = mapOutcomeToGateResult(
    { kind: "checks", checks: checks as RealChecksOutput, before, after },
    { startedAt, finishedAt }
  );
  await emit(result);
  process.stderr.write(
    `transcript gate: ${result.status} — ${result.checks.length} checks\n`
  );
  return 0;
}

main().catch((err) => {
  process.stderr.write(`run-real-gate: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
