// Runtime health check for the "Mac 开机就能用" story (companion to
// deploy:install-launchd / deploy:install-tunnel-launchd).
//
// Unlike deploy:preflight (install-time, config-focused), this checks what is
// ALIVE right now:
//
//   1. bridge LaunchAgent state      launchctl print gui/$UID/dev.clauderemote.bridge
//   2. tunnel LaunchAgent state      launchctl print gui/$UID/dev.clauderemote.cloudflared
//   3. loopback health               curl http://127.0.0.1:<port>/api/v1/health
//   4. public health through tunnel  curl https://<public-host>/api/v1/health
//   5. Mac sleep setting             pmset -g (sleep would break the tunnel)
//   6. auto-login                    loginwindow autoLoginUser (LaunchAgents
//                                    only load after a GUI login)
//
// Checks 5 and 6 need the user (System Settings / sudo pmset) — the script
// flags them instead of fixing them. WARN does not fail the run; FAIL does.
//
// Run: npx tsx deploy/scripts/doctor.ts [--env-file <path>]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnvFile } from "./env-file.js";
import {
  DEFAULT_BRIDGE_PORT,
  createRealRunner,
  ENV_FILENAME,
  InstallError,
  PLIST_LABEL,
  type CommandRunner,
} from "./install-launchd.js";
import { TUNNEL_PLIST_LABEL } from "./install-tunnel-launchd.js";

export type DoctorStatus = "PASS" | "FAIL" | "WARN" | "INFO";

export interface DoctorCheck {
  readonly status: DoctorStatus;
  readonly name: string;
  readonly detail: string;
}

export interface DoctorOptions {
  /** Bridge env file (public host + port source); default the installer's. */
  readonly envFile?: string | undefined;
  /** Fake runner for tests; default spawns real launchctl/curl/pmset/defaults. */
  readonly runner?: CommandRunner | undefined;
  readonly uid?: number | undefined;
  /** Progress sink (default: none; runDoctor callers render the report). */
  readonly log?: ((line: string) => void) | undefined;
}

const DEFAULT_ENV_FILE = () => join(homedir(), "Library", "LaunchAgents", ENV_FILENAME);

const TUNNEL_DOWN_HINT =
  "run `launchctl kickstart gui/$UID/" + TUNNEL_PLIST_LABEL + "` or reinstall with npm run deploy:install-tunnel-launchd";

/** One agent state query: launchctl print gui/$UID/<label>. */
async function agentCheck(
  runner: CommandRunner,
  uid: number,
  label: string,
  fixHint: string,
): Promise<DoctorCheck> {
  const result = await runner.run(["/bin/launchctl", "print", `gui/${uid}/${label}`]);
  if (result.code !== 0) {
    return { status: "FAIL", name: `agent:${label}`, detail: `not loaded: ${result.stderr.trim() || result.stdout.trim()} — ${fixHint}` };
  }
  const state = result.stdout.match(/^\s*state\s*=\s*(\S+)/m)?.[1];
  if (state === "running") {
    const pid = result.stdout.match(/^\s*pid\s*=\s*(\d+)/m)?.[1];
    return { status: "PASS", name: `agent:${label}`, detail: `running${pid === undefined ? "" : ` (pid ${pid})`}` };
  }
  return { status: "FAIL", name: `agent:${label}`, detail: `state=${state ?? "unknown"} — ${fixHint}` };
}

/** curl a health URL and require a JSON ok body. */
async function healthCheck(runner: CommandRunner, name: string, url: string, timeoutSeconds: number, fixHint: string): Promise<DoctorCheck> {
  const result = await runner.run(["/usr/bin/curl", "-s", "-m", String(timeoutSeconds), "-w", "\n%{http_code}", url]);
  const lines = result.stdout.trimEnd().split("\n");
  const httpCode = lines[lines.length - 1] ?? "";
  const body = lines.slice(0, -1).join("\n");
  if (httpCode === "200" && body.includes('"ok"')) {
    return { status: "PASS", name, detail: `200 {"status":"ok"} via ${url}` };
  }
  return {
    status: "FAIL",
    name,
    detail: `http=${httpCode || "none"} body=${body.slice(0, 120) || "(empty)"} via ${url} — ${fixHint}`,
  };
}

/** pmset -g: WARN when system sleep will eventually suspend the Mac. */
async function sleepCheck(runner: CommandRunner): Promise<DoctorCheck> {
  const result = await runner.run(["/usr/bin/pmset", "-g"]);
  const sleep = result.stdout.match(/^\s*sleep\s+(\d+)/m)?.[1];
  if (sleep === undefined) {
    return { status: "INFO", name: "mac-sleep", detail: "could not parse `pmset -g` — check System Settings → Battery yourself" };
  }
  if (sleep === "0") {
    return { status: "PASS", name: "mac-sleep", detail: "system sleep disabled (sleep 0) — tunnel survives idle" };
  }
  return {
    status: "WARN",
    name: "mac-sleep",
    detail: `system sleeps after ${sleep} min — the tunnel drops while asleep; disable via System Settings → Battery → Options (or \`sudo pmset -a sleep 0\`)`,
  };
}

/** Auto-login: LaunchAgents only load after a GUI login. */
async function autoLoginCheck(runner: CommandRunner): Promise<DoctorCheck> {
  const result = await runner.run(["/usr/bin/defaults", "read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"]);
  const user = result.stdout.trim();
  if (result.code === 0 && user !== "") {
    return { status: "PASS", name: "mac-auto-login", detail: `auto-login enabled for ${user} — agents start without a manual login` };
  }
  return {
    status: "WARN",
    name: "mac-auto-login",
    detail: "auto-login not detected — after a reboot, someone must log in once before the agents load (System Settings → Users & Groups → Automatic login)",
  };
}

/**
 * Run all runtime checks. Public-host/port defaults come from the installer's
 * env file; explicit CLI flags override. Never prints secrets (the env file is
 * only parsed, and only host/port are surfaced).
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const uid = options.uid ?? process.getuid?.() ?? -1;
  if (!Number.isInteger(uid) || uid < 0) {
    throw new InstallError("no_uid", "cannot determine the current uid for launchctl gui/$UID targets.");
  }
  const runner = options.runner ?? createRealRunner();

  const envPath = options.envFile ?? DEFAULT_ENV_FILE();
  let envFile: Record<string, string> = {};
  try {
    envFile = parseEnvFile(readFileSync(envPath, "utf8"));
  } catch {
    // Missing env file is not fatal: loopback uses the default port and the
    // public check degrades to INFO below.
  }

  const port = Number(envFile["BRIDGE_PORT"] ?? DEFAULT_BRIDGE_PORT);
  const publicHost = envFile["BRIDGE_PUBLIC_HOST"];

  const checks: DoctorCheck[] = [];
  checks.push(await agentCheck(runner, uid, PLIST_LABEL, "reinstall with npm run deploy:install-launchd"));
  checks.push(await agentCheck(runner, uid, TUNNEL_PLIST_LABEL, TUNNEL_DOWN_HINT));
  checks.push(
    await healthCheck(runner, "health:loopback", `http://127.0.0.1:${port}/api/v1/health`, 5, "bridge agent not serving; check <data-dir>/logs/bridge.err.log"),
  );
  if (publicHost === undefined) {
    checks.push({
      status: "INFO",
      name: "health:public",
      detail: `BRIDGE_PUBLIC_HOST not set in ${envPath} — pass --env-file or set it to check the public URL`,
    });
  } else {
    checks.push(await healthCheck(runner, "health:public", `https://${publicHost}/api/v1/health`, 10, TUNNEL_DOWN_HINT));
  }
  checks.push(await sleepCheck(runner));
  checks.push(await autoLoginCheck(runner));
  return checks;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: tsx deploy/scripts/doctor.ts [options]

Runtime health check: are the Bridge + tunnel LaunchAgents running, is the
Bridge reachable on loopback AND through the public tunnel URL, and will the
Mac stay awake / auto-login after a reboot? PASS/FAIL/WARN/INFO per check;
exit 1 on any FAIL.

options:
  --env-file <path>  Bridge env file for BRIDGE_PUBLIC_HOST/BRIDGE_PORT,
                     default ~/Library/LaunchAgents/${ENV_FILENAME}
  -h, --help         show this help
`;

export function renderDoctorReport(checks: DoctorCheck[]): string {
  return checks.map((check) => `${check.status.padEnd(4)} ${check.name} — ${check.detail}`).join("\n");
}

async function cliMain(argv: string[]): Promise<number> {
  const args: { envFile?: string; help?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--env-file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error(`error (usage): ${arg} requires a value.`);
        return 1;
      }
      i += 1;
      args.envFile = value;
    } else {
      console.error(`error (usage): unknown argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
      return 1;
    }
  }
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const checks = await runDoctor({
    ...(args.envFile !== undefined ? { envFile: args.envFile } : {}),
  });
  process.stdout.write(`${renderDoctorReport(checks)}\n`);
  const failed = checks.filter((check) => check.status === "FAIL").length;
  if (failed > 0) {
    process.stdout.write(`\n${failed} check(s) FAILED\n`);
    return 1;
  }
  return 0;
}

// Execute only when run directly (tsx deploy/scripts/doctor.ts).
const invokedAsMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  cliMain(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof InstallError ? error.code : "unexpected_error";
    console.error(`error (${code}): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
