import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_MATRIX,
  loadEvidence,
  summarizeGates,
  synthesizeFailed,
  synthesizeNotRun,
  type GateResult,
  type GateSummary
} from "./run-phase0.js";

const baseResult: Omit<GateResult, "name" | "status"> = {
  checks: [],
  evidence: {},
  startedAt: "x",
  finishedAt: "y"
};

it("unlocks only capabilities backed by passed gates", () => {
  const summary = summarizeGates([
    { name: "claude", status: "passed", ...baseResult },
    { name: "transcript", status: "failed", ...baseResult },
    { name: "cloudflare", status: "not_run", ...baseResult }
  ]);
  expect(summary.unlocked).toContain("session-supervisor");
  expect(summary.blocked).toContain("history-snapshot");
  expect(summary.blocked).toContain("remote-transport");
});

it("treats a passing claude gate as unlocking all of its dependents", () => {
  const summary = summarizeGates([
    { name: "claude", status: "passed", ...baseResult },
    { name: "transcript", status: "not_run", ...baseResult },
    { name: "cloudflare", status: "not_run", ...baseResult }
  ]);
  expect(summary.unlocked).toEqual(
    expect.arrayContaining([
      "stream-json-adapter",
      "session-supervisor",
      "permission-broker",
      "mcp-adapter",
      "uuid-retry"
    ])
  );
  for (const cap of [
    "history-import",
    "history-snapshot",
    "crash-reconciliation",
    "remote-transport",
    "access-verifier",
    "oauth-device-auth"
  ]) {
    expect(summary.blocked).toContain(cap);
  }
});

it("treats missing gate results as not_run and blocks all of their dependents", () => {
  const summary = summarizeGates([
    { name: "transcript", status: "not_run", ...baseResult }
  ]);
  expect(summary.unlocked).not.toContain("session-supervisor");
  expect(summary.blocked).toEqual(
    expect.arrayContaining([
      "stream-json-adapter",
      "session-supervisor",
      "permission-broker",
      "mcp-adapter",
      "uuid-retry",
      "history-import",
      "history-snapshot",
      "crash-reconciliation",
      "remote-transport",
      "access-verifier",
      "oauth-device-auth"
    ])
  );
});

it("demotes a nominal status 'passed' to failed when any check has passed:false", () => {
  const summary = summarizeGates([
    {
      name: "claude",
      status: "passed",
      checks: [{ name: "framing", passed: false, details: "bad frame" }],
      evidence: {},
      startedAt: "x",
      finishedAt: "y"
    },
    { name: "transcript", status: "passed", ...baseResult },
    { name: "cloudflare", status: "passed", ...baseResult }
  ]);
  // Claude got demoted, so all of its dependents stay blocked.
  expect(summary.unlocked).not.toContain("session-supervisor");
  expect(summary.blocked).toContain("session-supervisor");
  // The other two gates genuinely passed.
  expect(summary.unlocked).toContain("history-snapshot");
  expect(summary.unlocked).toContain("remote-transport");
});

it("propagates failed gates as blocked dependents", () => {
  const summary: GateSummary = summarizeGates([
    { name: "claude", status: "failed", ...baseResult },
    { name: "transcript", status: "failed", ...baseResult },
    { name: "cloudflare", status: "failed", ...baseResult }
  ]);
  expect(summary.unlocked).toEqual([]);
  expect(summary.blocked.length).toBeGreaterThanOrEqual(11);
});

it("leaves results untouched in the returned summary", () => {
  const claude: GateResult = {
    name: "claude",
    status: "passed",
    ...baseResult
  };
  const summary = summarizeGates([claude]);
  expect(summary.results).toContain(claude);
  expect(summary.results).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Evidence-file loading: the aggregator consumes only the GateResult JSON
// written by each gate's own run-real-gate.ts wrapper. These tests pin the
// load-side failure mapping.
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "phase0-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("loadEvidence accepts a GateResult file produced by a gate wrapper", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "claude.json");
    await writeFile(
      p,
      JSON.stringify({
        name: "claude",
        status: "passed",
        startedAt: "2026-08-01T00:00:00.000Z",
        finishedAt: "2026-08-01T00:01:00.000Z",
        checks: [{ name: "framing", passed: true }],
        evidence: { exit_code: 0 }
      }),
      "utf8"
    );
    const outcome = await loadEvidence(p);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.name).toBe("claude");
      expect(outcome.result.status).toBe("passed");
    }
  });
});

it("loadEvidence rejects malformed JSON as an error outcome", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "transcript.json");
    await writeFile(p, "{ not json", "utf8");
    const outcome = await loadEvidence(p);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("malformed JSON");
    }
  });
});

it("loadEvidence rejects a schema-violating GateResult as an error outcome", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "cloudflare.json");
    await writeFile(p, JSON.stringify({ name: "cloudflare", status: "sideways" }), "utf8");
    const outcome = await loadEvidence(p);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("schema violation");
    }
  });
});

it("a load failure feeds synthesizeFailed, which demotes every dependent capability", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "claude.json");
    await writeFile(p, "]]]", "utf8");
    const outcome = await loadEvidence(p);
    expect(outcome.ok).toBe(false);
    const failed = synthesizeFailed(
      "claude",
      outcome.ok ? "" : outcome.reason,
      "2026-08-01T00:00:00.000Z"
    );
    expect(failed.status).toBe("failed");
    const summary = summarizeGates([failed]);
    expect(summary.unlocked).not.toContain("session-supervisor");
    for (const cap of CAPABILITY_MATRIX.claude) {
      expect(summary.blocked).toContain(cap);
    }
  });
});

it("synthesizeNotRun produces schema-valid not_run evidence", () => {
  const r = synthesizeNotRun("transcript", "2026-08-01T00:00:00.000Z");
  expect(r).toEqual({
    name: "transcript",
    status: "not_run",
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: "2026-08-01T00:00:00.000Z",
    checks: [],
    evidence: {}
  });
  const summary = summarizeGates([r]);
  expect(summary.unlocked).toEqual([]);
  expect(summary.blocked.length).toBe(11);
});

it("every not_run/failed/loaded path blocks, never unlocks, its gate's capabilities", () => {
  // Exhaustive over the three non-passed statuses a gate result can carry.
  for (const status of ["not_run", "failed"] as const) {
    const summary = summarizeGates([
      { name: "claude", status, ...baseResult },
      { name: "transcript", status, ...baseResult },
      { name: "cloudflare", status, ...baseResult }
    ]);
    expect(summary.unlocked).toEqual([]);
    expect(summary.blocked).toHaveLength(11);
  }
});

// ---------------------------------------------------------------------------
// Subprocess invariant: the aggregator is evidence-only. It must never
// import child_process, so no code path can spawn a gate process.
// ---------------------------------------------------------------------------

it("the aggregator never imports child_process", async () => {
  const source = await readFile(new URL("./run-phase0.ts", import.meta.url), "utf8");
  // No process-spawning anywhere in the module...
  expect(source).not.toMatch(/child_process/);
  expect(source).not.toMatch(/\bspawn\b/);
  expect(source).not.toMatch(/\bexecFile\b/);
  expect(source).not.toMatch(/\bexecSync\b/);
  // ...and its entire static import list is I/O + schema validation only.
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  expect(imports.length).toBeGreaterThan(0);
  for (const spec of imports) {
    expect(spec).not.toMatch(/child_process|worker_threads|node:os/);
  }
});

it("every map-outcome module maps onto a gate the aggregator recognizes", async () => {
  // The three gate wrappers' mappers must emit results whose `name` is one
  // of the aggregator's known gates; otherwise summarizeGates would
  // silently drop the gate and block its capabilities.
  const { mapOutcomeToGateResult: claudeMap } = await import("./claude-code/map-outcome.js");
  const { mapOutcomeToGateResult: transcriptMap } = await import("./transcript/map-outcome.js");
  const { mapOutcomeToGateResult: cloudflareMap } = await import("./cloudflare/map-outcome.js");

  const o = { startedAt: "x", finishedAt: "y" };
  const names = [
    claudeMap({ kind: "missing_prereq", reason: "x" }, o).name,
    transcriptMap(
      { kind: "missing_prereq", checkName: "c", reason: "x", evidenceKey: "k", evidenceValue: false },
      o
    ).name,
    cloudflareMap({ kind: "missing_env", reason: "x", envComplete: false }, o).name
  ];
  expect(new Set(names).size).toBe(3);
  for (const n of names) {
    expect(["claude", "transcript", "cloudflare"]).toContain(n);
  }
});

it("summarizeGates accepts mapper-produced passed results and unlocks their capabilities", async () => {
  const { mapOutcomeToGateResult: claudeMap } = await import("./claude-code/map-outcome.js");
  const claudePassed = claudeMap(
    { kind: "success", checks: { framing: true, handshake: true } },
    { startedAt: "x", finishedAt: "y" }
  );
  const summary = summarizeGates([claudePassed]);
  expect(summary.unlocked).toEqual([...CAPABILITY_MATRIX.claude]);
});

it("mapper-produced evidence round-trips through loadEvidence schema validation", async () => {
  // The full contract: a gate wrapper serializes its mapper's output to
  // build/phase0/<gate>.json; the aggregator reads that exact file back.
  // Every mapper variant for all three gates must survive the ajv schema.
  const { mapOutcomeToGateResult: claudeMap } = await import("./claude-code/map-outcome.js");
  const { mapOutcomeToGateResult: transcriptMap } = await import("./transcript/map-outcome.js");
  const { mapOutcomeToGateResult: cloudflareMap } = await import("./cloudflare/map-outcome.js");

  const o = { startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:01:00.000Z" };
  const samples: GateResult[] = [
    claudeMap({ kind: "missing_prereq", reason: "no auth" }, o),
    claudeMap({ kind: "timeout", deadlineMs: 1000 }, o),
    claudeMap({ kind: "signal", signal: "SIGKILL" }, o),
    claudeMap({ kind: "nonzero", code: 1, reason: "assertion" }, o),
    claudeMap({ kind: "malformed", reason: "no CHECKS_PATH" }, o),
    claudeMap({ kind: "success", checks: { framing: true, handshake: "bad" } }, o),
    claudeMap({ kind: "success", checks: { framing: true } }, o),
    transcriptMap(
      {
        kind: "missing_prereq",
        checkName: "manifest_env",
        reason: "not set",
        evidenceKey: "manifest_set",
        evidenceValue: false
      },
      o
    ),
    transcriptMap({ kind: "nonzero", code: 2, stderrTail: "boom" }, o),
    transcriptMap(
      {
        kind: "checks",
        checks: { coverageUnion: ["user"], perEntry: [] },
        before: {},
        after: {}
      },
      o
    ),
    cloudflareMap({ kind: "missing_env", reason: "opt-in not set", envComplete: false }, o),
    cloudflareMap({ kind: "app_link_unverified", probeHost: "h.example.com" }, o),
    cloudflareMap({ kind: "origin_handshake_failed" }, o),
    cloudflareMap(
      {
        kind: "device_run",
        exit: { kind: "exit", code: 0 },
        barrierSeen: true,
        evidencePulled: true,
        deviceEvidence: {
          issuer: "https://t.example.com",
          audience: "a",
          subject: "s",
          expiredHttpRejected: true,
          expiredWsRejected: true,
          refreshedHttpOk: true,
          lanUnreachable: true,
          postTunnelHttpFailed: true,
          postTunnelWsFailed: true
        },
        evidenceError: null,
        expected: { issuer: "https://t.example.com", audience: "a", subject: "s" },
        overallTimeoutMs: 1,
        lastOriginRequestId: "r",
        gradleExitCode: 0
      },
      o
    ),
    cloudflareMap(
      {
        kind: "device_run",
        exit: { kind: "timeout" },
        barrierSeen: false,
        evidencePulled: false,
        deviceEvidence: null,
        evidenceError: null,
        expected: { issuer: "i", audience: "a", subject: "s" },
        overallTimeoutMs: 1,
        lastOriginRequestId: "",
        gradleExitCode: null
      },
      o
    )
  ];

  await withTempDir(async (dir) => {
    for (const sample of samples) {
      const p = join(dir, `${sample.name}-${sample.status}-${samples.indexOf(sample)}.json`);
      await writeFile(p, JSON.stringify(sample), "utf8");
      const outcome = await loadEvidence(p);
      expect(outcome.ok, `${sample.name}/${sample.status}: ${outcome.ok ? "" : outcome.reason}`).toBe(true);
    }
  });
});
