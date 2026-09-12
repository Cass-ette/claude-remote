import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_FILENAME,
  InstallError,
  PLIST_FILENAME,
  TEMPLATE_PATH,
  type CommandRunner,
  install,
  normalizeInstallConfig,
  renderEnvFile,
  renderPlist,
  resolvePaths,
  resolvePlistTarget,
  runInstallerPreflight,
  type InstallConfig,
} from "./install-launchd.js";
import { uninstall } from "./uninstall-launchd.js";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];
afterEach(() => {
  // Best-effort cleanup; tmp dirs are fine to leave behind on macOS.
  for (const dir of scratchDirs.splice(0)) {
    import("node:fs").then((fs) => fs.rmSync(dir, { recursive: true, force: true }));
  }
});

function scratchHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "launchd-install-test-"));
  scratchDirs.push(dir);
  return dir;
}

/** Minimal valid install config pointing at fixture files under `home`. */
function fixtureConfig(home: string): InstallConfig {
  const nodeBin = join(home, "bin", "node");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(nodeBin, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(nodeBin, 0o755);

  const bridgeMain = join(home, "repo", "bridge", "dist", "src", "main.js");
  mkdirSync(join(home, "repo", "bridge", "dist", "src"), { recursive: true });
  writeFileSync(bridgeMain, "// dist entry\n");

  const dataDir = join(home, "Library", "Application Support", "claude-remote");
  return normalizeInstallConfig({
    nodeBin,
    bridgeMain,
    dataDir,
    port: 43111,
    cloudflareTeamDomain: "myteam.cloudflareaccess.com",
    cloudflareAud: "0e9a5b2f7dbf4e1b9a17d8e0c3f2a1b0",
    publicHost: "bridge.example.com",
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

function fakeRunner(failures: Array<{ match: (cmd: string[]) => boolean; stderr: string }> = []): FakeRunner {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command) {
      calls.push(command);
      for (const failure of failures) {
        if (failure.match(command)) return { code: 1, stdout: "", stderr: failure.stderr };
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
// Spec §5 / §10.1 / §10.6 — assertion 1: launchd must not open ports itself
// ---------------------------------------------------------------------------

describe("rendered launchd plist", () => {
  const home = "/Users/tester";
  const config = normalizeInstallConfig({
    nodeBin: "/usr/local/bin/node",
    bridgeMain: "/Users/tester/repo/bridge/dist/src/main.js",
    dataDir: "/Users/tester/Library/Application Support/claude-remote",
    port: 43111,
    cloudflareTeamDomain: "myteam.cloudflareaccess.com",
    cloudflareAud: "0e9a5b2f7dbf4e1b9a17d8e0c3f2a1b0",
  });
  const paths = resolvePaths({ homeDir: home, dataDir: config.dataDir });
  const plist = renderPlist(config, paths);

  it("template and rendering omit Sockets and Listeners (launchd opens no port)", async () => {
    const template = await readFile(TEMPLATE_PATH, "utf8");
    expect(plistKeys(template)).not.toContain("Sockets");
    expect(plistKeys(template)).not.toContain("Listeners");
    expect(plistKeys(plist)).not.toContain("Sockets");
    expect(plistKeys(plist)).not.toContain("Listeners");
    expect(plist).not.toMatch(/<key>Sockets<\/key>/);
    expect(plist).not.toMatch(/<key>Listeners<\/key>/);
  });

  it("points ProgramArguments at the absolute node and bridge dist entry", () => {
    const args = [...plist.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g)]
      .flatMap((m) => [...(m[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)])
      .map((m) => m[1] ?? "");
    expect(args).toEqual([config.nodeBin, config.bridgeMain]);
    expect(config.nodeBin).toBe("/usr/local/bin/node");
    expect(config.bridgeMain).toBe("/Users/tester/repo/bridge/dist/src/main.js");
  });

  it("passes non-secret env inline and secrets via BRIDGE_ENV_FILE only", () => {
    const env = plistStrings(plist);
    expect(env.get("BRIDGE_DATA_DIR")).toBe(config.dataDir);
    expect(env.get("BRIDGE_HOST")).toBe("127.0.0.1");
    expect(env.get("BRIDGE_PORT")).toBe("43111");
    expect(env.get("BRIDGE_ENV_FILE")).toBe(join(home, "Library", "LaunchAgents", ENV_FILENAME));
    // Secrets must never be inline in the (0644) plist.
    expect(plist).not.toContain("myteam.cloudflareaccess.com");
    expect(plist).not.toContain("0e9a5b2f7dbf4e1b9a17d8e0c3f2a1b0");
  });

  it("writes StandardOutPath/StandardErrorPath inside BRIDGE_DATA_DIR/logs", () => {
    const env = plistStrings(plist);
    const logsDir = join(config.dataDir, "logs");
    expect(env.get("StandardOutPath")).toBe(join(logsDir, "bridge.out.log"));
    expect(env.get("StandardErrorPath")).toBe(join(logsDir, "bridge.err.log"));
  });

  it("restarts on nonzero exit only (SuccessfulExit=false matches exit-0 graceful shutdown)", () => {
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  it("XML-escapes substituted values", () => {
    const weird = normalizeInstallConfig({
      nodeBin: "/usr/local/bin/node",
      bridgeMain: "/Users/t&e<s>t/repo/bridge/dist/src/main.js",
      dataDir: "/Users/t&e<s>t/data",
      port: 43111,
    });
    const weirdPaths = resolvePaths({ homeDir: "/Users/t&e<s>t", dataDir: weird.dataDir });
    const xml = renderPlist(weird, weirdPaths);
    for (const m of xml.matchAll(/<string>([^<]*)<\/string>/g)) {
      const value = m[1] ?? "";
      expect(value).not.toMatch(/</); // raw < would break the XML
      expect(value).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/); // raw unescaped &
    }
    expect(xml).toContain("&amp;");
  });
});

// ---------------------------------------------------------------------------
// Assertion 2 — the 0600 env file carries the Cloudflare secrets
// ---------------------------------------------------------------------------

describe("renderEnvFile", () => {
  it("carries Cloudflare vars, not the plist-only ones", () => {
    const home = "/Users/tester";
    const config = normalizeInstallConfig({
      nodeBin: "/usr/local/bin/node",
      bridgeMain: "/Users/tester/repo/bridge/dist/src/main.js",
      dataDir: "/Users/tester/data",
      port: 43111,
      cloudflareTeamDomain: "myteam.cloudflareaccess.com",
      cloudflareAud: "0e9a5b2f7dbf4e1b9a17d8e0c3f2a1b0",
      publicHost: "bridge.example.com",
    });
    const content = renderEnvFile(config);
    expect(content).toContain("BRIDGE_CLOUDFLARE_TEAM_DOMAIN=\"myteam.cloudflareaccess.com\"");
    expect(content).toContain("BRIDGE_CLOUDFLARE_AUD=\"0e9a5b2f7dbf4e1b9a17d8e0c3f2a1b0\"");
    expect(content).toContain("BRIDGE_PUBLIC_HOST=\"bridge.example.com\"");
    expect(content).not.toContain("BRIDGE_HOST");
    expect(content).not.toContain("BRIDGE_PORT");
    expect(content).not.toContain("BRIDGE_DATA_DIR");
  });

  it("omits unset optional vars entirely", () => {
    const config = normalizeInstallConfig({
      nodeBin: "/usr/local/bin/node",
      bridgeMain: "/x/bridge/dist/src/main.js",
      dataDir: "/x/data",
      port: 43111,
    });
    const content = renderEnvFile(config);
    expect(content).not.toContain("BRIDGE_CLOUDFLARE_TEAM_DOMAIN");
    expect(content).not.toContain("BRIDGE_CLOUDFLARE_AUD");
    expect(content).not.toContain("BRIDGE_PUBLIC_HOST");
  });
});

// ---------------------------------------------------------------------------
// Assertion 4 — only ever write under ~/Library/LaunchAgents
// ---------------------------------------------------------------------------

describe("resolvePlistTarget", () => {
  it("defaults to ~/Library/LaunchAgents/dev.clauderemote.bridge.plist", () => {
    expect(resolvePlistTarget("/Users/tester")).toBe(
      join("/Users/tester", "Library", "LaunchAgents", PLIST_FILENAME),
    );
  });

  it("refuses /Library/LaunchDaemons and any path outside ~/Library/LaunchAgents", () => {
    for (const bad of [
      "/Library/LaunchDaemons/dev.clauderemote.bridge.plist",
      "/Library/LaunchAgents/dev.clauderemote.bridge.plist",
      "/Users/tester/Elsewhere/dev.clauderemote.bridge.plist",
      "/Users/other/Library/LaunchAgents/dev.clauderemote.bridge.plist",
    ]) {
      expect(() => resolvePlistTarget("/Users/tester", bad)).toThrow(InstallError);
      try {
        resolvePlistTarget("/Users/tester", bad);
      } catch (error) {
        expect((error as InstallError).code).toBe("PLIST_TARGET_OUTSIDE_LAUNCHAGENTS");
        expect((error as InstallError).message).toMatch(/LaunchAgents/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Preflight (pre-Task-36 gate): config validation + dist entry + node
// ---------------------------------------------------------------------------

describe("runInstallerPreflight", () => {
  it("passes for a complete, file-backed config", () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const paths = resolvePaths({ homeDir: home, dataDir: config.dataDir });
    const checks = runInstallerPreflight(config, paths);
    expect(checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["node-bin-absolute-executable", "bridge-dist-entry-exists", "port-valid", "cloudflare-pair-complete"]),
    );
    for (const check of checks) expect({ name: check.name, passed: check.passed, detail: check.detail }).toEqual(
      expect.objectContaining({ passed: true }),
    );
  });

  it("fails when the dist entry or executable node is missing and the Cloudflare pair is half-set", () => {
    const home = scratchHome();
    const config = normalizeInstallConfig({
      nodeBin: join(home, "missing-node"),
      bridgeMain: join(home, "missing-dist", "src", "main.js"),
      dataDir: join(home, "data"),
      port: 43111,
      cloudflareTeamDomain: "myteam.cloudflareaccess.com",
    });
    const paths = resolvePaths({ homeDir: home, dataDir: config.dataDir });
    const byName = new Map(runInstallerPreflight(config, paths).map((c) => [c.name, c]));
    expect(byName.get("node-bin-absolute-executable")?.passed).toBe(false);
    expect(byName.get("bridge-dist-entry-exists")?.passed).toBe(false);
    expect(byName.get("cloudflare-pair-complete")?.passed).toBe(false);
  });

  it("normalizeInstallConfig rejects malformed input up-front", () => {
    const base = { nodeBin: "/usr/local/bin/node", bridgeMain: "/x/bridge/dist/src/main.js", dataDir: "/x/data" };
    expect(() => normalizeInstallConfig({ ...base, port: 80 })).toThrow(InstallError);
    expect(() => normalizeInstallConfig({ ...base, port: 70000 })).toThrow(InstallError);
    expect(() => normalizeInstallConfig({ ...base, nodeBin: "node" })).toThrow(InstallError);
    expect(() => normalizeInstallConfig({ ...base, bridgeMain: "bridge/dist/src/main.js" })).toThrow(InstallError);
    expect(() => normalizeInstallConfig({ ...base, dataDir: "relative/data" })).toThrow(InstallError);
    expect(() => normalizeInstallConfig({ ...base, cloudflareTeamDomain: "not a domain" })).toThrow(InstallError);
    // Scheme prefix is normalized away like the bridge's own config layer.
    expect(
      normalizeInstallConfig({ ...base, cloudflareTeamDomain: "https://MyTeam.cloudflareaccess.com/" })
        .cloudflareTeamDomain,
    ).toBe("myteam.cloudflareaccess.com");
  });
});

// ---------------------------------------------------------------------------
// Assertions 2/3/5 — install orchestration with a fake launchctl runner
// ---------------------------------------------------------------------------

describe("install", () => {
  it("refuses to bootstrap when preflight fails (assertion 5)", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { calls, runner } = fakeRunner();
    await expect(
      install(config, {
        homeDir: home,
        runner,
        uid: 501,
        preflight: () => [{ name: "cloudflare-pair-complete", passed: false, detail: "team domain without aud" }],
      }),
    ).rejects.toMatchObject({ code: "preflight_failed" });
    expect(calls).toEqual([]);
    expect(existsSync(join(home, "Library", "LaunchAgents", PLIST_FILENAME))).toBe(false);
  });

  it("writes plist 0644 + env 0600 + logs 0600, then bootstraps gui/$UID (assertions 2+3)", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { calls, runner } = fakeRunner();
    const result = await install(config, { homeDir: home, runner, uid: 501 });

    const launchAgents = join(home, "Library", "LaunchAgents");
    const plistPath = join(launchAgents, PLIST_FILENAME);
    const envPath = join(launchAgents, ENV_FILENAME);
    expect(result.plistPath).toBe(plistPath);
    expect(result.envFilePath).toBe(envPath);
    expect(modeOf(plistPath)).toBe(0o644);
    expect(modeOf(envPath)).toBe(0o600);
    expect(modeOf(join(config.dataDir, "logs", "bridge.out.log"))).toBe(0o600);
    expect(modeOf(join(config.dataDir, "logs", "bridge.err.log"))).toBe(0o600);

    expect(calls).toEqual([["/bin/launchctl", "bootstrap", "gui/501", plistPath]]);
  });

  it("--dry-run writes nothing and never calls launchctl", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { calls, runner } = fakeRunner();
    const result = await install(config, { homeDir: home, runner, uid: 501, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(calls).toEqual([]);
    expect(existsSync(join(home, "Library", "LaunchAgents", PLIST_FILENAME))).toBe(false);
    expect(existsSync(join(config.dataDir, "logs"))).toBe(false);
  });

  it("bootstrap failure surfaces a typed error", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { runner } = fakeRunner([{ match: (cmd) => cmd[1] === "bootstrap", stderr: "Bootstrap failed: 5" }]);
    await expect(install(config, { homeDir: home, runner, uid: 501 })).rejects.toMatchObject({
      code: "bootstrap_failed",
    });
  });

  it("refuses a plist dir override outside ~/Library/LaunchAgents", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    const { runner } = fakeRunner();
    await expect(
      install(config, { homeDir: home, runner, uid: 501, plistDirOverride: "/Library/LaunchDaemons" }),
    ).rejects.toMatchObject({ code: "PLIST_TARGET_OUTSIDE_LAUNCHAGENTS" });
  });
});

// ---------------------------------------------------------------------------
// Uninstaller: bootout + remove files, data stays intact
// ---------------------------------------------------------------------------

describe("uninstall", () => {
  it("bootouts by service target, removes plist and env, leaves data intact", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    await install(config, { homeDir: home, runner: fakeRunner().runner, uid: 501 });

    const dataFile = join(config.dataDir, "bridge.db");
    writeFileSync(dataFile, "data");
    const { calls, runner } = fakeRunner();
    const result = await uninstall({ homeDir: home, runner, uid: 501 });
    expect(result.bootoutCommand).toEqual(["/bin/launchctl", "bootout", "gui/501", "dev.clauderemote.bridge"]);
    expect(calls).toEqual([result.bootoutCommand]);
    expect(existsSync(join(home, "Library", "LaunchAgents", PLIST_FILENAME))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", ENV_FILENAME))).toBe(false);
    expect(existsSync(dataFile)).toBe(true);
  });

  it("tolerates bootout when the job is not loaded, and still removes files", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    await install(config, { homeDir: home, runner: fakeRunner().runner, uid: 501 });
    const { runner } = fakeRunner([
      { match: (cmd) => cmd[1] === "bootout", stderr: "Could not find service \"dev.clauderemote.bridge\" in domain for system" },
    ]);
    const result = await uninstall({ homeDir: home, runner, uid: 501 });
    expect(result.removed.length).toBeGreaterThan(0);
    expect(existsSync(join(home, "Library", "LaunchAgents", PLIST_FILENAME))).toBe(false);
  });

  it("aborts without removing files on an unexpected bootout failure", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    await install(config, { homeDir: home, runner: fakeRunner().runner, uid: 501 });
    const { runner } = fakeRunner([{ match: (cmd) => cmd[1] === "bootout", stderr: "permission denied" }]);
    await expect(uninstall({ homeDir: home, runner, uid: 501 })).rejects.toMatchObject({ code: "bootout_failed" });
    expect(existsSync(join(home, "Library", "LaunchAgents", PLIST_FILENAME))).toBe(true);
  });

  it("dry-run removes nothing", async () => {
    const home = scratchHome();
    const config = fixtureConfig(home);
    await install(config, { homeDir: home, runner: fakeRunner().runner, uid: 501 });
    const { runner } = fakeRunner();
    await uninstall({ homeDir: home, runner, uid: 501, dryRun: true });
    expect(existsSync(join(home, "Library", "LaunchAgents", PLIST_FILENAME))).toBe(true);
  });
});
