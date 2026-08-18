// Pure failure-mapping for the Cloudflare mobile access gate.
//
// This module is the deterministic contract between
// `probes/cloudflare/run-real-gate.ts` and the Phase 0 aggregator. The
// runner orchestrates a Gradle instrumented run, a loopback origin, and a
// cloudflared tunnel, then verifies device-side evidence. It converts
// every observable outcome into one of the {@link Outcome} variants
// below; this module turns that variant into a validated
// {@link GateResult}.
//
// No I/O, no `Date.now()`, no side effects.

import type { GateCheck, GateResult } from "../run-phase0.js";

/**
 * Shape of the device-side `cloudflare-gate.json` pulled via adb after the
 * instrumented test finishes.
 */
export interface DeviceGateEvidence {
  issuer: string;
  audience: string;
  subject: string;
  expiredHttpRejected: boolean;
  expiredWsRejected: boolean;
  refreshedHttpOk: boolean;
  lanUnreachable: boolean;
  postTunnelHttpFailed: boolean;
  postTunnelWsFailed: boolean;
}

/**
 * How the gradle child terminated.
 */
export type ChildExit =
  | { kind: "exit"; code: number | null }
  | { kind: "signal"; signal: NodeJS.Signals }
  | { kind: "timeout" };

/**
 * Discriminated union of every outcome the Cloudflare gate runner can
 * observe. Each variant maps to a specific {@link GateResult.status}:
 *
 *  - `missing_env`    -> `not_run`
 *  - everything else  -> `failed` or `passed`
 */
export type Outcome =
  | {
      kind: "missing_env";
      reason: string;
      envComplete: boolean;
    }
  | { kind: "app_link_unverified"; probeHost: string }
  | { kind: "origin_handshake_failed" }
  | {
      kind: "device_run";
      exit: ChildExit;
      barrierSeen: boolean;
      evidencePulled: boolean;
      deviceEvidence: DeviceGateEvidence | null;
      evidenceError: string | null;
      /** Expected values the device claims are compared against. */
      expected: {
        issuer: string;
        audience: string;
        subject: string;
      };
      overallTimeoutMs: number;
      lastOriginRequestId: string;
      gradleExitCode: number | null;
    };

export interface MapOptions {
  startedAt: string;
  finishedAt: string;
}

function checkEntry(name: string, passed: boolean, details?: string): GateCheck {
  if (details === undefined) return { name, passed };
  return { name, passed, details };
}

/**
 * Map a {@link Outcome} to a {@link GateResult} for the Cloudflare gate.
 *
 * Pure and total. For `device_run` outcomes the function derives:
 *
 *  1. A process check: timeout / signal / nonzero gradle exit (only one,
 *     in that precedence order). A clean exit contributes no check.
 *  2. A `barrier_seen` check when the device never wrote its
 *     ready-for-tunnel-stop barrier.
 *  3. An `evidence_pulled` check when the device evidence file could not
 *     be pulled, or an `evidence_json` check when it could not be parsed.
 *  4. Otherwise nine assertion checks derived from the device evidence.
 *
 * A gate is `passed` iff at least one check was emitted and every check
 * passes. The absence of checks is impossible in practice because the
 * evidence-derived branch always emits nine, but the guard keeps the
 * total function honest.
 */
export function mapOutcomeToGateResult(
  outcome: Outcome,
  opts: MapOptions
): GateResult {
  const { startedAt, finishedAt } = opts;

  switch (outcome.kind) {
    case "missing_env":
      return {
        name: "cloudflare",
        status: "not_run",
        startedAt,
        finishedAt,
        checks: [{ name: "env", passed: false, details: outcome.reason }],
        evidence: { env_complete: outcome.envComplete }
      };

    case "app_link_unverified":
      return {
        name: "cloudflare",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          {
            name: "app_link_verified",
            passed: false,
            details: `${outcome.probeHost} not in verified state per pm get-app-links`
          }
        ],
        evidence: { app_link_verified: false }
      };

    case "origin_handshake_failed":
      return {
        name: "cloudflare",
        status: "failed",
        startedAt,
        finishedAt,
        checks: [
          {
            name: "origin_handshake",
            passed: false,
            details: "origin did not emit ORIGIN_PORT / ORIGIN_EVIDENCE_FILE in time"
          }
        ],
        evidence: { origin_started: false }
      };

    case "device_run": {
      const { exit, barrierSeen, evidencePulled, deviceEvidence, evidenceError, expected } =
        outcome;

      const checks: GateCheck[] = [];
      const evidence: Record<string, string | number | boolean> = {
        timed_out: exit.kind === "timeout",
        barrier_seen: barrierSeen,
        gradle_exit: outcome.gradleExitCode ?? -1
      };

      // 1. Process outcome (precedence: timeout > signal > nonzero).
      if (exit.kind === "timeout") {
        checks.push(
          checkEntry("deadline", false, `exceeded ${outcome.overallTimeoutMs}ms`)
        );
      } else if (exit.kind === "signal") {
        checks.push(
          checkEntry("process", false, `killed by signal ${exit.signal}`)
        );
      } else if ((exit.code ?? -1) !== 0) {
        checks.push(checkEntry("gradle", false, `exit=${exit.code}`));
      }

      // 2. Barrier check.
      if (!barrierSeen) {
        checks.push(
          checkEntry("barrier_seen", false, "ready-for-tunnel-stop never appeared")
        );
      }

      // 3. Evidence availability / parseability.
      if (!evidencePulled) {
        checks.push(
          checkEntry(
            "evidence_pulled",
            false,
            "could not pull cloudflare-gate.json"
          )
        );
      } else if (deviceEvidence === null) {
        checks.push(
          checkEntry("evidence_json", false, evidenceError ?? "unparsable evidence")
        );
      } else {
        // 4. Assertion checks derived from the device evidence.
        const gate = deviceEvidence;
        checks.push(checkEntry("issuer_match", gate.issuer === expected.issuer));
        checks.push(checkEntry("audience_match", gate.audience === expected.audience));
        checks.push(checkEntry("subject_match", gate.subject === expected.subject));
        checks.push(checkEntry("expired_http_rejected", gate.expiredHttpRejected));
        checks.push(checkEntry("expired_ws_rejected", gate.expiredWsRejected));
        checks.push(checkEntry("refreshed_http_ok", gate.refreshedHttpOk));
        checks.push(checkEntry("lan_unreachable", gate.lanUnreachable));
        checks.push(checkEntry("post_tunnel_http_failed", gate.postTunnelHttpFailed));
        checks.push(checkEntry("post_tunnel_ws_failed", gate.postTunnelWsFailed));
        evidence.issuer_match = gate.issuer === expected.issuer;
        evidence.last_origin_request_id = outcome.lastOriginRequestId;
      }

      const passed = checks.length > 0 && checks.every((c) => c.passed);
      return {
        name: "cloudflare",
        status: passed ? "passed" : "failed",
        startedAt,
        finishedAt,
        checks,
        evidence
      };
    }
  }
}
