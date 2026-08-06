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

function buildResult(
  status: GateResult["status"],
  checks: { name: string; passed: boolean; details?: string }[],
  evidence: Record<string, string | number | boolean>,
  startedAt: string,
  finishedAt: string
): GateResult {
  return {
    name: "transcript",
    status,
    startedAt,
    finishedAt,
    checks,
    evidence
  };
}

async function emit(result: GateResult): Promise<void> {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const manifestPath = process.env.REAL_TRANSCRIPT_MANIFEST;

  // 1. Prerequisites.
  if (!manifestPath) {
    await emit(
      buildResult(
        "not_run",
        [{ name: "manifest_env", passed: false, details: "REAL_TRANSCRIPT_MANIFEST not set" }],
        { manifest_set: false },
        startedAt,
        new Date().toISOString()
      )
    );
    process.stderr.write("transcript gate: not_run — REAL_TRANSCRIPT_MANIFEST not set\n");
    return 0;
  }
  if (!manifestPath.startsWith("/")) {
    await emit(
      buildResult(
        "not_run",
        [
          {
            name: "manifest_absolute",
            passed: false,
            details: "REAL_TRANSCRIPT_MANIFEST must be an absolute path"
          }
        ],
        { manifest_absolute: false },
        startedAt,
        new Date().toISOString()
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
      buildResult(
        "not_run",
        [
          {
            name: "manifest_readable",
            passed: false,
            details: `cannot read manifest: ${(err as Error).message}`
          }
        ],
        { manifest_readable: false },
        startedAt,
        new Date().toISOString()
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
      buildResult(
        "not_run",
        [
          {
            name: "manifest_json",
            passed: false,
            details: `manifest is not valid JSON: ${(err as Error).message}`
          }
        ],
        { manifest_json: false },
        startedAt,
        new Date().toISOString()
      )
    );
    process.stderr.write(`transcript gate: not_run — manifest not JSON\n`);
    return 0;
  }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    await emit(
      buildResult(
        "not_run",
        [
          {
            name: "manifest_entries",
            passed: false,
            details: "manifest must be a non-empty array"
          }
        ],
        { manifest_entries: 0 },
        startedAt,
        new Date().toISOString()
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
        buildResult(
          "not_run",
          [
            {
              name: "manifest_shape",
              passed: false,
              details: "manifest entry must have path:string and expectedCoverage:string[]"
            }
          ],
          { manifest_shape: false },
          startedAt,
          new Date().toISOString()
        )
      );
      process.stderr.write("transcript gate: not_run — malformed manifest entry\n");
      return 0;
    }
    if (!entry.path.startsWith("/")) {
      await emit(
        buildResult(
          "not_run",
          [
            {
              name: "manifest_path_absolute",
              passed: false,
              details: `manifest path must be absolute: ${entry.path}`
            }
          ],
          { manifest_path_absolute: false },
          startedAt,
          new Date().toISOString()
        )
      );
      process.stderr.write(`transcript gate: not_run — path not absolute: ${entry.path}\n`);
      return 0;
    }
    if (!(await pathReadable(entry.path))) {
      await emit(
        buildResult(
          "not_run",
          [
            {
              name: "manifest_path_readable",
              passed: false,
              details: `manifest path not readable: ${entry.path}`
            }
          ],
          { manifest_path_readable: false },
          startedAt,
          new Date().toISOString()
        )
      );
      process.stderr.write(`transcript gate: not_run — path unreadable: ${entry.path}\n`);
      return 0;
    }
  }

  // 2. Hash every input BEFORE.
  const before = new Map<string, string>();
  for (const entry of manifest) {
    before.set(entry.path, await sha256(entry.path));
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

  const outcome = await exitPromise;
  clearTimeout(timer);
  const finishedAt = new Date().toISOString();

  if (timedOut) {
    await emit(
      buildResult(
        "failed",
        [{ name: "deadline", passed: false, details: `exceeded ${DEADLINE_MS}ms deadline` }],
        { timed_out: true },
        startedAt,
        finishedAt
      )
    );
    process.stderr.write("transcript gate: failed — timed out\n");
    return 0;
  }

  if (outcome.signal) {
    await emit(
      buildResult(
        "failed",
        [{ name: "process", passed: false, details: `killed by signal ${outcome.signal}` }],
        { signal: outcome.signal },
        startedAt,
        finishedAt
      )
    );
    process.stderr.write(`transcript gate: failed — signal ${outcome.signal}\n`);
    return 0;
  }

  if ((outcome.code ?? -1) !== 0) {
    const tail = stderr.slice(-500);
    await emit(
      buildResult(
        "failed",
        [
          {
            name: "vitest",
            passed: false,
            details: `exit=${outcome.code}; ${tail}`
          }
        ],
        { exit_code: outcome.code ?? -1 },
        startedAt,
        finishedAt
      )
    );
    process.stderr.write(`transcript gate: failed — vitest exit ${outcome.code}\n`);
    return 0;
  }

  // 4. Parse the CHECKS_PATH emitted by the test.
  const m = stdout.match(/CHECKS_PATH=(\S+)/);
  if (!m || !m[1]) {
    await emit(
      buildResult(
        "failed",
        [{ name: "checks_emitted", passed: false, details: "test did not emit CHECKS_PATH" }],
        { checks_emitted: false },
        startedAt,
        finishedAt
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
      buildResult(
        "failed",
        [
          {
            name: "checks_readable",
            passed: false,
            details: `cannot read checks file: ${(err as Error).message}`
          }
        ],
        { checks_readable: false },
        startedAt,
        finishedAt
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
      buildResult(
        "failed",
        [
          {
            name: "checks_json",
            passed: false,
            details: `malformed checks JSON: ${(err as Error).message}`
          }
        ],
        { checks_json: false },
        startedAt,
        finishedAt
      )
    );
    process.stderr.write("transcript gate: failed — checks JSON malformed\n");
    return 0;
  }

  interface RealChecksOutput {
    coverageUnion: string[];
    perEntry: Array<{
      path: string;
      sha256Before: string;
      sha256After: string;
      unchanged: boolean;
      observed: string[];
      evidence?: string;
    }>;
  }
  const checks = checksParsed as RealChecksOutput;
  if (!checks || !Array.isArray(checks.coverageUnion) || !Array.isArray(checks.perEntry)) {
    await emit(
      buildResult(
        "failed",
        [{ name: "checks_shape", passed: false, details: "checks file missing coverageUnion/perEntry" }],
        { checks_shape: false },
        startedAt,
        finishedAt
      )
    );
    process.stderr.write("transcript gate: failed — checks shape\n");
    return 0;
  }

  // 5. Hash every input AFTER. Mismatch -> failed.
  const afterCheckEntries: { name: string; passed: boolean; details?: string }[] = [];
  let allUnchanged = true;
  for (const entry of checks.perEntry) {
    const ok = entry.unchanged;
    if (!ok) allUnchanged = false;
    const e: { name: string; passed: boolean; details?: string } = {
      name: `hash_unchanged:${entry.path}`,
      passed: ok
    };
    if (!ok) {
      e.details = `sha256 changed: before=${entry.sha256Before} after=${entry.sha256After}`;
    }
    afterCheckEntries.push(e);
  }

  // 6. Coverage union check.
  const REQUIRED = ["user", "assistant", "tool", "completed", "failed", "interrupted"];
  const union = new Set(checks.coverageUnion);
  const missingLabels = REQUIRED.filter((l) => !union.has(l));
  const coveragePassed = missingLabels.length === 0;

  // 7. Independent re-hash to confirm the test's claim.
  const independentRehash = new Map<string, string>();
  for (const entry of manifest) {
    independentRehash.set(entry.path, await sha256(entry.path));
  }
  const independentUnchanged =
    [...before.entries()].every(([p, h]) => independentRehash.get(p) === h) &&
    [...before.entries()].every(([p, h]) => {
      const entry = checks.perEntry.find((e) => e.path === p);
      return entry?.sha256Before === h && entry?.sha256After === h;
    });

  const allPass = allUnchanged && coveragePassed && independentUnchanged;
  const allChecks: { name: string; passed: boolean; details?: string }[] = [];
  const coverageCheck: { name: string; passed: boolean; details?: string } = {
    name: "coverage_union_complete",
    passed: coveragePassed
  };
  if (!coveragePassed) {
    coverageCheck.details = `missing: ${missingLabels.join(",")}`;
  }
  allChecks.push(coverageCheck);
  allChecks.push({ name: "independent_rehash_matches", passed: independentUnchanged });
  for (const e of afterCheckEntries) allChecks.push(e);

  const result = buildResult(
    allPass ? "passed" : "failed",
    allChecks,
    {
      entry_count: manifest.length,
      coverage_union_size: checks.coverageUnion.length,
      independent_rehash: independentUnchanged
    },
    startedAt,
    finishedAt
  );
  await emit(result);
  process.stderr.write(
    `transcript gate: ${allPass ? "passed" : "failed"} — ${allChecks.length} checks\n`
  );
  return 0;
}

main().catch((err) => {
  process.stderr.write(`run-real-gate: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
