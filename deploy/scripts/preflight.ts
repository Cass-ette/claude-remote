// Standalone bridge preflight launcher (implementation-plan Task 36; spec
// §10.1, §11).
//
// The CHECK LOGIC lives in the bridge workspace (bridge/src/admin/preflight.ts,
// wired into the `bridge admin preflight` subcommand) so this deploy script
// imports nothing from bridge and the root typecheck stays light — the same
// reason env-file.ts is standalone. This launcher resolves the built admin
// CLI, computes BRIDGE_PLIST_PATH with the installer's containment rules
// (resolvePlistTarget: strictly inside ~/Library/LaunchAgents), and spawns:
//
//   <node> <bridgeMain-dir>/admin/cli.js admin preflight [--json]
//
// The child inherits the operator's environment, so the optional Cloudflare
// checks run when CF_API_TOKEN / CF_ZONE_ID / CF_EXPECTED_SUBJECT /
// BRIDGE_CLOUDFLARE_TUNNEL_NAME are exported. This launcher NEVER calls
// `launchctl bootstrap` (the installer's job) and never logs secrets.
//
// Run: npx tsx deploy/scripts/preflight.ts [--data-dir …] [--json]

import { spawn } from "node:child_process";
import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseEnvFile } from "./env-file.js";
import {
  DEFAULT_BRIDGE_MAIN,
  DEFAULT_DATA_DIR,
  InstallError,
  bridgeAdminCliFromMain,
  resolvePlistTarget,
} from "./install-launchd.js";

const USAGE = `usage: tsx deploy/scripts/preflight.ts [options]

Runs the bridge admin CLI's preflight self-check (loopback bind, data dir
mode/ownership, database, audit log, Cloudflare Access JWKS, launchd plist
containment, cloudflared tunnel lookup, Access identity policy, and a
loopback /api/v1/health probe of the built entry). Never calls launchctl.

options:
  --data-dir <path>       absolute Bridge data dir (BRIDGE_DATA_DIR)
  --bridge-main <path>    built entry, default ${DEFAULT_BRIDGE_MAIN}
  --node <path>           absolute node binary, default the running node
  --home-dir <path>       override $HOME anchoring ~/Library/LaunchAgents
  --plist-dir <path>      override the plist directory; must stay inside
                          ~/Library/LaunchAgents
  --config <path>         env-style file providing any of the keys below
                          (BRIDGE_DATA_DIR, BRIDGE_MAIN, BRIDGE_NODE_BIN,
                          BRIDGE_PORT, BRIDGE_CLOUDFLARE_TEAM_DOMAIN,
                          BRIDGE_CLOUDFLARE_AUD, BRIDGE_PUBLIC_HOST);
                          explicit flags win over file values
  --json                  pass through to the CLI: emit the structured
                          report as one JSON document
  -h, --help              show this help

Optional Cloudflare checks read CF_API_TOKEN, CF_ZONE_ID, CF_EXPECTED_SUBJECT
and BRIDGE_CLOUDFLARE_TUNNEL_NAME from the environment.
`;

interface LauncherArgs {
  config?: string;
  node?: string;
  bridgeMain?: string;
  dataDir?: string;
  homeDir?: string;
  plistDir?: string;
  json?: boolean;
  help?: boolean;
}

/** Parse the launcher's flag subset (unknown input is a typed usage error). */
export function parseLauncherArgs(argv: string[]): LauncherArgs {
  const valueFlags = new Set(["--config", "--node", "--bridge-main", "--data-dir", "--home-dir", "--plist-dir"]);
  const boolFlags = new Set(["--json", "-h", "--help"]);
  const args: LauncherArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (boolFlags.has(arg)) {
      if (arg === "-h" || arg === "--help") args.help = true;
      else args.json = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new InstallError("usage", `${arg} requires a value.`);
      }
      i += 1;
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      (args as Record<string, string | boolean | undefined>)[key] = value;
      continue;
    }
    throw new InstallError("usage", `unknown argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
  }
  return args;
}

/**
 * Resolve inputs, spawn `<node> <adminCli> admin preflight [--json]` with the
 * computed environment, and return the child's exit code. Streams the child's
 * stdout/stderr straight through so operators see the PASS/FAIL/INFO lines.
 */
export async function preflightMain(argv: string[]): Promise<number> {
  const args = parseLauncherArgs(argv);
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const file: Record<string, string> =
    args.config !== undefined ? parseEnvFile(readFileSync(args.config, "utf8")) : {};
  const nodeBin = args.node ?? file["BRIDGE_NODE_BIN"] ?? process.execPath;
  const bridgeMain = args.bridgeMain ?? file["BRIDGE_MAIN"] ?? DEFAULT_BRIDGE_MAIN;
  const dataDir = args.dataDir ?? file["BRIDGE_DATA_DIR"] ?? DEFAULT_DATA_DIR();
  const homeDir = args.homeDir ?? homedir();
  // Fail closed on any plist location outside ~/Library/LaunchAgents.
  const plistPath = resolvePlistTarget(homeDir, args.plistDir);

  const adminCli = bridgeAdminCliFromMain(bridgeMain);
  let adminOk = false;
  try {
    adminOk = statSync(adminCli).isFile();
  } catch {
    adminOk = false;
  }
  if (!adminOk) {
    throw new InstallError(
      "missing_dist",
      `${adminCli} does not exist — build the bridge first (npm run build -w @claude-remote/bridge).`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRIDGE_DATA_DIR: dataDir,
    BRIDGE_MAIN: bridgeMain,
    BRIDGE_NODE_BIN: nodeBin,
    BRIDGE_PLIST_PATH: plistPath,
  };
  for (const key of ["BRIDGE_PORT", "BRIDGE_CLOUDFLARE_TEAM_DOMAIN", "BRIDGE_CLOUDFLARE_AUD", "BRIDGE_PUBLIC_HOST"]) {
    const value = file[key];
    if (value !== undefined) env[key] = value;
  }

  const command = [nodeBin, adminCli, "admin", "preflight", ...(args.json === true ? ["--json"] : [])];
  const code = await new Promise<number>((resolveCode) => {
    const child = spawn(command[0] as string, command.slice(1), {
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (error: Error) => {
      process.stderr.write(`error (spawn_failed): ${String(error)}\n`);
      resolveCode(1);
    });
    child.on("close", (exitCode) => resolveCode(exitCode ?? 1));
  });
  return code;
}

// Execute only when run directly (tsx deploy/scripts/preflight.ts); imports
// from elsewhere must not trigger the CLI.
const invokedAsMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  preflightMain(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof InstallError ? error.code : "unexpected_error";
    console.error(`error (${code}): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
