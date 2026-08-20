import { expect, it } from "vitest";
import {
  REQUIRED_COVERAGE_LABELS,
  mapOutcomeToGateResult,
  type Outcome,
  type RealChecksOutput
} from "../map-outcome.js";

const opts = { startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:01:00.000Z" };
const ALL_LABELS = [...REQUIRED_COVERAGE_LABELS];

function entry(path: string, sha: string, opts2: { unchanged?: boolean; observed?: string[] } = {}): RealChecksOutput["perEntry"][number] {
  return {
    path,
    sha256Before: sha,
    sha256After: sha,
    unchanged: opts2.unchanged ?? true,
    observed: opts2.observed ?? ALL_LABELS
  };
}

it("maps a fully-passing checks outcome to status: passed", () => {
  const sha = "a".repeat(64);
  const checks: RealChecksOutput = {
    coverageUnion: ALL_LABELS,
    perEntry: [entry("/x.jsonl", sha), entry("/y.jsonl", sha)]
  };
  const result = mapOutcomeToGateResult(
    {
      kind: "checks",
      checks,
      before: { "/x.jsonl": sha, "/y.jsonl": sha },
      after: { "/x.jsonl": sha, "/y.jsonl": sha }
    },
    opts
  );
  expect(result.status).toBe("passed");
  expect(result.evidence).toEqual({
    entry_count: 2,
    coverage_union_size: ALL_LABELS.length,
    independent_rehash: true
  });
  const names = result.checks.map((c) => c.name);
  expect(names).toContain("coverage_union_complete");
  expect(names).toContain("independent_rehash_matches");
  expect(names).toContain("hash_unchanged:/x.jsonl");
  expect(names).toContain("hash_unchanged:/y.jsonl");
  expect(result.checks.every((c) => c.passed)).toBe(true);
});

it("demotes to failed when a coverage label is missing", () => {
  const sha = "a".repeat(64);
  const incomplete = ALL_LABELS.filter((l) => l !== "interrupted");
  const checks: RealChecksOutput = {
    coverageUnion: incomplete,
    perEntry: [entry("/x.jsonl", sha)]
  };
  const result = mapOutcomeToGateResult(
    {
      kind: "checks",
      checks,
      before: { "/x.jsonl": sha },
      after: { "/x.jsonl": sha }
    },
    opts
  );
  expect(result.status).toBe("failed");
  const cov = result.checks.find((c) => c.name === "coverage_union_complete");
  expect(cov?.passed).toBe(false);
  expect(cov?.details).toContain("interrupted");
});

it("demotes to failed when a per-entry hash changed", () => {
  const beforeSha = "a".repeat(64);
  const afterSha = "b".repeat(64);
  const checks: RealChecksOutput = {
    coverageUnion: ALL_LABELS,
    perEntry: [
      {
        path: "/x.jsonl",
        sha256Before: beforeSha,
        sha256After: afterSha,
        unchanged: false,
        observed: ALL_LABELS
      }
    ]
  };
  // Runner reports before/after as equal because the on-disk hash matches
  // itself at both sample points — but the test reports a change. The
  // independent-rehash check fails because the test's sha256Before !==
  // runner's before hash.
  const result = mapOutcomeToGateResult(
    {
      kind: "checks",
      checks,
      before: { "/x.jsonl": beforeSha },
      after: { "/x.jsonl": beforeSha }
    },
    opts
  );
  expect(result.status).toBe("failed");
  const hashCheck = result.checks.find((c) => c.name === "hash_unchanged:/x.jsonl");
  expect(hashCheck?.passed).toBe(false);
});

it("demotes to failed when independent rehash detects a real on-disk change", () => {
  const sha = "a".repeat(64);
  const newSha = "b".repeat(64);
  const checks: RealChecksOutput = {
    coverageUnion: ALL_LABELS,
    perEntry: [entry("/x.jsonl", sha)]
  };
  // Runner's after != runner's before, so independent rehash fails.
  const result = mapOutcomeToGateResult(
    {
      kind: "checks",
      checks,
      before: { "/x.jsonl": sha },
      after: { "/x.jsonl": newSha }
    },
    opts
  );
  expect(result.status).toBe("failed");
  const rehash = result.checks.find((c) => c.name === "independent_rehash_matches");
  expect(rehash?.passed).toBe(false);
});

it("maps missing_prereq to not_run", () => {
  const result = mapOutcomeToGateResult(
    {
      kind: "missing_prereq",
      checkName: "manifest_env",
      reason: "REAL_TRANSCRIPT_MANIFEST not set",
      evidenceKey: "manifest_set",
      evidenceValue: false
    },
    opts
  );
  expect(result.status).toBe("not_run");
  expect(result.checks).toEqual([
    { name: "manifest_env", passed: false, details: "REAL_TRANSCRIPT_MANIFEST not set" }
  ]);
  expect(result.evidence).toEqual({ manifest_set: false });
});

it("maps missing_prereq with a numeric evidence value", () => {
  const result = mapOutcomeToGateResult(
    {
      kind: "missing_prereq",
      checkName: "manifest_entries",
      reason: "manifest must be a non-empty array",
      evidenceKey: "manifest_entries",
      evidenceValue: 0
    },
    opts
  );
  expect(result.status).toBe("not_run");
  expect(result.evidence).toEqual({ manifest_entries: 0 });
});

it("maps timeout to failed with timed_out evidence", () => {
  const result = mapOutcomeToGateResult(
    { kind: "timeout", deadlineMs: 120_000 },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]?.name).toBe("deadline");
  expect(result.checks[0]?.details).toContain("120000ms");
  expect(result.evidence).toEqual({ timed_out: true });
});

it("maps a signal kill to failed", () => {
  const result = mapOutcomeToGateResult(
    { kind: "signal", signal: "SIGTERM" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]?.name).toBe("process");
  expect(result.evidence).toEqual({ signal: "SIGTERM" });
});

it("maps nonzero exit with exit_code -1 when code is null", () => {
  const result = mapOutcomeToGateResult(
    { kind: "nonzero", code: null, stderrTail: "spawn failed" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]?.details).toContain("exit=null");
  expect(result.checks[0]?.details).toContain("spawn failed");
  expect(result.evidence).toEqual({ exit_code: -1 });
});

it("maps checks_not_emitted to failed", () => {
  const result = mapOutcomeToGateResult(
    { kind: "checks_not_emitted", reason: "test did not emit CHECKS_PATH" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]?.name).toBe("checks_emitted");
});

it("maps checks_unreadable to failed", () => {
  const result = mapOutcomeToGateResult(
    { kind: "checks_unreadable", reason: "permission denied" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]?.name).toBe("checks_readable");
});

it("maps checks_malformed_json to failed", () => {
  const result = mapOutcomeToGateResult(
    { kind: "checks_malformed_json", reason: "Unexpected token }" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]?.name).toBe("checks_json");
});

it("maps checks_bad_shape to failed", () => {
  const result = mapOutcomeToGateResult(
    { kind: "checks_bad_shape", reason: "missing coverageUnion/perEntry" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]?.name).toBe("checks_shape");
});

it("every variant produces a transcript-named result", () => {
  const outcomes: Outcome[] = [
    { kind: "missing_prereq", checkName: "x", reason: "y", evidenceKey: "k", evidenceValue: false },
    { kind: "timeout", deadlineMs: 1 },
    { kind: "signal", signal: "SIGINT" },
    { kind: "nonzero", code: 0, stderrTail: "" },
    { kind: "checks_not_emitted", reason: "x" },
    { kind: "checks_unreadable", reason: "x" },
    { kind: "checks_malformed_json", reason: "x" },
    { kind: "checks_bad_shape", reason: "x" },
    {
      kind: "checks",
      checks: { coverageUnion: ALL_LABELS, perEntry: [] },
      before: {},
      after: {}
    }
  ];
  for (const o of outcomes) {
    expect(mapOutcomeToGateResult(o, opts).name).toBe("transcript");
  }
});

it("treats an empty perEntry as vacuously passed (documents the edge)", () => {
  const result = mapOutcomeToGateResult(
    {
      kind: "checks",
      checks: { coverageUnion: ALL_LABELS, perEntry: [] },
      before: {},
      after: {}
    },
    opts
  );
  // Coverage passes but there are no entries to verify; the empty
  // per-entry list still produces a passed coverage_union_complete check,
  // and independent_rehash_matches is trivially true for zero paths. The
  // original implementation only emits 'passed' if allUnchanged (true when
  // empty) AND coveragePassed AND independentUnchanged (true when empty).
  // So zero entries -> passed. We assert that here to document the edge.
  expect(result.status).toBe("passed");
});

it("demotes to failed when the test's sha256Before does not match the runner's before", () => {
  const runnerBefore = "a".repeat(64);
  const testBefore = "c".repeat(64);
  const checks: RealChecksOutput = {
    coverageUnion: ALL_LABELS,
    perEntry: [entry("/x.jsonl", testBefore)]
  };
  const result = mapOutcomeToGateResult(
    {
      kind: "checks",
      checks,
      before: { "/x.jsonl": runnerBefore },
      after: { "/x.jsonl": runnerBefore }
    },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks.find((c) => c.name === "independent_rehash_matches")?.passed).toBe(false);
});
