// Uninstall the claude-remote Bridge LaunchAgent (implementation-plan
// Task 34; spec §10.1).
//
// Removes ONLY the two installer-owned files (plist + env file) under
// ~/Library/LaunchAgents and boots the job out of the user gui domain.
// The Bridge data dir (BRIDGE_DATA_DIR: database, audit log, logs) is
// deliberately left intact — uninstalling the agent is not wiping user data.
//
// Run: npx tsx deploy/scripts/uninstall-launchd.ts [--dry-run]

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRealRunner,
  ENV_FILENAME,
  InstallError,
  PLIST_FILENAME,
  PLIST_LABEL,
  resolvePlistTarget,
  type CommandRunner,
} from "./install-launchd.js";

/** bootout failure texts meaning "nothing was loaded" — tolerated. */
const NOT_LOADED = /no such process|could not find service|not bootstrapped|not loaded|does not exist/i;

export interface UninstallOptions {
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

export interface UninstallResult {
  readonly bootoutCommand: string[];
  /** Files actually removed (empty for dry-run / already-clean systems). */
  readonly removed: string[];
  readonly dryRun: boolean;
}

/**
 * Boot the job out of `gui/$UID` (by service target, so it works even if the
 * plist file was already removed by hand), then delete the plist and env
 * file. Unexpected bootout failures abort BEFORE deleting anything, so a
 * still-loaded agent never loses its definition file.
 */
export async function uninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  const homeDir = options.homeDir ?? homedir();
  const log = options.log ?? (() => {});
  const plistPath = resolvePlistTarget(homeDir, options.plistDirOverride);
  const envFilePath = join(dirname(plistPath), ENV_FILENAME);
  const uid = options.uid ?? process.getuid?.() ?? -1;
  if (!Number.isInteger(uid) || uid < 0) {
    throw new InstallError("no_uid", "cannot determine the current uid for launchctl gui/$UID targets.");
  }
  const bootoutCommand = ["/bin/launchctl", "bootout", `gui/${uid}`, PLIST_LABEL];

  if (options.dryRun === true) {
    log(`[dry-run] would run: ${bootoutCommand.join(" ")}`);
    log(`[dry-run] would remove: ${plistPath}`);
    log(`[dry-run] would remove: ${envFilePath}`);
    log("[dry-run] would NOT touch the Bridge data dir");
    return { bootoutCommand, removed: [], dryRun: true };
  }

  const runner = options.runner ?? createRealRunner();
  // Always attempt the bootout (by service target): a job whose plist was
  // removed by hand can still be loaded, and NOT_LOADED output is tolerated.
  {
    const bootout = await runner.run(bootoutCommand);
    if (bootout.code !== 0 && !NOT_LOADED.test(`${bootout.stdout}\n${bootout.stderr}`)) {
      throw new InstallError(
        "bootout_failed",
        `launchctl bootout exited ${bootout.code}: ${bootout.stderr || bootout.stdout || "(no output)"}\n` +
          "files were left in place; resolve the bootout failure before removing the plist.",
      );
    }
    log(`booted out ${PLIST_LABEL} (gui/${uid})`);
  }

  const removed: string[] = [];
  for (const file of [plistPath, envFilePath]) {
    if (existsSync(file)) {
      rmSync(file);
      removed.push(file);
    }
  }
  log(`removed ${removed.length} file(s); Bridge data dir left intact`);
  return { bootoutCommand, removed, dryRun: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: tsx deploy/scripts/uninstall-launchd.ts [options]

Boots the ${PLIST_LABEL} agent out of gui/$UID and removes
~/Library/LaunchAgents/{${PLIST_FILENAME},${ENV_FILENAME}}.
The Bridge data dir (database, audit log, logs) is left intact.

options:
  --dry-run        print the plan, run/delete nothing
  --home-dir <path>  override $HOME (testing)
  --plist-dir <path> override the plist directory; must stay inside
                     ~/Library/LaunchAgents
  -h, --help       show this help
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
  await uninstall({
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
