// Uninstall the claude-remote Cloudflare Tunnel connector LaunchAgent
// (counterpart to deploy/scripts/install-tunnel-launchd.ts).
//
// Removes ONLY the installer-owned plist under ~/Library/LaunchAgents and
// boots the job out of the user gui domain. The tunnel config
// (~/.cloudflared/config.yml), the tunnel credentials, and the Bridge data
// dir (logs) are deliberately left intact — uninstalling the agent is not
// deleting the tunnel.
//
// Run: npx tsx deploy/scripts/uninstall-tunnel-launchd.ts [--dry-run]

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createRealRunner,
  InstallError,
  type CommandRunner,
} from "./install-launchd.js";
import { resolveTunnelPlistTarget, TUNNEL_PLIST_FILENAME, TUNNEL_PLIST_LABEL } from "./install-tunnel-launchd.js";

/** bootout failure texts meaning "nothing was loaded" — tolerated. */
const NOT_LOADED = /no such process|could not find service|not bootstrapped|not loaded|does not exist/i;

export interface TunnelUninstallOptions {
  /** Override $HOME-derived paths (tests use a tmp dir). */
  readonly homeDir?: string | undefined;
  /** Fake runner for tests; default spawns the real /bin/launchctl. */
  readonly runner?: CommandRunner | undefined;
  /** Override the uid used in `launchctl … gui/$UID` (tests pin 501). */
  readonly uid?: number | undefined;
  /** Plist directory override; MUST stay inside ~/Library/LaunchAgents. */
  readonly plistDirOverride?: string | undefined;
  /** Print the plan without running launchctl or deleting files. */
  readonly dryRun?: boolean | undefined;
  /** Progress sink (default: console.log; tests silence it). */
  readonly log?: ((line: string) => void) | undefined;
}

export interface TunnelUninstallResult {
  readonly bootoutCommand: string[];
  /** Files actually removed (empty for dry-run / already-clean systems). */
  readonly removed: string[];
  readonly dryRun: boolean;
}

/**
 * Boot the connector out of `gui/$UID` (by service target, so it works even
 * if the plist file was already removed by hand), then delete the plist.
 * Unexpected bootout failures abort BEFORE deleting anything, so a
 * still-loaded agent never loses its definition file.
 */
export async function uninstallTunnel(options: TunnelUninstallOptions = {}): Promise<TunnelUninstallResult> {
  const homeDir = options.homeDir ?? homedir();
  const log = options.log ?? (() => {});
  const plistPath = resolveTunnelPlistTarget(homeDir, options.plistDirOverride);
  const uid = options.uid ?? process.getuid?.() ?? -1;
  if (!Number.isInteger(uid) || uid < 0) {
    throw new InstallError("no_uid", "cannot determine the current uid for launchctl gui/$UID targets.");
  }
  const bootoutCommand = ["/bin/launchctl", "bootout", `gui/${uid}`, TUNNEL_PLIST_LABEL];

  if (options.dryRun === true) {
    log(`[dry-run] would run: ${bootoutCommand.join(" ")}`);
    log(`[dry-run] would remove: ${plistPath}`);
    log("[dry-run] would NOT touch the tunnel config, credentials, or the Bridge data dir");
    return { bootoutCommand, removed: [], dryRun: true };
  }

  const runner = options.runner ?? createRealRunner();
  {
    const bootout = await runner.run(bootoutCommand);
    if (bootout.code !== 0 && !NOT_LOADED.test(`${bootout.stdout}\n${bootout.stderr}`)) {
      throw new InstallError(
        "bootout_failed",
        `launchctl bootout exited ${bootout.code}: ${bootout.stderr || bootout.stdout || "(no output)"}\n` +
          "the plist was left in place; resolve the bootout failure before removing it.",
      );
    }
    log(`booted out ${TUNNEL_PLIST_LABEL} (gui/${uid})`);
  }

  const removed: string[] = [];
  if (existsSync(plistPath)) {
    rmSync(plistPath);
    removed.push(plistPath);
  }
  log(`removed ${removed.length} file(s); tunnel config/credentials and Bridge data dir left intact`);
  return { bootoutCommand, removed, dryRun: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: tsx deploy/scripts/uninstall-tunnel-launchd.ts [options]

Boots the ${TUNNEL_PLIST_LABEL} agent out of gui/$UID and removes
~/Library/LaunchAgents/${TUNNEL_PLIST_FILENAME}. The tunnel config
(~/.cloudflared/config.yml), credentials, and Bridge data dir are left
intact. NOTE: after this, public reachability is gone until a connector is
started again.

options:
  --dry-run          print the plan, run/delete nothing
  --home-dir <path>  override $HOME (testing)
  --plist-dir <path> override the plist directory; must stay inside
                     ~/Library/LaunchAgents
  -h, --help         show this help
`;

async function cliMain(argv: string[]): Promise<number> {
  const args: { dryRun?: boolean; homeDir?: string; plistDir?: string; help?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--home-dir" || arg === "--plist-dir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error(`error (usage): ${arg} requires a value.`);
        return 1;
      }
      i += 1;
      if (arg === "--home-dir") args.homeDir = value;
      else args.plistDir = value;
    } else {
      console.error(`error (usage): unknown argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
      return 1;
    }
  }
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  await uninstallTunnel({
    ...(args.homeDir !== undefined ? { homeDir: args.homeDir } : {}),
    ...(args.plistDir !== undefined ? { plistDirOverride: args.plistDir } : {}),
    ...(args.dryRun === true ? { dryRun: true } : {}),
    log: (line) => console.log(line),
  });
  return 0;
}

// Execute only when run directly; imports from tests must not trigger the CLI.
const invokedAsMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  cliMain(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof InstallError ? error.code : "unexpected_error";
    console.error(`error (${code}): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
