// Pure failure-mapping for the transcript compatibility gate.
//
// This module is the deterministic contract between
// `probes/transcript/run-real-gate.ts` and the Phase 0 aggregator. The
// runner observes a focused vitest subprocess that consumes a manifest of
// transcript file copies and emits a checks payload (hash + coverage). It
// converts every observable outcome into one of the {@link Outcome}
// variants below; this module turns that variant into a validated
// {@link GateResult}.
//
// No I/O, no `Date.now()`, no side effects.

import type { GateCheck, GateResult } from "../run-phase0.js";

/**
 * Shape of the checks payload emitted by the focused transcript adapter
 * test. The runner parses the on-disk JSON and hands it to us verbatim
 * (already validated to have the right top-level shape).
 */
export interface RealChecksOutput {
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

/**
 * The labels a complete transcript coverage union must include.
 */
export const REQUIRED_COVERAGE_LABELS = [
  "user",
  "assistant",
  "tool",
  "completed",
  "failed",
  "interrupted"
] as const;

/**
 * Discriminated union of every outcome the transcript gate runner can
 * observe. Each variant maps to a specific {@link GateResult.status}:
 *
 *  - missing prerequisites (env / path / readability / shape) -> `not_run`
 *  - malformed checks payload / missing CHECKS_PATH             -> `failed`
 *  - nonzero exit / signal / timeout                            -> `failed`
 *  - checks (hash + coverage + independent rehash)              -> `passed` or `failed`
 */
export type Outcome =
  // Prerequisite failures: the runner could not even attempt the test.
  | { kind: "missing_prereq"; checkName: string; reason: string; evidenceKey: string; evidenceValue: string | number | boolean }
  // Process failures: the test ran but did not produce checks.
  | { kind: "timeout"; deadlineMs: number }
  | { kind: "signal"; signal: NodeJS.Signals }
  | { kind: "nonzero"; code: number | null; stderrTail: string }
  // Checks-emission failures: process exited 0 but checks were not usable.
  | { kind: "checks_not_emitted"; reason: string }
  | { kind: "checks_unreadable"; reason: string }
  | { kind: "checks_malformed_json"; reason: string }
  | { kind: "checks_bad_shape"; reason: string }
  // Successful checks payload: aggregate hash/coverage/independent rehash.
  | { kind: "checks"; checks: RealChecksOutput; before: Record<string, string>; after: Record<string, string> };

export interface MapOptions {
  startedAt: string;
  finishedAt: string;
}

function checkEntry(name: string, passed: boolean, details?: string): GateCheck {
  if (details === undefined) return { name, passed };
  return { name, passed, details };
}

/**
 * Map a {@link Outcome} to a {@link GateResult} for the transcript gate.
 *
 * Pure and total. For `checks` outcomes, the function derives three groups
 * of checks:
 *
 *  1. `coverage_union_complete` — every label in
 *     {@link REQUIRED_COVERAGE_LABELS} appears in `coverageUnion`.
 *  2. `independent_rehash_matches` — the runner-supplied `before` / `after`
 *     sha256 maps agree internally AND match the `sha256Before` /
 *     `sha256After` reported by the test for every input path.
 *  3. `hash_unchanged:<path>` — one per input, mirroring the test's own
 *     per-entry `unchanged` flag.
 *
 * A gate is `passed` iff every emitted check passes AND at least one check
 * was emitted.
 */
export function mapOutcomeToGateResult(
  outcome: Outcome,
  opts: MapOptions
): GateResult {
  const { startedAt, finishedAt } = opts;

  switch (outcome.kind) {
    case "missing_prereq":
      return {
        name: "transcript",
        status: "not_run",
        startedAt,
        finishedAt,
        checks: [
          { name: outcome.checkName, passed: false, details: outcome.reason }
        ],
        evidence: { [outcome.evidenceKey]: outcome.evidenceValue }
      };

    case "timeout":
      return {
        name: "transcript",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          {
            name: "deadline",
            passed: false,
            details: `exceeded ${outcome.deadlineMs}ms deadline`
          }
        ],
        evidence: { timed_out: true }
      };

    case "signal":
      return {
        name: "transcript",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          {
            name: "process",
            passed: false,
            details: `killed by signal ${outcome.signal}`
          }
        ],
        evidence: { signal: outcome.signal }
      };

    case "nonzero":
      return {
        name: "transcript",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          {
            name: "vitest",
            passed: false,
            details: `exit=${outcome.code}; ${outcome.stderrTail}`
          }
        ],
        evidence: { exit_code: outcome.code ?? -1 }
      };

    case "checks_not_emitted":
      return {
        name: "transcript",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          { name: "checks_emitted", passed: false, details: outcome.reason }
        ],
        evidence: { checks_emitted: false }
      };

    case "checks_unreadable":
      return {
        name: "transcript",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          { name: "checks_readable", passed: false, details: outcome.reason }
        ],
        evidence: { checks_readable: false }
      };

    case "checks_malformed_json":
      return {
        name: "transcript",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          { name: "checks_json", passed: false, details: outcome.reason }
        ],
        evidence: { checks_json: false }
      };

    case "checks_bad_shape":
      return {
        name: "transcript",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          { name: "checks_shape", passed: false, details: outcome.reason }
        ],
        evidence: { checks_shape: false }
      };

    case "checks": {
      const { checks, before, after } = outcome;

      // 1. Coverage union check.
      const union = new Set(checks.coverageUnion);
      const missingLabels = REQUIRED_COVERAGE_LABELS.filter((l) => !union.has(l));
      const coveragePassed = missingLabels.length === 0;
      const coverageCheck = checkEntry(
        "coverage_union_complete",
        coveragePassed,
        coveragePassed ? undefined : `missing: ${missingLabels.join(",")}`
      );

      // 2. Per-entry unchanged flags.
      const hashEntries: GateCheck[] = [];
      let allUnchanged = true;
      for (const entry of checks.perEntry) {
        if (!entry.unchanged) allUnchanged = false;
        hashEntries.push(
          checkEntry(
            `hash_unchanged:${entry.path}`,
            entry.unchanged,
            entry.unchanged
              ? undefined
              : `sha256 changed: before=${entry.sha256Before} after=${entry.sha256After}`
          )
        );
      }

      // 3. Independent rehash: runner-supplied before/after maps must (a)
      //    agree internally (before === after for every path), and (b)
      //    match the per-entry `sha256Before` / `sha256After` reported by
      //    the test.
      const paths = Object.keys(before);
      const internalConsistent = paths.every((p) => before[p] === after[p]);
      const matchesTestReport = paths.every((p) => {
        const entry = checks.perEntry.find((e) => e.path === p);
        return (
          entry?.sha256Before === before[p] && entry?.sha256After === after[p]
        );
      });
      const independentUnchanged = internalConsistent && matchesTestReport;
      const independentCheck = checkEntry(
        "independent_rehash_matches",
        independentUnchanged
      );

      const allChecks = [coverageCheck, independentCheck, ...hashEntries];
      const allPass =
        allChecks.length > 0 &&
        coveragePassed &&
        allUnchanged &&
        independentUnchanged;

      return {
        name: "transcript",
        status: allPass ? "passed" : "failed",
        startedAt,
        finishedAt,
        checks: allChecks,
        evidence: {
          entry_count: paths.length,
          coverage_union_size: checks.coverageUnion.length,
          independent_rehash: independentUnchanged
        }
      };
    }
  }
}
