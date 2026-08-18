import { expect, it } from "vitest";
import {
  mapOutcomeToGateResult,
  type DeviceGateEvidence,
  type Outcome
} from "../map-outcome.js";

const opts = { startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:01:00.000Z" };

const expected = {
  issuer: "https://team.example.com",
  audience: "aud-123",
  subject: "user@example.com"
};

function fullEvidence(overrides: Partial<DeviceGateEvidence> = {}): DeviceGateEvidence {
  return {
    issuer: expected.issuer,
    audience: expected.audience,
    subject: expected.subject,
    expiredHttpRejected: true,
    expiredWsRejected: true,
    refreshedHttpOk: true,
    lanUnreachable: true,
    postTunnelHttpFailed: true,
    postTunnelWsFailed: true,
    ...overrides
  };
}

function deviceRun(extra: Partial<Extract<Outcome, { kind: "device_run" }>> = {}) {
  return {
    kind: "device_run" as const,
    exit: { kind: "exit" as const, code: 0 },
    barrierSeen: true,
    evidencePulled: true,
    deviceEvidence: fullEvidence(),
    evidenceError: null,
    expected,
    overallTimeoutMs: 600_000,
    lastOriginRequestId: "req-42",
    gradleExitCode: 0,
    ...extra
  };
}

it("maps a clean device run with matching evidence to status: passed", () => {
  const result = mapOutcomeToGateResult(deviceRun(), opts);
  expect(result.status).toBe("passed");
  expect(result.name).toBe("cloudflare");
  expect(result.checks).toHaveLength(9);
  expect(result.checks.every((c) => c.passed)).toBe(true);
  expect(result.evidence).toEqual({
    timed_out: false,
    barrier_seen: true,
    gradle_exit: 0,
    issuer_match: true,
    last_origin_request_id: "req-42"
  });
});

it("maps a mismatching issuer to failed via issuer_match", () => {
  const result = mapOutcomeToGateResult(
    deviceRun({ deviceEvidence: fullEvidence({ issuer: "https://other.example.com" }) }),
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks.find((c) => c.name === "issuer_match")?.passed).toBe(false);
  expect(result.evidence.issuer_match).toBe(false);
});

it("maps each independent device assertion to its own check", () => {
  const failing = fullEvidence({
    audience: "wrong",
    expiredWsRejected: false,
    refreshedHttpOk: false,
    lanUnreachable: false,
    postTunnelHttpFailed: false,
    postTunnelWsFailed: false
  });
  const result = mapOutcomeToGateResult(
    deviceRun({ deviceEvidence: failing }),
    opts
  );
  expect(result.status).toBe("failed");
  const names = result.checks.map((c) => c.name);
  expect(names).toEqual([
    "issuer_match",
    "audience_match",
    "subject_match",
    "expired_http_rejected",
    "expired_ws_rejected",
    "refreshed_http_ok",
    "lan_unreachable",
    "post_tunnel_http_failed",
    "post_tunnel_ws_failed"
  ]);
  const failedNames = result.checks.filter((c) => !c.passed).map((c) => c.name);
  expect(failedNames).toEqual([
    "audience_match",
    "expired_ws_rejected",
    "refreshed_http_ok",
    "lan_unreachable",
    "post_tunnel_http_failed",
    "post_tunnel_ws_failed"
  ]);
});

it("maps a gradle timeout to failed with a deadline check", () => {
  const result = mapOutcomeToGateResult(
    deviceRun({ exit: { kind: "timeout" }, gradleExitCode: null }),
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks.find((c) => c.name === "deadline")?.details).toContain("600000ms");
  expect(result.evidence.timed_out).toBe(true);
  expect(result.evidence.gradle_exit).toBe(-1);
});

it("maps a signal-killed gradle to failed with a process check", () => {
  const result = mapOutcomeToGateResult(
    deviceRun({ exit: { kind: "signal", signal: "SIGKILL" } }),
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks.find((c) => c.name === "process")?.details).toContain("SIGKILL");
});

it("maps a nonzero gradle exit to failed with a gradle check", () => {
  const result = mapOutcomeToGateResult(
    deviceRun({ exit: { kind: "exit", code: 1 }, gradleExitCode: 1 }),
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks.find((c) => c.name === "gradle")?.details).toContain("exit=1");
});

it("maps a missing barrier to failed", () => {
  const result = mapOutcomeToGateResult(deviceRun({ barrierSeen: false }), opts);
  expect(result.status).toBe("failed");
  expect(result.checks.find((c) => c.name === "barrier_seen")?.passed).toBe(false);
  expect(result.evidence.barrier_seen).toBe(false);
});

it("maps an unpullable evidence file to failed with evidence_pulled", () => {
  const result = mapOutcomeToGateResult(
    deviceRun({ evidencePulled: false, deviceEvidence: null, evidenceError: null }),
    opts
  );
  expect(result.status).toBe("failed");
  const check = result.checks.find((c) => c.name === "evidence_pulled");
  expect(check?.passed).toBe(false);
  expect(check?.details).toContain("could not pull");
  expect(result.evidence.last_origin_request_id).toBeUndefined();
});

it("maps unparsable pulled evidence to failed with evidence_json", () => {
  const result = mapOutcomeToGateResult(
    deviceRun({ deviceEvidence: null, evidenceError: "Unexpected token } in JSON" }),
    opts
  );
  expect(result.status).toBe("failed");
  const check = result.checks.find((c) => c.name === "evidence_json");
  expect(check?.passed).toBe(false);
  expect(check?.details).toContain("Unexpected token");
});

it("combines process failure with missing barrier and failed assertions", () => {
  const result = mapOutcomeToGateResult(
    deviceRun({
      exit: { kind: "exit", code: 1 },
      barrierSeen: false,
      evidencePulled: true,
      deviceEvidence: fullEvidence({ subject: "someone-else" }),
      gradleExitCode: 1
    }),
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks.map((c) => c.name)).toEqual([
    "gradle",
    "barrier_seen",
    "issuer_match",
    "audience_match",
    "subject_match",
    "expired_http_rejected",
    "expired_ws_rejected",
    "refreshed_http_ok",
    "lan_unreachable",
    "post_tunnel_http_failed",
    "post_tunnel_ws_failed"
  ]);
});

it("maps missing_env to not_run", () => {
  const result = mapOutcomeToGateResult(
    {
      kind: "missing_env",
      reason: "RUN_REAL_CLOUDFLARE=1 not set — opt-in gate skipped",
      envComplete: false
    },
    opts
  );
  expect(result.status).toBe("not_run");
  expect(result.checks).toEqual([
    {
      name: "env",
      passed: false,
      details: "RUN_REAL_CLOUDFLARE=1 not set — opt-in gate skipped"
    }
  ]);
  expect(result.evidence).toEqual({ env_complete: false });
});

it("maps missing env vars (not opt-in) to not_run with env_complete true", () => {
  // RUN_REAL_CLOUDFLARE=1 was set but a var is missing: envComplete records
  // that the opt-in was expressed; the gate is still not_run.
  const result = mapOutcomeToGateResult(
    {
      kind: "missing_env",
      reason: "missing env vars: CF_ACCESS_AUD, ANDROID_SERIAL",
      envComplete: true
    },
    opts
  );
  expect(result.status).toBe("not_run");
  expect(result.evidence).toEqual({ env_complete: true });
});

it("maps an unverified app link to failed", () => {
  const result = mapOutcomeToGateResult(
    { kind: "app_link_unverified", probeHost: "probe.example.com" },
    opts
  );
  expect(result.status).toBe("failed");
  expect(result.checks[0]?.name).toBe("app_link_verified");
  expect(result.checks[0]?.details).toContain("probe.example.com");
  expect(result.evidence).toEqual({ app_link_verified: false });
});

it("maps a failed origin handshake to failed", () => {
  const result = mapOutcomeToGateResult({ kind: "origin_handshake_failed" }, opts);
  expect(result.status).toBe("failed");
  expect(result.checks[0]?.name).toBe("origin_handshake");
  expect(result.evidence).toEqual({ origin_started: false });
});

it("every variant produces a cloudflare-named result", () => {
  const outcomes: Outcome[] = [
    { kind: "missing_env", reason: "x", envComplete: false },
    { kind: "app_link_unverified", probeHost: "h" },
    { kind: "origin_handshake_failed" },
    deviceRun()
  ];
  for (const o of outcomes) {
    expect(mapOutcomeToGateResult(o, opts).name).toBe("cloudflare");
  }
});
