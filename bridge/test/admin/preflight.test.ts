/**
 * Preflight self-check tests (implementation-plan Task 36; spec §10.1, §11).
 *
 * Drives the admin CLI's `preflight` subcommand through runAdminCli with a
 * temporary BRIDGE_DATA_DIR and every external effect injected (JWKS fetcher,
 * command runner for cloudflared, Cloudflare API fetcher, bridge spawner,
 * stat/uid/home seams) and asserts the exit code, the human-readable output,
 * and the `--json` structured report for each of the seven plan checks.
 *
 * SECURITY assertions: the CF API token never appears in any output, the
 * JWKS check never logs assertion material, and secrets ride environments,
 * never argv.
 */
import { createConnection, createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../../src/db/database.js";
import { createDeviceAuth } from "../../src/auth/device-auth.js";
import { createProjectRegistry } from "../../src/projects/project-registry.js";
import { createAuditLog } from "../../src/audit/audit-log.js";
import { runAdminCli, type AdminCliDeps } from "../../src/admin/cli.js";
import {
  defaultBridgeHealthProber,
  healthUrl,
  type BridgeHealthProbeInput,
  type BridgeHealthProber,
} from "../../src/admin/preflight.js";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");

/**
 * Host-independent uid: the preflight pass tests stat the real temp dirs
 * (owned by whoever runs vitest — 501 on macOS, 1000 on Linux CI), so the
 * injected getuid must follow the same source instead of hardcoding 501.
 */
const TEST_UID = process.getuid?.() ?? 501;

let dataDir: string;
let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "preflight-test-"));
  dataDir = join(tempRoot, "data");
  mkdirSync(dataDir, { mode: 0o700 });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeDeps(
  envExtra: Record<string, string> = {},
  overrides: Partial<AdminCliDeps> = {},
): { deps: AdminCliDeps; output: () => string } {
  const chunks: string[] = [];
  const deps: AdminCliDeps = {
    env: { BRIDGE_DATA_DIR: dataDir, ...envExtra },
    now: () => T0,
    openDb: (databasePath) => {
      const db = openDatabase(databasePath, { createDir: false });
      migrate(db);
      return db;
    },
    createRegistry: (db) => createProjectRegistry(db),
    createDevices: (db, deviceSessionTtlSeconds) =>
      createDeviceAuth(db, { deviceSessionTtlSeconds }),
    createAudit: (db, filePath, now) => createAuditLog({ filePath, db, now }),
    fetchJwks: async () => {
      throw new Error("fetchJwks not stubbed for this test");
    },
    renderQr: (payload) => `<QR>${payload}</QR>`,
    write: (text) => {
      chunks.push(text);
    },
    // Preflight-only seams (Task 36): inert by default so tests opt in.
    runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    fetchAccessApps: async () => {
      throw new Error("fetchAccessApps not stubbed for this test");
    },
    probeBridgeHealth: async () => ({
      healthy: true,
      detail: "GET http://127.0.0.1:43111/api/v1/health answered ok (stub)",
    }),
    getuid: () => TEST_UID,
    homeDir: "/Users/tester",
    healthTimeoutMs: 5_000,
    ...overrides,
  };
  return { deps, output: () => chunks.join("") };
}

interface FakeCommand {
  calls: string[][];
  runCommand: AdminCliDeps["runCommand"];
}

function fakeCommandRunner(
  respond?: (command: string[]) => { code: number; stdout: string; stderr: string },
): FakeCommand {
  const calls: string[][] = [];
  return {
    calls,
    runCommand: async (command) => {
      calls.push(command);
      return respond === undefined ? { code: 0, stdout: "", stderr: "" } : respond(command);
    },
  };
}

/** Prober stub that records its input and returns a fixed outcome. */
function recordingProber(outcome: { healthy: boolean; detail: string }): {
  inputs: BridgeHealthProbeInput[];
  probeBridgeHealth: BridgeHealthProber;
} {
  const inputs: BridgeHealthProbeInput[] = [];
  return {
    inputs,
    probeBridgeHealth: async (input) => {
      inputs.push(input);
      return outcome;
    },
  };
}

// ---------------------------------------------------------------------------
// Check 1 — loopback-only bind
// ---------------------------------------------------------------------------

describe("preflight: loopback bind", () => {
  it("passes with the default 127.0.0.1 host", async () => {
    const { deps, output } = makeDeps();
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(output()).toContain("PASS  loopback-bind: BRIDGE_HOST=127.0.0.1 (loopback only)");
  });

  it("accepts ::1 as the IPv6 loopback", async () => {
    const { deps, output } = makeDeps({ BRIDGE_HOST: "::1" });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(output()).toContain("PASS  loopback-bind: BRIDGE_HOST=::1 (loopback only)");
  });

  it("fails and skips later checks on a non-loopback host", async () => {
    const { deps, output } = makeDeps({ BRIDGE_HOST: "0.0.0.0" });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    const text = output();
    expect(text).toContain("FAIL  loopback-bind:");
    expect(text).toContain("loopback");
    expect(text).toContain("configuration is invalid");
    expect(text).not.toContain("PASS  database:");
    expect(text).toContain("error: preflight failed");
  });
});

// ---------------------------------------------------------------------------
// Check 2 — Cloudflare Access JWKS reachability
// ---------------------------------------------------------------------------

describe("preflight: cloudflare-jwks", () => {
  it("passes when the team JWKS endpoint answers", async () => {
    const fetched: string[] = [];
    const { deps, output } = makeDeps(
      {
        BRIDGE_CLOUDFLARE_TEAM_DOMAIN: "myteam.cloudflareaccess.com",
        BRIDGE_CLOUDFLARE_AUD: "deadbeef-tag",
      },
      {
        fetchJwks: async (teamDomain) => {
          fetched.push(teamDomain);
          return { keys: [] };
        },
      },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(fetched).toEqual(["myteam.cloudflareaccess.com"]);
    expect(output()).toContain(
      "PASS  cloudflare-jwks: https://myteam.cloudflareaccess.com/cdn-cgi/access/certs reachable",
    );
  });

  it("fails with a nonzero exit when the JWKS endpoint is unreachable", async () => {
    const { deps, output } = makeDeps(
      {
        BRIDGE_CLOUDFLARE_TEAM_DOMAIN: "myteam.cloudflareaccess.com",
        BRIDGE_CLOUDFLARE_AUD: "deadbeef-tag",
      },
      {
        fetchJwks: async () => {
          throw new Error("JWKS fetch failed: HTTP 503");
        },
      },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    const text = output();
    expect(text).toContain("FAIL  cloudflare-jwks: JWKS unreachable: JWKS fetch failed: HTTP 503");
    expect(text).toContain("PASS  database:");
    expect(text).toContain("error: preflight failed: 1 check(s) failed");
  });

  it("INFO-skips when Access is not configured (local-only bridge)", async () => {
    const { deps, output } = makeDeps();
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(output()).toContain("INFO  cloudflare-jwks:");
    expect(output()).not.toContain("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Check 3 — data dir mode + ownership
// ---------------------------------------------------------------------------

describe("preflight: data-dir", () => {
  it("passes for a 0700 dir owned by the current user", async () => {
    const { deps, output } = makeDeps();
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(output()).toMatch(/PASS  data-dir: .*mode 0700/);
  });

  it("fails when group/other permissions are present (0755)", async () => {
    const { deps, output } = makeDeps(
      {},
      {
        statDataDir: () => ({ mode: 0o755, uid: 501 }),
      },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  data-dir: .*expected 0700/);
  });

  it("fails when the dir is owned by another user", async () => {
    const { deps, output } = makeDeps(
      {},
      {
        statDataDir: () => ({ mode: 0o700, uid: 12345 }),
        getuid: () => 501,
      },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  data-dir: .*owned by uid 12345.*current user/);
  });

  it("fails when the dir cannot be stat'ed", async () => {
    const { deps, output } = makeDeps(
      {},
      {
        statDataDir: () => {
          throw new Error("ENOENT: no such file or directory");
        },
      },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  data-dir: cannot stat/);
  });
});

// ---------------------------------------------------------------------------
// Check 4 — plist path stays inside ~/Library/LaunchAgents
// ---------------------------------------------------------------------------

describe("preflight: plist-path", () => {
  it("passes for a plist inside ~/Library/LaunchAgents", async () => {
    const { deps, output } = makeDeps({
      BRIDGE_PLIST_PATH: "/Users/tester/Library/LaunchAgents/dev.clauderemote.bridge.plist",
    });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(output()).toContain(
      "PASS  plist-path: /Users/tester/Library/LaunchAgents/dev.clauderemote.bridge.plist resolves inside ~/Library/LaunchAgents",
    );
  });

  it("fails for /Library/LaunchDaemons (system-wide, would run as root)", async () => {
    const { deps, output } = makeDeps({
      BRIDGE_PLIST_PATH: "/Library/LaunchDaemons/dev.clauderemote.bridge.plist",
    });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  plist-path: .*LaunchAgents/);
    expect(output()).toMatch(/never (run as )?root|per-user/);
  });

  it("fails for a path outside ~/Library/LaunchAgents", async () => {
    const { deps, output } = makeDeps({
      BRIDGE_PLIST_PATH: "/Users/tester/Elsewhere/dev.clauderemote.bridge.plist",
    });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  plist-path: .*outside .*LaunchAgents/);
  });

  it("fails for a relative path", async () => {
    const { deps, output } = makeDeps({ BRIDGE_PLIST_PATH: "LaunchAgents/dev.clauderemote.bridge.plist" });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  plist-path: .*absolute/);
  });

  it("INFO-skips when BRIDGE_PLIST_PATH is not set", async () => {
    const { deps, output } = makeDeps();
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(output()).toContain("INFO  plist-path: BRIDGE_PLIST_PATH not set");
  });
});

// ---------------------------------------------------------------------------
// Check 5 — cloudflared presence + named tunnel lookup
// ---------------------------------------------------------------------------

describe("preflight: cloudflared-tunnel", () => {
  it("passes and runs `cloudflared tunnel info <name>` when the tunnel is found", async () => {
    const fake = fakeCommandRunner();
    const { deps, output } = makeDeps(
      { BRIDGE_CLOUDFLARE_TUNNEL_NAME: "claude-remote-bridge" },
      { runCommand: fake.runCommand },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(fake.calls).toEqual([["cloudflared", "tunnel", "info", "claude-remote-bridge"]]);
    expect(output()).toContain("PASS  cloudflared-tunnel:");
  });

  it("fails when the tunnel cannot be found (nonzero exit)", async () => {
    const fake = fakeCommandRunner(() => ({
      code: 1,
      stdout: "",
      stderr: "failed to get tunnel: tunnel not found",
    }));
    const { deps, output } = makeDeps(
      { BRIDGE_CLOUDFLARE_TUNNEL_NAME: "ghost-tunnel" },
      { runCommand: fake.runCommand },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  cloudflared-tunnel: .*tunnel not found/);
  });

  it("fails when cloudflared is not installed (ENOENT)", async () => {
    const fake = fakeCommandRunner(() => ({
      code: 1,
      stdout: "",
      stderr: "spawn cloudflared ENOENT",
    }));
    const { deps, output } = makeDeps(
      { BRIDGE_CLOUDFLARE_TUNNEL_NAME: "claude-remote-bridge" },
      { runCommand: fake.runCommand },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  cloudflared-tunnel: cloudflared is not installed/);
  });

  it("INFO-skips when no tunnel name is configured", async () => {
    const fake = fakeCommandRunner();
    const { deps, output } = makeDeps({}, { runCommand: fake.runCommand });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(output()).toContain("INFO  cloudflared-tunnel:");
  });
});

// ---------------------------------------------------------------------------
// Check 6 — Access application identity policy includes the expected subject
// ---------------------------------------------------------------------------

describe("preflight: access-policy-subject", () => {
  const CF_ENV = {
    CF_API_TOKEN: "cf-secret-token-do-not-log",
    CF_ZONE_ID: "023e105f4ecef8ad9ca31a8372d0c353",
    CF_EXPECTED_SUBJECT: "user@example.com",
    BRIDGE_CLOUDFLARE_TEAM_DOMAIN: "myteam.cloudflareaccess.com",
    BRIDGE_CLOUDFLARE_AUD: "deadbeef-tag",
  };
  /** The team domain in CF_ENV also arms the JWKS check — keep it green. */
  const OK_JWKS = { fetchJwks: async () => ({ keys: [] }) };

  it("passes when the app's include policy has the expected subject (nested email object)", async () => {
    const fetched: Array<{ apiToken: string; zoneId: string }> = [];
    const { deps, output } = makeDeps(CF_ENV, {
      ...OK_JWKS,
      fetchAccessApps: async (input) => {
        fetched.push(input);
        return {
          success: true,
          result: [
            { id: "app-1", name: "Bridge", aud: "other-tag", include: [] },
            {
              id: "app-2",
              name: "claude-remote bridge",
              aud: "deadbeef-tag",
              include: [{ email: { email: "someone-else@example.com" } }],
              policies: [{ id: "pol-1", decision: "include", include: [{ email: { email: "user@example.com" } }] }],
            },
          ],
        };
      },
    });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(fetched).toEqual([
      { apiToken: "cf-secret-token-do-not-log", zoneId: "023e105f4ecef8ad9ca31a8372d0c353" },
    ]);
    const text = output();
    expect(text).toContain("PASS  access-policy-subject:");
    expect(text).toContain("user@example.com");
    // SECURITY: the API token is never logged.
    expect(text).not.toContain("cf-secret-token-do-not-log");
  });

  it("passes with the flat email-string include shape", async () => {
    const { deps, output } = makeDeps(CF_ENV, {
      ...OK_JWKS,
      fetchAccessApps: async () => [
        { id: "app-9", name: "flat", aud: "deadbeef-tag", include: [{ email: "USER@example.com" }] },
      ],
    });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(output()).toContain("PASS  access-policy-subject:");
  });

  it("fails when the policy does not include the expected subject", async () => {
    const { deps, output } = makeDeps(CF_ENV, {
      fetchAccessApps: async () => ({
        result: [{ id: "app-2", name: "claude-remote bridge", aud: "deadbeef-tag", include: [{ email: "other@example.com" }] }],
      }),
    });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  access-policy-subject: .*does not include user@example\.com/);
    expect(output()).not.toContain("cf-secret-token-do-not-log");
  });

  it("fails when no Access application matches the configured AUD", async () => {
    const { deps, output } = makeDeps(CF_ENV, {
      fetchAccessApps: async () => ({ result: [{ id: "app-1", aud: "unrelated" }] }),
    });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  access-policy-subject: .*no Access application.*deadbeef-tag/);
  });

  it("fails when only part of the CF_API_TOKEN/CF_ZONE_ID/CF_EXPECTED_SUBJECT triple is set", async () => {
    const { deps, output } = makeDeps({ CF_API_TOKEN: "cf-secret-token-do-not-log" });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  access-policy-subject: .*must be set together/);
  });

  it("fails when the CF triple is set but BRIDGE_CLOUDFLARE_AUD is missing", async () => {
    const { deps, output } = makeDeps({
      CF_API_TOKEN: "cf-secret-token-do-not-log",
      CF_ZONE_ID: "023e105f4ecef8ad9ca31a8372d0c353",
      CF_EXPECTED_SUBJECT: "user@example.com",
    });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    expect(output()).toMatch(/FAIL  access-policy-subject: .*BRIDGE_CLOUDFLARE_AUD/);
  });

  it("INFO-skips when none of the CF_* variables are set", async () => {
    const { deps, output } = makeDeps();
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(output()).toContain("INFO  access-policy-subject:");
  });
});

// ---------------------------------------------------------------------------
// Check 7 — loopback health probe of the spawned bridge
// ---------------------------------------------------------------------------

describe("preflight: bridge-health", () => {
  function writeFakeMain(): string {
    const mainPath = join(tempRoot, "fake-main.js");
    writeFileSync(mainPath, "// stand-in for the built bridge entry\n");
    return mainPath;
  }

  it("passes when the probe reports healthy and passes the spawn contract", async () => {
    const mainPath = writeFakeMain();
    const prober = recordingProber({
      healthy: true,
      detail: 'GET http://127.0.0.1:43111/api/v1/health answered {"status":"ok"}',
    });
    const { deps, output } = makeDeps(
      { BRIDGE_MAIN: mainPath, BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "43111" },
      { probeBridgeHealth: prober.probeBridgeHealth },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(output()).toContain('PASS  bridge-health: GET http://127.0.0.1:43111/api/v1/health answered {"status":"ok"}');

    expect(prober.inputs).toHaveLength(1);
    const input = prober.inputs[0];
    expect(input).toBeDefined();
    if (input === undefined) return;
    expect(input.bridgeMain).toBe(mainPath);
    expect(input.nodeBin).toBe(process.execPath);
    expect(input.host).toBe("127.0.0.1");
    expect(input.port).toBe(43111);
    expect(input.timeoutMs).toBeGreaterThan(0);
    expect(input.occupiedGraceMs).toBeGreaterThan(0);
    // The spawn contract from the plan: BRIDGE_PREFLIGHT_HEALTH_ONLY=1 on the
    // loopback bind, and the operator env (incl. BRIDGE_DATA_DIR) flows in.
    expect(input.env.BRIDGE_PREFLIGHT_HEALTH_ONLY).toBe("1");
    expect(input.env.BRIDGE_HOST).toBe("127.0.0.1");
    expect(input.env.BRIDGE_PORT).toBe("43111");
    expect(input.env.BRIDGE_DATA_DIR).toBe(dataDir);
  });

  it("fails with a nonzero exit when the probe reports unhealthy", async () => {
    const mainPath = writeFakeMain();
    const { deps, output } = makeDeps(
      { BRIDGE_MAIN: mainPath },
      {
        probeBridgeHealth: async () => ({
          healthy: false,
          detail: "http://127.0.0.1:43111/api/v1/health did not answer within 500ms",
        }),
      },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(1);
    const text = output();
    expect(text).toMatch(/FAIL  bridge-health: .*did not answer/);
    expect(text.match(/FAIL/g)).toHaveLength(1);
    expect(text).toContain("error: preflight failed: 1 check(s) failed");
  });

  it("INFO-skips when no built bridge entry exists", async () => {
    const prober = recordingProber({ healthy: true, detail: "must not be called" });
    const { deps, output } = makeDeps({}, { probeBridgeHealth: prober.probeBridgeHealth });
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(prober.inputs).toEqual([]);
    expect(output()).toContain("INFO  bridge-health:");
    expect(output()).not.toContain("FAIL");
  });

  it("INFO-skips when BRIDGE_MAIN points at a missing file", async () => {
    const prober = recordingProber({ healthy: true, detail: "must not be called" });
    const { deps, output } = makeDeps(
      { BRIDGE_MAIN: join(tempRoot, "does-not-exist.js") },
      { probeBridgeHealth: prober.probeBridgeHealth },
    );
    const code = await runAdminCli(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(prober.inputs).toEqual([]);
    expect(output()).toContain("INFO  bridge-health:");
  });
});

// ---------------------------------------------------------------------------
// Structured --json output
// ---------------------------------------------------------------------------

describe("preflight: --json structured output", () => {
  it("emits a machine-readable report and exits 0 when everything passes", async () => {
    const { deps, output } = makeDeps();
    const code = await runAdminCli(["admin", "preflight", "--json"], deps);
    expect(code).toBe(0);
    const report = JSON.parse(output()) as {
      ok: boolean;
      failed: number;
      checks: Array<{ name: string; passed: boolean; status: string; details: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    const byName = new Map(report.checks.map((check) => [check.name, check]));
    expect(byName.get("loopback-bind")).toMatchObject({ passed: true, status: "pass" });
    expect(byName.get("cloudflare-jwks")).toMatchObject({ passed: true, status: "info" });
    for (const check of report.checks) {
      expect(check.passed).toBe(true);
      expect(["pass", "info"]).toContain(check.status);
      expect(typeof check.details).toBe("string");
    }
  });

  it("emits pure JSON (no trailing error line) and exits nonzero on failure", async () => {
    const { deps, output } = makeDeps(
      {
        BRIDGE_CLOUDFLARE_TEAM_DOMAIN: "myteam.cloudflareaccess.com",
        BRIDGE_CLOUDFLARE_AUD: "deadbeef-tag",
      },
      {
        fetchJwks: async () => {
          throw new Error("JWKS fetch failed: HTTP 503");
        },
      },
    );
    const code = await runAdminCli(["admin", "preflight", "--json"], deps);
    expect(code).toBe(1);
    const report = JSON.parse(output()) as {
      ok: boolean;
      failed: number;
      checks: Array<{ name: string; passed: boolean; details: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    const jwks = report.checks.find((check) => check.name === "cloudflare-jwks");
    expect(jwks).toMatchObject({ passed: false, details: expect.stringContaining("JWKS unreachable") });
  });
});

// ---------------------------------------------------------------------------
// Probe URL construction (IPv4 vs IPv6)
// ---------------------------------------------------------------------------

describe("healthUrl", () => {
  it("builds the IPv4 loopback URL unchanged", () => {
    expect(healthUrl("127.0.0.1", 43111)).toBe("http://127.0.0.1:43111/api/v1/health");
  });

  it("brackets an IPv6 host so the probe URL is valid", () => {
    expect(healthUrl("::1", 43111)).toBe("http://[::1]:43111/api/v1/health");
    expect(() => new URL(healthUrl("::1", 43111))).not.toThrow();
    // Unbracketed, the same URL is invalid — the regression this guards.
    expect(() => new URL(`http://::1:43111/api/v1/health`)).toThrow();
  });

  it("leaves an already-bracketed IPv6 host alone", () => {
    expect(healthUrl("[::1]", 43111)).toBe("http://[::1]:43111/api/v1/health");
  });
});

// ---------------------------------------------------------------------------
// The real prober: spawn node, poll until answered, terminate the child
// ---------------------------------------------------------------------------

/** Grab a free TCP port on 127.0.0.1 and release it again. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** Expect nothing to be listening on the port anymore. */
function expectPortClosed(port: number, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolveClosed, rejectOpen) => {
    const socket = createConnection({ host, port }, () => {
      socket.destroy();
      rejectOpen(new Error(`port ${port} on ${host} is still open`));
    });
    socket.on("error", () => resolveClosed());
  });
}

function writeScript(name: string, body: string): string {
  const path = join(tempRoot, name);
  writeFileSync(path, body);
  return path;
}

const HEALTHY_BRIDGE = `import http from "node:http";
if (process.env.BRIDGE_PREFLIGHT_HEALTH_ONLY !== "1") process.exit(9);
const server = http.createServer((req, res) => {
  if (req.url === "/api/v1/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
server.listen(Number(process.env.BRIDGE_PORT), process.env.BRIDGE_HOST ?? "127.0.0.1");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`;

describe("defaultBridgeHealthProber (real child process)", () => {
  it("reports healthy on a 200 {status:ok} answer and terminates the child", async () => {
    const port = await freePort();
    const bridgeMain = writeScript("healthy-bridge.mjs", HEALTHY_BRIDGE);
    const result = await defaultBridgeHealthProber({
      nodeBin: process.execPath,
      bridgeMain,
      host: "127.0.0.1",
      port,
      timeoutMs: 10_000,
      env: {
        BRIDGE_PREFLIGHT_HEALTH_ONLY: "1",
        BRIDGE_HOST: "127.0.0.1",
        BRIDGE_PORT: String(port),
        BRIDGE_DATA_DIR: dataDir,
      },
    });
    expect(result.healthy).toBe(true);
    expect(result.detail).toContain("/api/v1/health");
    // The prober resolves only after the child is gone; the port is free again.
    await expectPortClosed(port);
  }, 15_000);

  it("reports unhealthy when the child never listens (timeout, child killed)", async () => {
    const port = await freePort();
    const bridgeMain = writeScript(
      "idle-bridge.mjs",
      "process.once('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n",
    );
    const result = await defaultBridgeHealthProber({
      nodeBin: process.execPath,
      bridgeMain,
      host: "127.0.0.1",
      port,
      timeoutMs: 800,
      env: { BRIDGE_PORT: String(port), BRIDGE_HOST: "127.0.0.1" },
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toMatch(/did not answer within 800ms/);
    await expectPortClosed(port);
  }, 15_000);

  it("reports unhealthy when the child exits before answering", async () => {
    const port = await freePort();
    const bridgeMain = writeScript("crashing-bridge.mjs", "process.exit(3);\n");
    const result = await defaultBridgeHealthProber({
      nodeBin: process.execPath,
      bridgeMain,
      host: "127.0.0.1",
      port,
      timeoutMs: 5_000,
      env: { BRIDGE_PORT: String(port), BRIDGE_HOST: "127.0.0.1" },
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toMatch(/exited with code 3/);
  }, 15_000);

  // The reinstall race (must-fix): the old launchd job still holds the port
  // and answers OK in ~ms, while the freshly spawned child needs far longer
  // to hit EADDRINUSE and exit. An OK answer must not pass while the doomed
  // child is merely still booting.
  it("fails when another process already owns the port (occupied-port race)", async () => {
    const occupier = createHttpServer((req, res) => {
      if (req.url === "/api/v1/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    const port = await new Promise<number>((resolvePort, reject) => {
      occupier.once("error", reject);
      occupier.listen(0, "127.0.0.1", () => {
        const address = occupier.address();
        resolvePort(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    try {
      // Fake child that binds nothing and exits ~50ms after boot,
      // simulating the latency of hitting EADDRINUSE against the occupier.
      const bridgeMain = writeScript("eaddrinuse-bridge.mjs", "setTimeout(() => process.exit(1), 50);\n");
      const result = await defaultBridgeHealthProber({
        nodeBin: process.execPath,
        bridgeMain,
        host: "127.0.0.1",
        port,
        timeoutMs: 10_000,
        occupiedGraceMs: 5_000,
        env: {
          BRIDGE_PREFLIGHT_HEALTH_ONLY: "1",
          BRIDGE_HOST: "127.0.0.1",
          BRIDGE_PORT: String(port),
          BRIDGE_DATA_DIR: dataDir,
        },
      });
      expect(result.healthy).toBe(false);
      expect(result.detail).toMatch(
        /another process on 127\.0\.0\.1:\d+ answered .*exited with code 1/,
      );
    } finally {
      // The prober's fetch keep-alives its socket; drop it so close() ends.
      occupier.closeAllConnections();
      await new Promise<void>((resolveClose) => occupier.close(() => resolveClose()));
    }
  }, 15_000);

  it("passes on an IPv6 ::1 bind (bracketed probe URL) with the child alive through the grace window", async () => {
    const port = await freePort();
    const bridgeMain = writeScript("healthy-bridge-v6.mjs", HEALTHY_BRIDGE);
    const result = await defaultBridgeHealthProber({
      nodeBin: process.execPath,
      bridgeMain,
      host: "::1",
      port,
      timeoutMs: 10_000,
      occupiedGraceMs: 400,
      env: {
        BRIDGE_PREFLIGHT_HEALTH_ONLY: "1",
        BRIDGE_HOST: "::1",
        BRIDGE_PORT: String(port),
        BRIDGE_DATA_DIR: dataDir,
      },
    });
    expect(result.healthy).toBe(true);
    expect(result.detail).toContain(`http://[::1]:${port}/api/v1/health`);
    expect(result.detail).toContain("grace window");
    await expectPortClosed(port, "::1");
  }, 15_000);
});
