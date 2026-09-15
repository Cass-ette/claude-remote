// Install the claude-remote Cloudflare Tunnel connector as a per-user macOS
// LaunchAgent (spec §5, §10.2; docs/operations/deploy.md step 5).
//
// deploy.md deliberately keeps the tunnel connector OUT of the Bridge plist,
// but "long-term run mode is the operator's choice" left the connector as a
// shell child that dies with the terminal. This script closes that gap the
// same way install-launchd.ts does for the Bridge:
//
//   1. The rendered plist opens NO local port — cloudflared only makes
//      outbound connections to Cloudflare and forwards to the loopback
//      Bridge listener named inside the tunnel config.
//   2. ProgramArguments uses the ABSOLUTE cloudflared path + the rendered
//      config (deploy/scripts/render-cloudflared-config.ts output).
//   3. No secrets in the plist (0644): tunnel credentials stay in the
//      credentials-file named by the config, written 0600 by
//      `cloudflared tunnel create`.
//   4. Only ever writes under ~/Library/LaunchAgents — never /Library/
//      LaunchDaemons and never as root (that is what `cloudflared service
//      install` would do; this script exists so the user never needs it).
//   5. `launchctl bootstrap gui/$UID` runs only after the preflight gate
//      passes: executable cloudflared, existing config with a `tunnel:` +
//      `credentials-file:` pair, and a readable credentials file.
//
// Run: npx tsx deploy/scripts/install-tunnel-launchd.ts [--dry-run]
// A --skip-preflight escape hatch exists for development only.

import { constants as fsConstants } from "node:fs";
import { accessSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createRealRunner,
  InstallError,
  type CommandRunner,
  type PreflightCheck,
} from "./install-launchd.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TUNNEL_PLIST_LABEL = "dev.clauderemote.cloudflared";
export const TUNNEL_PLIST_FILENAME = `${TUNNEL_PLIST_LABEL}.plist`;

const here = fileURLToPath(new URL(".", import.meta.url));
/** deploy/launchd/dev.clauderemote.cloudflared.plist.template */
export const TUNNEL_TEMPLATE_PATH = resolve(here, "../launchd", `${TUNNEL_PLIST_LABEL}.plist.template`);
/** Default tunnel config (render-cloudflared-config.ts writes exactly this). */
export const DEFAULT_TUNNEL_CONFIG = () => join(homedir(), ".cloudflared", "config.yml");
/** Default data dir (log files) shared with the Bridge installer. */
export const DEFAULT_DATA_DIR = () => join(homedir(), ".local", "share", "claude-remote");
/** Homebrew install locations probed when --cloudflared is not given. */
export const DEFAULT_CLOUDFLARED_CANDIDATES = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Validated, immutable installer config. */
export interface TunnelInstallConfig {
  /** Absolute cloudflared binary. */
  readonly cloudflaredBin: string;
  /** Absolute tunnel config path (`cloudflared tunnel --config … run`). */
  readonly tunnelConfig: string;
  /** Absolute data dir; logs land in <dataDir>/logs. */
  readonly dataDir: string;
}

/** Every filesystem path the installer touches, derived from home + config. */
export interface TunnelResolvedPaths {
  readonly homeDir: string;
  readonly plistPath: string;
  readonly logsDir: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface TunnelInstallOptions {
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
  /** Replace the built-in preflight (tests inject fakes). */
  readonly preflight?:
  | ((config: TunnelInstallConfig, paths: TunnelResolvedPaths) => PreflightCheck[] | Promise<PreflightCheck[]>)
  | undefined;
  /** Progress sink (default: console.log; tests silence it). */
  readonly log?: ((line: string) => void) | undefined;
}

export interface TunnelInstallResult {
  readonly plistPath: string;
  readonly dryRun: boolean;
  readonly bootstrapCommand: string[];
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/** Validate raw input into a {@link TunnelInstallConfig}. */
export function normalizeTunnelInstallConfig(input: {
  cloudflaredBin: string;
  tunnelConfig: string;
  dataDir: string;
}): TunnelInstallConfig {
  for (const [key, value] of [
    ["cloudflaredBin", input.cloudflaredBin],
    ["tunnelConfig", input.tunnelConfig],
    ["dataDir", input.dataDir],
  ] as const) {
    if (!isAbsolute(value)) {
      throw new InstallError("invalid_config", `${key} must be an absolute path; got ${JSON.stringify(value)}.`);
    }
  }
  return {
    cloudflaredBin: resolve(input.cloudflaredBin),
    tunnelConfig: resolve(input.tunnelConfig),
    dataDir: resolve(input.dataDir),
  };
}

// ---------------------------------------------------------------------------
// Path resolution (LaunchAgents only, never LaunchDaemons)
// ---------------------------------------------------------------------------

/**
 * Resolve the plist destination: always
 * `<homeDir>/Library/LaunchAgents/dev.clauderemote.cloudflared.plist`; an
 * override is accepted only if the final path stays strictly inside
 * `<homeDir>/Library/LaunchAgents`. `/Library/LaunchDaemons` and any other
 * location throw `PLIST_TARGET_OUTSIDE_LAUNCHAGENTS`.
 */
export function resolveTunnelPlistTarget(homeDir: string, override?: string): string {
  const launchAgentsDir = resolve(homeDir, "Library", "LaunchAgents");
  const target = resolve(
    override === undefined
      ? join(launchAgentsDir, TUNNEL_PLIST_FILENAME)
      : override.endsWith(".plist")
        ? override
        : join(override, TUNNEL_PLIST_FILENAME),
  );
  if (target.startsWith(`/Library${sep}LaunchDaemons`)) {
    throw new InstallError(
      "PLIST_TARGET_OUTSIDE_LAUNCHAGENTS",
      `refusing system-wide plist at ${target}: the tunnel connector is a per-user agent and must never run as root (that is what \`cloudflared service install\` does — do not use it).`,
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

/** Derive every path the installer writes from homeDir + config. */
export function resolveTunnelPaths(input: {
  homeDir: string;
  dataDir: string;
  plistDirOverride?: string | undefined;
}): TunnelResolvedPaths {
  const plistPath = resolveTunnelPlistTarget(input.homeDir, input.plistDirOverride);
  const logsDir = join(input.dataDir, "logs");
  return {
    homeDir: input.homeDir,
    plistPath,
    logsDir,
    stdoutPath: join(logsDir, "cloudflared.out.log"),
    stderrPath: join(logsDir, "cloudflared.err.log"),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Substitute {{PLACEHOLDER}} tokens in the plist template. All substituted
 * values are XML-escaped.
 */
export function renderTunnelPlist(config: TunnelInstallConfig, paths: TunnelResolvedPaths): string {
  const values: Record<string, string> = {
    LABEL: TUNNEL_PLIST_LABEL,
    CLOUDFLARED_BIN: escapeXml(config.cloudflaredBin),
    TUNNEL_CONFIG: escapeXml(config.tunnelConfig),
    STDOUT_PATH: escapeXml(paths.stdoutPath),
    STDERR_PATH: escapeXml(paths.stderrPath),
  };
  return readFileSync(TUNNEL_TEMPLATE_PATH, "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) =>
    name in values ? values[name] ?? whole : whole,
  );
}

// ---------------------------------------------------------------------------
// Preflight gate
// ---------------------------------------------------------------------------

/**
 * Pre-install gate on what exists today: executable cloudflared, a config
 * with a `tunnel:` + `credentials-file:` pair (the renderer's shape), and a
 * readable credentials file. Ingress content is NOT re-validated here —
 * render-cloudflared-config.ts owns that invariant.
 */
export function runTunnelPreflight(config: TunnelInstallConfig, _paths: TunnelResolvedPaths): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  let binOk = isAbsolute(config.cloudflaredBin);
  if (binOk) {
    try {
      accessSync(config.cloudflaredBin, fsConstants.X_OK);
    } catch {
      binOk = false;
    }
  }
  checks.push({
    name: "cloudflared-bin-absolute-executable",
    passed: binOk,
    detail: binOk ? config.cloudflaredBin : `${config.cloudflaredBin} is not an absolute, executable cloudflared binary`,
  });

  let configText: string | undefined;
  try {
    configText = readFileSync(config.tunnelConfig, "utf8");
  } catch {
    configText = undefined;
  }
  const hasTunnel = configText !== undefined && /^\s*tunnel:\s*\S+/m.test(configText);
  const credentialsMatch = configText?.match(/^\s*credentials-file:\s*(\S+)/m);
  const credentialsPath = credentialsMatch === null || credentialsMatch === undefined ? undefined : credentialsMatch[1];

  checks.push({
    name: "tunnel-config-exists",
    passed: configText !== undefined,
    detail:
      configText !== undefined
        ? config.tunnelConfig
        : `${config.tunnelConfig} does not exist — render it first (npm run deploy:render-cloudflared)`,
  });
  checks.push({
    name: "tunnel-config-has-tunnel-and-credentials",
    passed: hasTunnel && credentialsPath !== undefined,
    detail:
      hasTunnel && credentialsPath !== undefined
        ? `tunnel + credentials-file present (${credentialsPath})`
        : "config.yml must carry both a `tunnel:` line and a `credentials-file:` line (render-cloudflared-config.ts shape)",
  });

  if (credentialsPath !== undefined) {
    let credOk = false;
    let detail = "";
    try {
      accessSync(credentialsPath, fsConstants.R_OK);
      credOk = true;
      detail = `${credentialsPath} readable`;
    } catch {
      detail = `${credentialsPath} is not readable — re-create the tunnel or fix the path`;
    }
    checks.push({ name: "tunnel-credentials-readable", passed: credOk, detail });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Install orchestration
// ---------------------------------------------------------------------------

function requireUid(override?: number): number {
  const uid = override ?? process.getuid?.() ?? -1;
  if (!Number.isInteger(uid) || uid < 0) {
    throw new InstallError("no_uid", "cannot determine the current uid for launchctl gui/$UID targets.");
  }
  return uid;
}

/**
 * Render, write, and bootstrap the connector LaunchAgent. Writes happen only
 * after the preflight gate passes; `launchctl bootstrap gui/$UID <plist>` is
 * the last step so a failed bootstrap leaves inspectable files but no
 * half-written state from a skipped gate.
 *
 * A manually-started connector on the same tunnel is NOT killed here —
 * multiple connectors per tunnel are officially supported, so the safe
 * sequence is: install (second connector comes up) → stop the old one.
 */
export async function installTunnel(
  config: TunnelInstallConfig,
  options: TunnelInstallOptions = {},
): Promise<TunnelInstallResult> {
  const homeDir = options.homeDir ?? homedir();
  const paths = resolveTunnelPaths({ homeDir, dataDir: config.dataDir, plistDirOverride: options.plistDirOverride });
  const log = options.log ?? (() => {});
  const uid = requireUid(options.uid);
  const bootstrapCommand = ["/bin/launchctl", "bootstrap", `gui/${uid}`, paths.plistPath];
  const runner = options.runner ?? createRealRunner();

  if (options.skipPreflight === true) {
    log("WARNING: --skip-preflight — running without the preflight gate (development only).");
  } else {
    const preflight = options.preflight ?? runTunnelPreflight;
    const failed = (await preflight(config, paths)).filter((check) => !check.passed);
    if (failed.length > 0) {
      throw new InstallError(
        "preflight_failed",
        `preflight failed:\n${failed.map((check) => `  - ${check.name}: ${check.detail}`).join("\n")}`,
      );
    }
  }

  const plistXml = renderTunnelPlist(config, paths);

  if (options.dryRun === true) {
    log(`[dry-run] plist (0644):        ${paths.plistPath}`);
    log(`[dry-run] logs dir (0700):     ${paths.logsDir}`);
    log(`[dry-run] would run:           ${bootstrapCommand.join(" ")}`);
    log(`[dry-run] rendered plist:\n${plistXml}`);
    return { plistPath: paths.plistPath, dryRun: true, bootstrapCommand };
  }

  // Bootstrap of an already-bootstrapped label is an error; if the operator
  // re-runs the installer, boot out first so bootstrap succeeds. NOT_LOADED
  // output on a first install is tolerated.
  const bootout = await runner.run(["/bin/launchctl", "bootout", `gui/${uid}`, TUNNEL_PLIST_LABEL]);
  const notLoaded = /no such process|could not find service|not bootstrapped|not loaded|does not exist|input\/output error/i;
  if (bootout.code !== 0 && !notLoaded.test(`${bootout.stdout}\n${bootout.stderr}`)) {
    throw new InstallError(
      "bootout_failed",
      `launchctl bootout exited ${bootout.code}: ${bootout.stderr || bootout.stdout || "(no output)"} — nothing was written; resolve this before reinstalling.`,
    );
  }

  mkdirSync(dirname(paths.plistPath), { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.logsDir, 0o700);
  writeFileSync(paths.plistPath, plistXml, { mode: 0o644 });
  chmodSync(paths.plistPath, 0o644);
  // Pre-create the launchd-owned log files so they cannot appear with a
  // umask-dependent mode.
  for (const logFile of [paths.stdoutPath, paths.stderrPath]) {
    if (!existsSync(logFile)) writeFileSync(logFile, "", { mode: 0o600 });
    chmodSync(logFile, 0o600);
  }

  const bootstrap = await runner.run(bootstrapCommand);
  if (bootstrap.code !== 0) {
    throw new InstallError(
      "bootstrap_failed",
      `launchctl bootstrap exited ${bootstrap.code}: ${bootstrap.stderr || bootstrap.stdout || "(no output)"}\n` +
        `the plist was written; inspect with \`launchctl print gui/${uid}/${TUNNEL_PLIST_LABEL}\` or run the uninstaller.`,
    );
  }
  log(`installed ${TUNNEL_PLIST_LABEL}: ${paths.plistPath}`);
  log(`bootstrapped: ${bootstrapCommand.join(" ")}`);
  log("note: a manually-started connector (if any) still runs — stop it once this agent is verified.");
  return { plistPath: paths.plistPath, dryRun: false, bootstrapCommand };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: tsx deploy/scripts/install-tunnel-launchd.ts [options]

Installs the Cloudflare Tunnel connector as a per-user LaunchAgent under
~/Library/LaunchAgents (${TUNNEL_PLIST_FILENAME}) running
\`cloudflared tunnel --config <config> --no-autoupdate run\`. Never writes to
/Library/LaunchDaemons, never runs as root — this replaces the root-requiring
\`cloudflared service install\`.

options:
  --cloudflared <path>   absolute cloudflared binary; default probes
                         ${DEFAULT_CLOUDFLARED_CANDIDATES.join(", ")}
  --tunnel-config <path> tunnel config; default ${DEFAULT_TUNNEL_CONFIG()}
                         (render-cloudflared-config.ts output)
  --data-dir <path>      log parent dir, default ${DEFAULT_DATA_DIR()}
  --dry-run              print the rendered plist and plan, write nothing
  --skip-preflight       (development only) skip the preflight gate
  --home-dir <path>      override $HOME (testing)
  --plist-dir <path>     override the plist directory; must stay inside
                         ~/Library/LaunchAgents
  -h, --help             show this help
`;

interface TunnelCliArgs {
  cloudflared?: string;
  tunnelConfig?: string;
  dataDir?: string;
  homeDir?: string;
  plistDir?: string;
  dryRun?: boolean;
  skipPreflight?: boolean;
  help?: boolean;
}

/** Parse `--key value` / boolean flags; unknown input is a typed usage error. */
export function parseTunnelArgs(argv: string[]): TunnelCliArgs {
  const valueFlags = new Set(["--cloudflared", "--tunnel-config", "--data-dir", "--home-dir", "--plist-dir"]);
  const boolFlags = new Set(["--dry-run", "--skip-preflight", "-h", "--help"]);
  const args: TunnelCliArgs = {};
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
      if (key === "cloudflared") args.cloudflared = value;
      else if (key === "tunnel-config") args.tunnelConfig = value;
      else if (key === "data-dir") args.dataDir = value;
      else if (key === "home-dir") args.homeDir = value;
      else args.plistDir = value;
      continue;
    }
    throw new InstallError("usage", `unknown argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
  }
  return args;
}

/** First existing default cloudflared candidate, or undefined. */
export function detectDefaultCloudflared(): string | undefined {
  return DEFAULT_CLOUDFLARED_CANDIDATES.find((candidate) => existsSync(candidate));
}

/** CLI entry: flags → normalize → install. Returns exit code. */
export async function cliTunnelMain(argv: string[]): Promise<number> {
  const args = parseTunnelArgs(argv);
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cloudflaredBin = args.cloudflared ?? detectDefaultCloudflared();
  if (cloudflaredBin === undefined) {
    throw new InstallError(
      "invalid_config",
      `no cloudflared found at ${DEFAULT_CLOUDFLARED_CANDIDATES.join(" or ")} — pass --cloudflared <path>.`,
    );
  }
  const config = normalizeTunnelInstallConfig({
    cloudflaredBin,
    tunnelConfig: args.tunnelConfig ?? DEFAULT_TUNNEL_CONFIG(),
    dataDir: args.dataDir ?? DEFAULT_DATA_DIR(),
  });

  await installTunnel(config, {
    ...(args.homeDir !== undefined ? { homeDir: args.homeDir } : {}),
    ...(args.plistDir !== undefined ? { plistDirOverride: args.plistDir } : {}),
    ...(args.dryRun === true ? { dryRun: true } : {}),
    ...(args.skipPreflight === true ? { skipPreflight: true } : {}),
    log: (line) => console.log(line),
  });
  return 0;
}

// Execute only when run directly (tsx deploy/scripts/install-tunnel-launchd.ts);
// imports from tests must not trigger the CLI.
const invokedAsMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  cliTunnelMain(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof InstallError ? error.code : "unexpected_error";
    console.error(`error (${code}): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
