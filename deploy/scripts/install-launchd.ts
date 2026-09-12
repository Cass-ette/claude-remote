// Install the claude-remote Bridge as a per-user macOS LaunchAgent
// (implementation-plan Task 34; spec §5, §10.1, §10.6).
//
// What this script enforces (each invariant has a test in
// install-launchd.test.ts):
//
//   1. The rendered plist has NO Sockets/Listeners keys — launchd opens no
//      port; the Bridge binds 127.0.0.1 itself and remote access goes through
//      the externally managed Cloudflare Tunnel connector.
//   2. ProgramArguments uses the ABSOLUTE node path + the built bridge entry
//      (bridge/dist/src/main.js). launchd agents get no shell PATH.
//   3. Secrets (Cloudflare team domain / aud / public host) live ONLY in the
//      sibling env file (mode 0600) referenced via BRIDGE_ENV_FILE, which the
//      Bridge loads at boot (bridge/src/config.ts). The plist itself is
//      0644 and carries only non-secret env inline.
//   4. Only ever writes under ~/Library/LaunchAgents — never /Library/
//      LaunchDaemons (system-wide) and never as root.
//   5. `launchctl bootstrap gui/$UID` runs only after the preflight gate
//      passes (config validation + dist entry + executable node).
//
// KeepAlive is { SuccessfulExit = false }: launchd restarts the job unless
// the previous run exited 0. The Bridge exits 0 on graceful shutdown
// (SIGTERM handled per spec §11.5), so intentional stops stay stopped while
// crashes are restarted.
//
// Run: npx tsx deploy/scripts/install-launchd.ts --data-dir … [--dry-run]
// A `--skip-preflight` escape hatch exists for development only.

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { accessSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatEnvLine, parseEnvFile } from "./env-file.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLIST_LABEL = "dev.clauderemote.bridge";
export const PLIST_FILENAME = `${PLIST_LABEL}.plist`;
export const ENV_FILENAME = `${PLIST_LABEL}.env`;

/** Mirrors bridge/src/config.ts DEFAULT_BRIDGE_PORT (kept in sync by test). */
export const DEFAULT_BRIDGE_PORT = 43111;

const here = fileURLToPath(new URL(".", import.meta.url));
/** deploy/launchd/dev.clauderemote.bridge.plist.template */
export const TEMPLATE_PATH = resolve(here, "../launchd", `${PLIST_LABEL}.plist.template`);
/** Repo-root default for the bridge dist entry (deploy/scripts → repo root). */
export const DEFAULT_BRIDGE_MAIN = resolve(here, "../../bridge/dist/src/main.js");
/** Default data dir when --data-dir is not given. */
export const DEFAULT_DATA_DIR = () => join(homedir(), ".local", "share", "claude-remote");

// ---------------------------------------------------------------------------
// Errors and types
// ---------------------------------------------------------------------------

/** Typed installer failure; `code` is machine-readable for tests and CI. */
export class InstallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}

/** Raw installer input (CLI args / config file values). */
export interface InstallConfigInput {
  nodeBin: string;
  bridgeMain: string;
  dataDir: string;
  port?: number | undefined;
  cloudflareTeamDomain?: string | undefined;
  cloudflareAud?: string | undefined;
  publicHost?: string | undefined;
}

/** Validated, immutable installer config. */
export interface InstallConfig {
  readonly nodeBin: string;
  readonly bridgeMain: string;
  readonly dataDir: string;
  readonly port: number;
  /** The installer always pins the IPv4 loopback (spec §5). */
  readonly host: "127.0.0.1";
  readonly cloudflareTeamDomain?: string | undefined;
  readonly cloudflareAud?: string | undefined;
  readonly publicHost?: string | undefined;
}

/** Every filesystem path the installer touches, derived from home + dataDir. */
export interface ResolvedPaths {
  readonly homeDir: string;
  readonly plistPath: string;
  readonly envFilePath: string;
  readonly logsDir: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface PreflightCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable command runner so tests never invoke the real launchctl. */
export interface CommandRunner {
  run(command: string[]): Promise<CommandResult>;
}

export interface InstallOptions {
  /** Override $HOME-derived paths (tests use a tmp dir). */
  readonly homeDir?: string | undefined;
  /** Fake runner for tests; default spawns the real /bin/launchctl. */
  readonly runner?: CommandRunner | undefined;
  /** Override the uid used in `launchctl … gui/$UID` (tests pin 501). */
  readonly uid?: number | undefined;
  /** Plist directory override; MUST stay inside ~/Library/LaunchAgents. */
  readonly plistDirOverride?: string | undefined;
  /** Print the full plan without writing files or running launchctl. */
  readonly dryRun?: boolean | undefined;
  /** Development escape hatch: skip the preflight gate. */
  readonly skipPreflight?: boolean | undefined;
  /** Replace the built-in preflight (Task 36 wires the admin preflight). */
  readonly preflight?: ((config: InstallConfig, paths: ResolvedPaths) => PreflightCheck[]) | undefined;
  /** Progress sink (default: console.log; tests silence it). */
  readonly log?: ((line: string) => void) | undefined;
}

export interface InstallResult {
  readonly plistPath: string;
  readonly envFilePath: string;
  readonly dryRun: boolean;
  readonly bootstrapCommand: string[];
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

const TEAM_DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+cloudflareaccess\.com$/;

/**
 * Light normalization mirroring bridge/src/config.ts normalizeTeamDomain
 * (scheme prefix, trailing slash, case). The bridge re-validates at boot.
 */
function normalizeTeamDomain(raw: string): string {
  const stripped = raw.trim().replace(/^https:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (!TEAM_DOMAIN_PATTERN.test(stripped)) {
    throw new InstallError(
      "invalid_config",
      `cloudflareTeamDomain must look like "myteam.cloudflareaccess.com" (optional https:// prefix); got ${JSON.stringify(raw)}.`,
    );
  }
  return stripped;
}

/** Validate raw input into an {@link InstallConfig}. */
export function normalizeInstallConfig(input: InstallConfigInput): InstallConfig {
  for (const [key, value] of [
    ["nodeBin", input.nodeBin],
    ["bridgeMain", input.bridgeMain],
    ["dataDir", input.dataDir],
  ] as const) {
    if (!isAbsolute(value)) {
      throw new InstallError("invalid_config", `${key} must be an absolute path; got ${JSON.stringify(value)}.`);
    }
  }
  const port = input.port ?? DEFAULT_BRIDGE_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new InstallError("invalid_config", `port must be an integer between 1024 and 65535; got ${JSON.stringify(input.port)}.`);
  }
  const config: InstallConfig = {
    nodeBin: resolve(input.nodeBin),
    bridgeMain: resolve(input.bridgeMain),
    dataDir: resolve(input.dataDir),
    port,
    host: "127.0.0.1",
    ...(input.cloudflareTeamDomain !== undefined ? { cloudflareTeamDomain: normalizeTeamDomain(input.cloudflareTeamDomain) } : {}),
    ...(input.cloudflareAud !== undefined ? { cloudflareAud: input.cloudflareAud.trim() } : {}),
    ...(input.publicHost !== undefined ? { publicHost: input.publicHost.trim() } : {}),
  };
  return config;
}

// ---------------------------------------------------------------------------
// Path resolution (assertion 4: LaunchAgents only, never LaunchDaemons)
// ---------------------------------------------------------------------------

/**
 * Resolve the plist destination. With no override this is always
 * `<homeDir>/Library/LaunchAgents/dev.clauderemote.bridge.plist`; an override
 * (directory or full .plist path) is accepted only if the final path stays
 * strictly inside `<homeDir>/Library/LaunchAgents`. `/Library/LaunchDaemons`
 * and any other location throw `PLIST_TARGET_OUTSIDE_LAUNCHAGENTS`.
 */
export function resolvePlistTarget(homeDir: string, override?: string): string {
  const launchAgentsDir = resolve(homeDir, "Library", "LaunchAgents");
  const target = resolve(
    override === undefined
      ? join(launchAgentsDir, PLIST_FILENAME)
      : override.endsWith(".plist")
        ? override
        : join(override, PLIST_FILENAME),
  );
  if (target.startsWith(`/Library${sep}LaunchDaemons`)) {
    throw new InstallError(
      "PLIST_TARGET_OUTSIDE_LAUNCHAGENTS",
      `refusing system-wide plist at ${target}: the Bridge is a per-user agent and must never run as root. Use ~/Library/LaunchAgents.`,
    );
  }
  if (target !== launchAgentsDir && !target.startsWith(launchAgentsDir + sep)) {
    throw new InstallError(
      "PLIST_TARGET_OUTSIDE_LAUNCHAGENTS",
      `plist path ${target} is outside ${launchAgentsDir}; the installer only writes under ~/Library/LaunchAgents.`,
    );
  }
  return target;
}

/** Derive every path the installer writes from homeDir + dataDir. */
export function resolvePaths(input: { homeDir: string; dataDir: string; plistDirOverride?: string | undefined }): ResolvedPaths {
  const plistPath = resolvePlistTarget(input.homeDir, input.plistDirOverride);
  const logsDir = join(input.dataDir, "logs");
  return {
    homeDir: input.homeDir,
    plistPath,
    envFilePath: join(dirname(plistPath), ENV_FILENAME),
    logsDir,
    stdoutPath: join(logsDir, "bridge.out.log"),
    stderrPath: join(logsDir, "bridge.err.log"),
  };
}

// ---------------------------------------------------------------------------
// Rendering (pure; assertions 1-3)
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Substitute {{PLACEHOLDER}} tokens in the plist template. All substituted
 * values are XML-escaped; the fixed `127.0.0.1` host is template-baked.
 */
export function renderPlist(config: InstallConfig, paths: ResolvedPaths): string {
  const values: Record<string, string> = {
    ENV_FILENAME,
    LABEL: PLIST_LABEL,
    NODE_BIN: escapeXml(config.nodeBin),
    BRIDGE_MAIN: escapeXml(config.bridgeMain),
    BRIDGE_DATA_DIR: escapeXml(config.dataDir),
    BRIDGE_PORT: String(config.port),
    BRIDGE_ENV_FILE: escapeXml(paths.envFilePath),
    STDOUT_PATH: escapeXml(paths.stdoutPath),
    STDERR_PATH: escapeXml(paths.stderrPath),
  };
  return readFileSync(TEMPLATE_PATH, "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) =>
    name in values ? values[name] ?? whole : whole,
  );
}

/**
 * Render the 0600 env file that carries the Cloudflare secrets. Only optional
 * remote-access knobs are written; everything the plist already passes inline
 * (host/port/data dir) is deliberately absent.
 */
export function renderEnvFile(config: InstallConfig): string {
  const lines = [
    "# Generated by claude-remote install-launchd — mode 0600, owner-only.",
    "# Loaded by the Bridge at boot via BRIDGE_ENV_FILE (bridge/src/config.ts).",
  ];
  if (config.cloudflareTeamDomain !== undefined) {
    lines.push(formatEnvLine("BRIDGE_CLOUDFLARE_TEAM_DOMAIN", config.cloudflareTeamDomain));
  }
  if (config.cloudflareAud !== undefined) {
    lines.push(formatEnvLine("BRIDGE_CLOUDFLARE_AUD", config.cloudflareAud));
  }
  if (config.publicHost !== undefined) {
    lines.push(formatEnvLine("BRIDGE_PUBLIC_HOST", config.publicHost));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Preflight gate (assertion 5)
// ---------------------------------------------------------------------------

/**
 * Pre-install gate on what exists today: validated config, built bridge dist
 * entry, executable absolute node. Cloudflare team domain + aud must be
 * both-set or both-unset (the bridge fails remote-access startup otherwise).
 *
 * TODO(Task 36): replace with the bridge admin preflight
 * (deploy/scripts/preflight.ts wired into bridge/src/admin/cli.ts), which
 * additionally checks JWKS reachability, data-dir mode/ownership, cloudflared,
 * and the loopback health endpoint. The installer keeps `--skip-preflight`
 * as the documented development escape hatch either way.
 */
export function runInstallerPreflight(config: InstallConfig, _paths: ResolvedPaths): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  let nodeOk = isAbsolute(config.nodeBin);
  if (nodeOk) {
    try {
      accessSync(config.nodeBin, fsConstants.X_OK);
    } catch {
      nodeOk = false;
    }
  }
  checks.push({
    name: "node-bin-absolute-executable",
    passed: nodeOk,
    detail: nodeOk ? config.nodeBin : `${config.nodeBin} is not an absolute, executable node binary`,
  });

  let mainOk = isAbsolute(config.bridgeMain);
  if (mainOk) {
    try {
      mainOk = statSync(config.bridgeMain).isFile();
    } catch {
      mainOk = false;
    }
  }
  checks.push({
    name: "bridge-dist-entry-exists",
    passed: mainOk,
    detail: mainOk ? config.bridgeMain : `${config.bridgeMain} does not exist — build the bridge first (npm run build -w @claude-remote/bridge)`,
  });

  const portOk = Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535;
  checks.push({
    name: "port-valid",
    passed: portOk,
    detail: portOk ? String(config.port) : `port ${String(config.port)} is not an integer in [1024, 65535]`,
  });

  const hasTeam = config.cloudflareTeamDomain !== undefined;
  const hasAud = config.cloudflareAud !== undefined;
  const pairOk = hasTeam === hasAud;
  checks.push({
    name: "cloudflare-pair-complete",
    passed: pairOk,
    detail: pairOk
      ? hasTeam
        ? "team domain + aud configured (secrets stay in the 0600 env file)"
        : "local-only: no Cloudflare Access pair configured"
      : "BRIDGE_CLOUDFLARE_TEAM_DOMAIN and BRIDGE_CLOUDFLARE_AUD must be set together or left unset",
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Runner + install orchestration
// ---------------------------------------------------------------------------

/** Real runner: absolute /bin/launchctl, never resolved from PATH. */
export function createRealRunner(): CommandRunner {
  return {
    run: (command) =>
      new Promise<CommandResult>((resolveRun) => {
        const bin = command[0];
        if (bin === undefined || bin === "") {
          resolveRun({ code: 1, stdout: "", stderr: "internal error: empty command" });
          return;
        }
        const child = spawn(bin, command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => (stdout += String(chunk)));
        child.stderr?.on("data", (chunk: Buffer) => (stderr += String(chunk)));
        child.on("error", (err: Error) => resolveRun({ code: 1, stdout, stderr: `${stderr}${String(err)}` }));
        child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
      }),
  };
}

function requireUid(override?: number): number {
  const uid = override ?? process.getuid?.() ?? -1;
  if (!Number.isInteger(uid) || uid < 0) {
    throw new InstallError("no_uid", "cannot determine the current uid for launchctl gui/$UID targets.");
  }
  return uid;
}

/**
 * Render, write, and bootstrap the LaunchAgent. Writes happen only after the
 * preflight gate passes; `launchctl bootstrap gui/$UID <plist>` is the last
 * step so a failed bootstrap leaves inspectable files but no half-written
 * state from a skipped gate.
 */
export async function install(config: InstallConfig, options: InstallOptions = {}): Promise<InstallResult> {
  const homeDir = options.homeDir ?? homedir();
  const paths = resolvePaths({ homeDir, dataDir: config.dataDir, plistDirOverride: options.plistDirOverride });
  const log = options.log ?? (() => {});
  const uid = requireUid(options.uid);
  const bootstrapCommand = ["/bin/launchctl", "bootstrap", `gui/${uid}`, paths.plistPath];

  if (options.skipPreflight === true) {
    log("WARNING: --skip-preflight — running without the preflight gate (development only).");
  } else {
    const preflight = options.preflight ?? runInstallerPreflight;
    const failed = preflight(config, paths).filter((check) => !check.passed);
    if (failed.length > 0) {
      throw new InstallError(
        "preflight_failed",
        `preflight failed:\n${failed.map((check) => `  - ${check.name}: ${check.detail}`).join("\n")}`,
      );
    }
  }

  const plistXml = renderPlist(config, paths);
  const envContent = renderEnvFile(config);

  if (options.dryRun === true) {
    log(`[dry-run] plist (0644):        ${paths.plistPath}`);
    log(`[dry-run] env file (0600):     ${paths.envFilePath}`);
    log(`[dry-run] logs dir (0700):     ${paths.logsDir}`);
    log(`[dry-run] would run:           ${bootstrapCommand.join(" ")}`);
    log(`[dry-run] rendered plist:\n${plistXml}`);
    log(`[dry-run] rendered env file:\n${envContent}`);
    return { plistPath: paths.plistPath, envFilePath: paths.envFilePath, dryRun: true, bootstrapCommand };
  }

  mkdirSync(dirname(paths.plistPath), { recursive: true });
  // The Bridge data dir is owner-only (0700), matching bridge/src/config.ts.
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.logsDir, 0o700);

  // Secrets first (0600), then the world-readable-ish plist (0644).
  writeFileSync(paths.envFilePath, envContent, { mode: 0o600 });
  chmodSync(paths.envFilePath, 0o600);
  writeFileSync(paths.plistPath, plistXml, { mode: 0o644 });
  chmodSync(paths.plistPath, 0o644);
  // Pre-create the launchd-owned log files so they cannot appear with a
  // umask-dependent mode.
  for (const logFile of [paths.stdoutPath, paths.stderrPath]) {
    if (!existsSync(logFile)) writeFileSync(logFile, "", { mode: 0o600 });
    chmodSync(logFile, 0o600);
  }

  const runner = options.runner ?? createRealRunner();
  const bootstrap = await runner.run(bootstrapCommand);
  if (bootstrap.code !== 0) {
    throw new InstallError(
      "bootstrap_failed",
      `launchctl bootstrap exited ${bootstrap.code}: ${bootstrap.stderr || bootstrap.stdout || "(no output)"}\n` +
        `files were written; inspect with \`launchctl print gui/${uid}/${PLIST_LABEL}\` or run the uninstaller.`,
    );
  }
  log(`installed ${PLIST_LABEL}: ${paths.plistPath}`);
  log(`bootstrapped: ${bootstrapCommand.join(" ")}`);
  return { plistPath: paths.plistPath, envFilePath: paths.envFilePath, dryRun: false, bootstrapCommand };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: tsx deploy/scripts/install-launchd.ts [options]

Installs the claude-remote Bridge as a per-user LaunchAgent under
~/Library/LaunchAgents (${PLIST_FILENAME}) plus a 0600 env file
(${ENV_FILENAME}) holding the Cloudflare Access secrets. Never writes to
/Library/LaunchDaemons and never runs the Bridge as root.

options:
  --data-dir <path>       absolute Bridge data dir (BRIDGE_DATA_DIR)
  --bridge-main <path>    built entry, default ${DEFAULT_BRIDGE_MAIN}
  --node <path>           absolute node binary, default the running node
  --port <n>              BRIDGE_PORT, default ${DEFAULT_BRIDGE_PORT}
  --team-domain <domain>  BRIDGE_CLOUDFLARE_TEAM_DOMAIN (into the env file)
  --aud <tag>             BRIDGE_CLOUDFLARE_AUD (into the env file)
  --public-host <host>    BRIDGE_PUBLIC_HOST (into the env file)
  --config <path>         env-style file providing any of the above keys
                          (BRIDGE_DATA_DIR, BRIDGE_MAIN, BRIDGE_NODE_BIN,
                          BRIDGE_PORT, BRIDGE_CLOUDFLARE_TEAM_DOMAIN,
                          BRIDGE_CLOUDFLARE_AUD, BRIDGE_PUBLIC_HOST);
                          explicit flags win over file values
  --dry-run               print the rendered plist/env and plan, write nothing
  --skip-preflight        (development only) skip the preflight gate
  --home-dir <path>       override $HOME (testing)
  --plist-dir <path>      override the plist directory; must stay inside
                          ~/Library/LaunchAgents
  -h, --help              show this help
`;

interface CliArgs {
  config?: string;
  node?: string;
  bridgeMain?: string;
  dataDir?: string;
  port?: number;
  teamDomain?: string;
  aud?: string;
  publicHost?: string;
  homeDir?: string;
  plistDir?: string;
  dryRun?: boolean;
  skipPreflight?: boolean;
  help?: boolean;
}

/** Parse `--key value` / boolean flags; unknown input is a typed usage error. */
export function parseArgs(argv: string[]): CliArgs {
  const valueFlags = new Set([
    "--config",
    "--node",
    "--bridge-main",
    "--data-dir",
    "--port",
    "--team-domain",
    "--aud",
    "--public-host",
    "--home-dir",
    "--plist-dir",
  ]);
  const boolFlags = new Set(["--dry-run", "--skip-preflight", "-h", "--help"]);
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (boolFlags.has(arg)) {
      if (arg === "-h" || arg === "--help") args.help = true;
      else if (arg === "--dry-run") args.dryRun = true;
      else args.skipPreflight = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new InstallError("usage", `${arg} requires a value.`);
      }
      i += 1;
      const key = arg.slice(2);
      switch (key) {
        case "config":
          args.config = value;
          break;
        case "node":
          args.node = value;
          break;
        case "bridge-main":
          args.bridgeMain = value;
          break;
        case "data-dir":
          args.dataDir = value;
          break;
        case "port":
          args.port = Number(value);
          break;
        case "team-domain":
          args.teamDomain = value;
          break;
        case "aud":
          args.aud = value;
          break;
        case "public-host":
          args.publicHost = value;
          break;
        case "home-dir":
          args.homeDir = value;
          break;
        case "plist-dir":
          args.plistDir = value;
          break;
      }
      continue;
    }
    throw new InstallError("usage", `unknown argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
  }
  return args;
}

/** CLI entry: config file → flags → normalize → install. Returns exit code. */
export async function cliMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const file: Record<string, string> =
    args.config !== undefined ? parseEnvFile(readFileSync(args.config, "utf8")) : {};
  const teamDomain = args.teamDomain ?? file["BRIDGE_CLOUDFLARE_TEAM_DOMAIN"];
  const aud = args.aud ?? file["BRIDGE_CLOUDFLARE_AUD"];
  const publicHost = args.publicHost ?? file["BRIDGE_PUBLIC_HOST"];
  const port = args.port ?? (file["BRIDGE_PORT"] !== undefined ? Number(file["BRIDGE_PORT"]) : undefined);

  const config = normalizeInstallConfig({
    nodeBin: args.node ?? file["BRIDGE_NODE_BIN"] ?? process.execPath,
    bridgeMain: args.bridgeMain ?? file["BRIDGE_MAIN"] ?? DEFAULT_BRIDGE_MAIN,
    dataDir: args.dataDir ?? file["BRIDGE_DATA_DIR"] ?? DEFAULT_DATA_DIR(),
    ...(port !== undefined ? { port } : {}),
    ...(teamDomain !== undefined ? { cloudflareTeamDomain: teamDomain } : {}),
    ...(aud !== undefined ? { cloudflareAud: aud } : {}),
    ...(publicHost !== undefined ? { publicHost } : {}),
  });

  await install(config, {
    ...(args.homeDir !== undefined ? { homeDir: args.homeDir } : {}),
    ...(args.plistDir !== undefined ? { plistDirOverride: args.plistDir } : {}),
    ...(args.dryRun === true ? { dryRun: true } : {}),
    ...(args.skipPreflight === true ? { skipPreflight: true } : {}),
    log: (line) => console.log(line),
  });
  return 0;
}

// Execute only when run directly (tsx deploy/scripts/install-launchd.ts);
// imports from tests must not trigger the CLI.
const invokedAsMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  cliMain(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof InstallError ? error.code : "unexpected_error";
    console.error(`error (${code}): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
