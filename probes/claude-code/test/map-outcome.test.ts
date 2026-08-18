import { expect, it } from "vitest";
import {
  checksFromMap,
  mapOutcomeToGateResult,
  type Outcome
} from "../map-outcome.js";

const opts = { startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:01:00.000Z" };

it("maps a successful all-passing outcome to status: passed", () => {
  const result = mapOutcomeToGateResult(
    { kind: "success", checks: { framing: true, handshake: true } },
    opts
  );
  expect(result).toMatchObject({
    name: "claude",
    status: "passed",
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt
  });
  expect(result.checks).toEqual([
    { name: "framing", passed: true },
    { name: "handshake", passed: true }
  ]);
  expect(result.evidence).toEqual({ exit_code: 0 });
});

it("demotes a successful outcome with a failing check to status: failed", () => {
  const result = mapOutcomeToGateResult(
    { kind: "success", checks: { framing: true, handshake: "wrong magic" } },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks).toEqual([
    { name: "framing", passed: true },
    { name: "handshake", passed: false, details: "wrong magic" }
  ]);
});

it("demotes a successful outcome with a non-boolean, non-string failing check to failed", () => {
  const result = mapOutcomeToGateResult(
    { kind: "success", checks: { framing: false, other: 42 } },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks).toEqual([
    { name: "framing", passed: false },
    { name: "other", passed: false }
  ]);
});

it("treats an empty checks map on success as failed (no positive evidence)", () => {
  const result = mapOutcomeToGateResult(
    { kind: "success", checks: {} },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks).toEqual([]);
});

it("maps missing_prereq to not_run with a single prerequisites check", () => {
  const result = mapOutcomeToGateResult(
    { kind: "missing_prereq", reason: "claude CLI not found on PATH" },
    opts
  );
  expect(result.status).toBe("not_run");
  expect(result.checks).toEqual([
    { name: "prerequisites", passed: false, details: "claude CLI not found on PATH" }
  ]);
  expect(result.evidence).toEqual({ prerequisite_ok: false });
});

it("maps nonzero exit to failed with the exit code in evidence", () => {
  const result = mapOutcomeToGateResult(
    { kind: "nonzero", code: 1, reason: "assertion failed in compatibility.test.ts" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks).toHaveLength(1);
  expect(result.checks[0]).toMatchObject({ name: "vitest", passed: false });
  expect(result.checks[0]?.details).toContain("exit=1");
  expect(result.evidence).toEqual({ exit_code: 1 });
});

it("maps a null exit code (process error) to failed with evidence exit_code -1", () => {
  const result = mapOutcomeToGateResult(
    { kind: "nonzero", code: null, reason: "spawn error" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.evidence).toEqual({ exit_code: -1 });
});

it("maps a signal-killed process to failed with the signal in evidence", () => {
  const result = mapOutcomeToGateResult(
    { kind: "signal", signal: "SIGKILL" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]).toMatchObject({ name: "process", passed: false });
  expect(result.checks[0]?.details).toContain("SIGKILL");
  expect(result.evidence).toEqual({ signal: "SIGKILL" });
});

it("maps a timeout to failed with the deadline in the details", () => {
  const result = mapOutcomeToGateResult(
    { kind: "timeout", deadlineMs: 600_000 },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]).toMatchObject({ name: "deadline", passed: false });
  expect(result.checks[0]?.details).toContain("600000ms");
  expect(result.evidence).toEqual({ timed_out: true });
});

it("maps a malformed-checks outcome to failed with a failureReason", () => {
  const result = mapOutcomeToGateResult(
    { kind: "malformed", reason: "test did not emit CHECKS_PATH" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks).toEqual([]);
  expect(result.evidence).toEqual({ failureReason: "test did not emit CHECKS_PATH" });
});

it("never produces a result whose name is not 'claude'", () => {
  for (const outcome of [
    { kind: "missing_prereq", reason: "x" },
    { kind: "success", checks: { a: true } },
    { kind: "malformed", reason: "x" },
    { kind: "nonzero", code: 1, reason: "x" },
    { kind: "signal", signal: "SIGTERM" as const },
    { kind: "timeout", deadlineMs: 1000 }
  ] as Outcome[]) {
    expect(mapOutcomeToGateResult(outcome, opts).name).toBe("claude");
  }
});

it("checksFromMap preserves insertion order and converts values deterministically", () => {
  const entries = checksFromMap({ a: true, b: "nope", c: false, d: 0 });
  expect(entries).toEqual([
    { name: "a", passed: true },
    { name: "b", passed: false, details: "nope" },
    { name: "c", passed: false },
    { name: "d", passed: false }
  ]);
});
