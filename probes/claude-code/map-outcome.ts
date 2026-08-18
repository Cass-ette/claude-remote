// Pure failure-mapping for the Claude Code compatibility gate.
//
// This module is the deterministic contract between
// `probes/claude-code/run-real-gate.ts` and the Phase 0 aggregator
// (`probes/run-phase0.ts`). The runner converts every observable
// subprocess outcome into one of the {@link Outcome} variants below; this
// module turns that variant into a validated {@link GateResult}.
//
// No I/O, no `Date.now()`, no side effects. Every timestamp and external
// value is passed in via the arguments so the function is fully
// deterministic and trivially testable.

import type { GateCheck, GateResult, GateStatus } from "../run-phase0.js";

/**
 * Shape of the checks payload the focused vitest test prints via
 * `CHECKS_PATH=...`. Each key is a check name; the value is `true` for a
 * passing check, a `string` (failure detail) for a failing check, or any
 * other value which we treat as `passed: false`.
 */
export type ChecksMap = Record<string, unknown>;

/**
 * Discriminated union of every outcome the Claude Code gate runner can
 * observe. Each variant maps to a specific {@link GateResult.status}:
 *
 *  - `missing_prereq` -> `not_run`
 *  - `success`        -> `passed` (or `failed` if any check value is not `true`)
 *  - `malformed`      -> `failed`
 *  - `nonzero`        -> `failed`
 *  - `signal`         -> `failed`
 *  - `timeout`        -> `failed`
 */
export type Outcome =
  | { kind: "missing_prereq"; reason: string }
  | { kind: "success"; checks: ChecksMap }
  | { kind: "malformed"; reason: string }
  | { kind: "nonzero"; code: number | null; reason: string }
  | { kind: "signal"; signal: NodeJS.Signals }
  | { kind: "timeout"; deadlineMs: number };

export interface MapOptions {
  startedAt: string;
  finishedAt: string;
}

/**
 * Convert a checks map into the {@link GateCheck} array shape used by the
 * aggregator. `true` -> `passed: true`; a `string` value is treated as a
 * failure detail; anything else is a failing check with no detail.
 *
 * Pure: deterministic order is the key-insertion order of `checks`.
 */
export function checksFromMap(checks: ChecksMap): GateCheck[] {
  const out: GateCheck[] = [];
  for (const [name, value] of Object.entries(checks)) {
    const passed = value === true;
    const entry: GateCheck = { name, passed };
    if (typeof value === "string") {
      entry.details = value;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Map a {@link Outcome} to a {@link GateResult} for the Claude Code gate.
 *
 * The function never throws and performs no I/O. The caller supplies
 * `startedAt` / `finishedAt` (typically captured at the start/end of the
 * runner), so this function is fully deterministic given the same inputs.
 */
export function mapOutcomeToGateResult(
  outcome: Outcome,
  opts: MapOptions
): GateResult {
  const { startedAt, finishedAt } = opts;

  switch (outcome.kind) {
    case "missing_prereq":
      return {
        name: "claude",
        status: "not_run",
        startedAt,
        finishedAt,
        checks: [
          { name: "prerequisites", passed: false, details: outcome.reason }
        ],
        evidence: { prerequisite_ok: false }
      };

    case "timeout":
      return {
        name: "claude",
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
        name: "claude",
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
        name: "claude",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          {
            name: "vitest",
            passed: false,
            details: `exit=${outcome.code}; ${outcome.reason}`
          }
        ],
        evidence: { exit_code: outcome.code ?? -1 }
      };

    case "malformed":
      return {
        name: "claude",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [],
        evidence: { failureReason: outcome.reason }
      };

    case "success": {
      const checkEntries = checksFromMap(outcome.checks);
      const allPass =
        checkEntries.length > 0 && checkEntries.every((c) => c.passed);
      const status: GateStatus = allPass ? "passed" : "failed";
      return {
        name: "claude",
        status,
        startedAt,
        finishedAt,
        checks: checkEntries,
        evidence: { exit_code: 0 }
      };
    }
  }
}
