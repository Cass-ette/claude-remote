import { expect, it } from "vitest";
import {
  summarizeGates,
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
