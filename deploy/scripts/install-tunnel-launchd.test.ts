import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InstallError,
  type CommandRunner,
} from "./install-launchd.js";
import {
  installTunnel,
  normalizeTunnelInstallConfig,
  parseTunnelArgs,
  renderTunnelPlist,
  resolveTunnelPaths,
  resolveTunnelPlistTarget,
  runTunnelPreflight,
  TUNNEL_PLIST_FILENAME,
  TUNNEL_PLIST_LABEL,
  TUNNEL_TEMPLATE_PATH,
  type TunnelInstallConfig,
} from "./install-tunnel-launchd.js";
import { uninstallTunnel } from "./uninstall-tunnel-launchd.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tunnel-launchd-test-"));
  scratchDirs.push(dir);
  return dir;
}

/**
 * Minimal valid tunnel config pointing at fixture files under `home`:
 * an executable cloudflared stub, a config.yml with tunnel +
 * credentials-file lines, and a readable credentials file.
 */
function fixtureConfig(home: string, extraConfigLines: string[] = []): TunnelInstallConfig {
  const cloudflaredBin = join(home, "bin", "cloudflared");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(cloudflaredBin, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(cloudflaredBin, 0o755);

  const credentials = join(home, ".cloudflared", "tunnel-credentials.json");
  mkdirSync(join(home, ".cloudflared"), { recursive: true });
  writeFileSync(credentials, `{"AccountTag":"acct","TunnelSecret":"sec"}`, { mode: 0o600 });

  const tunnelConfig = join(home, ".cloudflared", "config.yml");
  writeFileSync(
    tunnelConfig,
    [`tunnel: 46507cb0-48d4-4ed4-86bd-70a766aed533`, `credentials-file: ${credentials}`, ...extraConfigLines].join("\n") + "\n",
  );

  return normalizeTunnelInstallConfig({
    cloudflaredBin,
    tunnelConfig,
    dataDir: join(home, ".local", "share", "claude-remote"),
  });
}

/** All <key> names in a rendered plist (order-preserving). */
function plistKeys(xml: string): string[] {
  return [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1] ?? "");
}

/** key → string-value map for flat <key>/<string> pairs in a rendered plist. */
function plistStrings(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    map.set(m[1] ?? "", m[2] ?? "");
  }
  return map;
}

interface FakeRunner {
  calls: string[][];
  runner: CommandRunner;
}

/**
 * Fake launchctl. `bootout` of the tunnel label returns the "not loaded"
 * text a first install sees; every other failure is injected explicitly.
 */
function fakeRunner(failures: Array<{ match: (cmd: string[]) => boolean; stderr: string }> = []): FakeRunner {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command) {
      calls.push(command);
      for (const failure of failures) {
        if (failure.match(command)) return { code: 1, stdout: "", stderr: failure.stderr };
      }
      if (command[1] === "bootout") {
        return {
          code: 1,
          stdout: "",
          stderr: `Could not find service "${TUNNEL_PLIST_LABEL}" in domain for system`,
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { calls, runner };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

// ---------------------------------------------------------------------------
// Rendered plist invariants
// ---------------------------------------------------------------------------

describe("rendered tunnel launchd plist", () => {
  const home = "/Users/tester";
  const config = normalizeTunnelInstallConfig({
    cloudflaredBin: "/opt/homebrew/bin/cloudflared",
    tunnelConfig: "/Users/tester/.cloudflared/config.yml",
    dataDir: "/Users/tester/.local/share/claude-remote",
  });
  const paths = resolveTunnelPaths({ homeDir: home, dataDir: config.dataDir });
  const plist = renderTunnelPlist(config, paths);

  it("template and rendering omit Sockets and Listeners (connector opens no local port)", async () => {
    const template = await readFile(TUNNEL_TEMPLATE_PATH, "utf8");
    expect(plistKeys(template)).not.toContain("Sockets");
    expect(plistKeys(template)).not.toContain("Listeners");
    expect(plistKeys(plist)).not.toContain("Sockets");
    expect(plistKeys(plist)).not.toContain("Listeners");
  });

  it("points ProgramArguments at the absolute cloudflared + config with --no-autoupdate", () => {
    const args = [...plist.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g)]
      .flatMap((m) => [...(m[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)])
      .map((m) => m[1] ?? "");
    expect(args).toEqual([
      "/opt/homebrew/bin/cloudflared",
      "tunnel",
      "--config",
      "/Users/tester/.cloudflared/config.yml",
      "--no-autoupdate",
      "run",
    ]);
  });

  it("carries no secrets (tunnel id/credentials path stay inside the 0600 config, not this 0644 plist)", () => {
    const strings = plistStrings(plist);
    expect(strings.get("Label")).toBe(TUNNEL_PLIST_LABEL);
    expect(plist).not.toContain("46507cb0");
    expect(plist).not.toContain("TunnelSecret");
    // No substituted <string> value may name the credentials file.
    for (const m of plist.matchAll(/<string>([^<]*)<\/string>/g)) {
      expect(m[1] ?? "").not.toMatch(/credentials/i);
    }
    expect(strings.get("StandardOutPath")).toBe(join(config.dataDir, "logs", "cloudflared.out.log"));
    expect(strings.get("StandardErrorPath")).toBe(join(config.dataDir, "logs", "cloudflared.err.log"));
  });

  it("restarts on nonzero exit only (SuccessfulExit=false; intentional stop stays stopped)", () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  it("XML-escapes substituted values", () => {
    const weirdHome = "/Users/t&e<s>t";
    const weird = normalizeTunnelInstallConfig({
      cloudflaredBin: `${weirdHome}/bin/cloudflared`,
      tunnelConfig: `${weirdHome}/.cloudflared/config.yml`,
      dataDir: `${weirdHome}/data`,
    });
    const xml = renderTunnelPlist(weird, resolveTunnelPaths({ homeDir: weirdHome, dataDir: weird.dataDir }));
    for (const m of xml.matchAll(/<string>([^<]*)<\/string>/g)) {
      const value = m[1] ?? "";
      expect(value).not.toMatch(/</);
      expect(value).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
    }
    expect(xml).toContain("&amp;");
  });
});

// ---------------------------------------------------------------------------
// Path containment — only ever write under ~/Library/LaunchAgents
// ---------------------------------------------------------------------------

describe("resolveTunnelPlistTarget", () => {
  it("defaults to ~/Library/LaunchAgents/dev.clauderemote.cloudflared.plist", () => {
    expect(resolveTunnelPlistTarget("/Users/tester")).toBe(
      join("/Users/tester", "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME),
    );
  });

  it("refuses /Library/LaunchDaemons (cloudflared service install territory) and any path outside ~/Library/LaunchAgents", () => {
    for (const bad of [
      "/Library/LaunchDaemons/com.cloudflare.cloudflared.plist",
      "/Library/LaunchAgents/dev.clauderemote.cloudflared.plist",
      "/Users/tester/Elsewhere/dev.clauderemote.cloudflared.plist",
      "/Users/other/Library/LaunchAgents/dev.clauderemote.cloudflared.plist",
    ]) {
      expect(() => resolveTunnelPlistTarget("/Users/tester", bad)).toThrow(InstallError);
      try {
        resolveTunnelPlistTarget("/Users/tester", bad);
      } catch (error) {
        expect((error as InstallError).code).toBe("PLIST_TARGET_OUTSIDE_LAUNCHAGENTS");
        expect((error as InstallError).message).toMatch(/service install|LaunchAgents/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Preflight gate
// ---------------------------------------------------------------------------

describe("runTunnelPreflight", () => {
  it("passes for an executable bin, config with tunnel+credentials, readable credentials file", () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const paths = resolveTunnelPaths({ homeDir: home, dataDir: config.dataDir });
    const checks = runTunnelPreflight(config, paths);
    expect(checks.map((c) => c.name)).toEqual([
      "cloudflared-bin-absolute-executable",
      "tunnel-config-exists",
      "tunnel-config-has-tunnel-and-credentials",
      "tunnel-credentials-readable",
    ]);
    for (const check of checks) {
      expect({ name: check.name, passed: check.passed }).toEqual({ name: check.name, passed: true });
    }
  });

  it("fails on a missing bin, a missing config, and a config without credentials-file", () => {
    const home = scratchHome();
    const config = normalizeTunnelInstallConfig({
      cloudflaredBin: join(home, "missing", "cloudflared"),
      tunnelConfig: join(home, ".cloudflared", "not-there.yml"),
      dataDir: join(home, "data"),
    });
    const checks = runTunnelPreflight(config, resolveTunnelPaths({ homeDir: home, dataDir: config.dataDir }));
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get("cloudflared-bin-absolute-executable")?.passed).toBe(false);
    expect(byName.get("tunnel-config-exists")?.passed).toBe(false);
    // No credentials-file line was parsed, so the pair check fails and the
    // readable-credentials check is absent rather than misleading.
    expect(byName.get("tunnel-config-has-tunnel-and-credentials")?.passed).toBe(false);
    expect(byName.has("tunnel-credentials-readable")).toBe(false);
  });

  it("fails when the credentials file named in the config is unreadable", () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const credentials = join(home, ".cloudflared", "tunnel-credentials.json");
    rmSync(credentials);
    const checks = runTunnelPreflight(config, resolveTunnelPaths({ homeDir: home, dataDir: config.dataDir }));
    expect(checks.find((c) => c.name === "tunnel-credentials-readable")?.passed).toBe(false);
  });

  it("normalizeTunnelInstallConfig rejects relative paths up-front", () => {
    const base = { cloudflaredBin: "/opt/homebrew/bin/cloudflared", tunnelConfig: "/Users/t/.cloudflared/config.yml", dataDir: "/Users/t/data" };
    expect(() => normalizeTunnelInstallConfig({ ...base, cloudflaredBin: "cloudflared" })).toThrow(InstallError);
    expect(() => normalizeTunnelInstallConfig({ ...base, tunnelConfig: ".cloudflared/config.yml" })).toThrow(InstallError);
    expect(() => normalizeTunnelInstallConfig({ ...base, dataDir: "relative/data" })).toThrow(InstallError);
  });
});

// ---------------------------------------------------------------------------
// Install orchestration with a fake launchctl runner
// ---------------------------------------------------------------------------

describe("installTunnel", () => {
  it("refuses to bootstrap when preflight fails", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { calls, runner } = fakeRunner();
    await expect(
      installTunnel(config, {
        homeDir: home,
        runner,
        uid: 501,
        preflight: () => [{ name: "tunnel-config-exists", passed: false, detail: "missing" }],
      }),
    ).rejects.toMatchObject({ code: "preflight_failed" });
    expect(calls).toEqual([]);
    expect(existsSync(join(home, "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME))).toBe(false);
  });

  it("boots out a stale load, writes plist 0644 + logs 0600, bootstraps gui/$UID last", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { calls, runner } = fakeRunner();
    const result = await installTunnel(config, { homeDir: home, runner, uid: 501 });

    const plistPath = join(home, "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME);
    expect(result.plistPath).toBe(plistPath);
    expect(modeOf(plistPath)).toBe(0o644);
    expect(modeOf(join(config.dataDir, "logs", "cloudflared.out.log"))).toBe(0o600);
    expect(modeOf(join(config.dataDir, "logs", "cloudflared.err.log"))).toBe(0o600);

    // Reinstall sequence: bootout (tolerating not-loaded) then bootstrap.
    expect(calls).toEqual([
      ["/bin/launchctl", "bootout", "gui/501", TUNNEL_PLIST_LABEL],
      ["/bin/launchctl", "bootstrap", "gui/501", plistPath],
    ]);
  });

  it("aborts before writing when bootout fails unexpectedly (reinstall on a broken load)", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { runner } = fakeRunner([{ match: (cmd) => cmd[1] === "bootout", stderr: "permission denied" }]);
    await expect(installTunnel(config, { homeDir: home, runner, uid: 501 })).rejects.toMatchObject({
      code: "bootout_failed",
    });
    expect(existsSync(join(home, "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME))).toBe(false);
  });

  it("--dry-run writes nothing and never calls launchctl", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { calls, runner } = fakeRunner();
    const result = await installTunnel(config, { homeDir: home, runner, uid: 501, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(calls).toEqual([]);
    expect(existsSync(join(home, "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME))).toBe(false);
    expect(existsSync(join(config.dataDir, "logs"))).toBe(false);
  });

  it("bootstrap failure surfaces a typed error", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { runner } = fakeRunner([{ match: (cmd) => cmd[1] === "bootstrap", stderr: "Bootstrap failed: 5" }]);
    await expect(installTunnel(config, { homeDir: home, runner, uid: 501 })).rejects.toMatchObject({
      code: "bootstrap_failed",
    });
  });

  it("refuses a plist dir override outside ~/Library/LaunchAgents", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { runner } = fakeRunner();
    await expect(
      installTunnel(config, { homeDir: home, runner, uid: 501, plistDirOverride: "/Library/LaunchDaemons" }),
    ).rejects.toMatchObject({ code: "PLIST_TARGET_OUTSIDE_LAUNCHAGENTS" });
  });

  it("--skip-preflight bypasses a failing gate and still bootstraps", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { calls, runner } = fakeRunner();
    const failingGate = () => [{ name: "tunnel-config-exists", passed: false, detail: "missing" }];
    const logs: string[] = [];
    await installTunnel(config, {
      homeDir: home,
      runner,
      uid: 501,
      preflight: failingGate,
      skipPreflight: true,
      log: (line) => logs.push(line),
    });
    expect(calls[1]).toEqual([
      "/bin/launchctl",
      "bootstrap",
      "gui/501",
      join(home, "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME),
    ]);
    expect(logs.join("\n")).toContain("--skip-preflight");
  });
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

describe("parseTunnelArgs", () => {
  it("parses value flags and booleans, rejects unknown args and missing values", () => {
    expect(parseTunnelArgs(["--cloudflared", "/usr/local/bin/cloudflared", "--dry-run"])).toEqual({
      cloudflared: "/usr/local/bin/cloudflared",
      dryRun: true,
    });
    expect(() => parseTunnelArgs(["--cloudflared"])).toThrow(InstallError);
    expect(() => parseTunnelArgs(["--nonsense"])).toThrow(InstallError);
  });
});

// ---------------------------------------------------------------------------
// Uninstaller: bootout + remove plist only
// ---------------------------------------------------------------------------

describe("uninstallTunnel", () => {
  it("bootouts by service target, removes only the plist, leaves config/credentials/logs intact", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    await installTunnel(config, { homeDir: home, runner: fakeRunner().runner, uid: 501 });

    const configYml = config.tunnelConfig;
    const credentials = join(home, ".cloudflared", "tunnel-credentials.json");
    const logFile = join(config.dataDir, "logs", "cloudflared.err.log");
    const { calls, runner } = fakeRunner();
    const result = await uninstallTunnel({ homeDir: home, runner, uid: 501 });
    expect(result.bootoutCommand).toEqual(["/bin/launchctl", "bootout", "gui/501", TUNNEL_PLIST_LABEL]);
    expect(calls).toEqual([result.bootoutCommand]);
    expect(existsSync(join(home, "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME))).toBe(false);
    expect(existsSync(configYml)).toBe(true);
    expect(existsSync(credentials)).toBe(true);
    expect(existsSync(logFile)).toBe(true);
  });

  it("tolerates bootout when the job is not loaded, and still removes the plist", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    await installTunnel(config, { homeDir: home, runner: fakeRunner().runner, uid: 501 });
    const { runner } = fakeRunner([
      { match: (cmd) => cmd[1] === "bootout", stderr: "Could not find service in domain for system" },
    ]);
    const result = await uninstallTunnel({ homeDir: home, runner, uid: 501 });
    expect(result.removed.length).toBe(1);
    expect(existsSync(join(home, "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME))).toBe(false);
  });

  it("aborts without removing the plist on an unexpected bootout failure", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    await installTunnel(config, { homeDir: home, runner: fakeRunner().runner, uid: 501 });
    const { runner } = fakeRunner([{ match: (cmd) => cmd[1] === "bootout", stderr: "permission denied" }]);
    await expect(uninstallTunnel({ homeDir: home, runner, uid: 501 })).rejects.toMatchObject({ code: "bootout_failed" });
    expect(existsSync(join(home, "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME))).toBe(true);
  });

  it("dry-run removes nothing", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    await installTunnel(config, { homeDir: home, runner: fakeRunner().runner, uid: 501 });
    const { runner } = fakeRunner();
    await uninstallTunnel({ homeDir: home, runner, uid: 501, dryRun: true });
    expect(existsSync(join(home, "Library", "LaunchAgents", TUNNEL_PLIST_FILENAME))).toBe(true);
  });
});
