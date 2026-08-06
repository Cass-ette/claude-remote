// Process-level wrapper for the opt-in Cloudflare mobile access gate.
//
// Required environment (validated up-front; missing any -> not_run):
//   CF_PROBE_BASE_URL
//   CF_ACCESS_TEAM_DOMAIN
//   CF_ACCESS_AUD
//   CF_EXPECTED_SUBJECT
//   CLOUDFLARED_CONFIG
//   MAC_LAN_IP
//   ANDROID_SERIAL
//   APP_LINK_SHA256_FINGERPRINT
//   CF_LOGIN_TIMEOUT_MS
//   CF_TOKEN_EXPIRY_TIMEOUT_MS  (must exceed real Access session + 120s)
//   CF_INSTRUMENTATION_TIMEOUT_MS
//   CF_OVERALL_TIMEOUT_MS        (must exceed login + expiry + cleanup)
//
// Phase summary:
//   1. Validate env + that required binaries are on PATH.
//   2. adb shell pm verify-app-links --re-verify dev.clauderemote.probe
//      adb shell pm get-app-links dev.clauderemote.probe  -> require the
//      exact probe hostname to be in verified state.
//   3. Start the loopback origin (npm start in this workspace) detached.
//   4. Start cloudflared tunnel --config "$CLOUDFLARED_CONFIG" run detached,
//      capturing stdout/stderr to a logfile.
//   5. Spawn connectedDebugAndroidTest on a separate process group with
//      explicit CF_LOGIN_TIMEOUT_MS / CF_TOKEN_EXPIRY_TIMEOUT_MS /
//      CF_INSTRUMENTATION_TIMEOUT_MS deadlines. Do NOT wait synchronously.
//   6. Poll for the device-side barrier file `ready-for-tunnel-stop` via adb.
//      Once present, record the last origin request id, kill the cloudflared
//      process group, broadcast ACTION_TUNNEL_STOPPED.
//   7. The instrumented test then retries HTTP + WebSocket with its refreshed
//      bearer and writes `cloudflare-gate.json`.
//   8. Pull `cloudflare-gate.json` and origin evidence via adb; verify
//      matching issuer/audience/subject, request IDs, expired-token
//      rejection, refresh/reconnect, LAN refusal, post-tunnel failure.
//   9. Emit GateResult to build/phase0/cloudflare.json.
//
// Any deadline, missing login/barrier/evidence, or child failure becomes
// validated not_run / failed. On timeout or error, terminate the exact
// Gradle, origin, and cloudflared process groups; force-stop the probe app;
// never leave a probe process running.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdir, readFile, access, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import type { GateResult } from "../run-phase0.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const evidencePath = resolve(here, "../../build/phase0/cloudflare.json");
const originDir = resolve(here, "origin");

const REQUIRED_ENV = [
  "CF_PROBE_BASE_URL",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "CF_EXPECTED_SUBJECT",
  "CLOUDFLARED_CONFIG",
  "MAC_LAN_IP",
  "ANDROID_SERIAL",
  "APP_LINK_SHA256_FINGERPRINT",
  "CF_LOGIN_TIMEOUT_MS",
  "CF_TOKEN_EXPIRY_TIMEOUT_MS",
  "CF_INSTRUMENTATION_TIMEOUT_MS",
  "CF_OVERALL_TIMEOUT_MS"
] as const;

interface Children {
  gradle: ChildProcess | null;
  origin: ChildProcess | null;
  cloudflared: ChildProcess | null;
}

const children: Children = { gradle: null, origin: null, cloudflared: null };

function buildResult(
  status: GateResult["status"],
  checks: { name: string; passed: boolean; details?: string }[],
  evidence: Record<string, string | number | boolean>,
  startedAt: string,
  finishedAt: string
): GateResult {
  return {
    name: "cloudflare",
    status,
    startedAt,
    finishedAt,
    checks,
    evidence
  };
}

async function emit(result: GateResult): Promise<void> {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n", "utf8");
}

async function pathReadable(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Kill a child's process group. Best-effort; never throws. */
function killGroup(child: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
}

async function forceStopApp(serial: string): Promise<void> {
  try {
    await runAdb(serial, ["shell", "am", "force-stop", "dev.clauderemote.probe"]);
  } catch {
    // ignore
  }
}

function runAdb(serial: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const all = ["-s", serial, ...args];
    const c = spawn("adb", all, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
    c.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    c.on("error", () => resolveP({ code: -1, stdout, stderr }));
    c.on("exit", (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

/** Verify App Links on-device; require the exact probe host in verified state. */
async function verifyAppLinks(
  serial: string,
  probeHost: string
): Promise<boolean> {
  await runAdb(serial, ["shell", "pm", "verify-app-links", "--re-verify", "dev.clauderemote.probe"]);
  const { stdout } = await runAdb(serial, ["shell", "pm", "get-app-links", "dev.clauderemote.probe"]);
  // Output contains a "Domain verification state:" block. We require the
  // probe hostname to appear as verified.
  return stdout.includes(probeHost) && /verified/i.test(stdout);
}

interface CheckOutput {
  ok: boolean;
  details?: string;
}

/** Pull a file from device to a local temp path. */
async function pullFile(serial: string, remotePath: string, localPath: string): Promise<boolean> {
  const r = await runAdb(serial, ["pull", remotePath, localPath]);
  return r.code === 0;
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();

  // 1. Validate environment.
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0 || process.env.RUN_REAL_CLOUDFLARE !== "1") {
    await emit(
      buildResult(
        "not_run",
        [
          {
            name: "env",
            passed: false,
            details:
              process.env.RUN_REAL_CLOUDFLARE !== "1"
                ? "RUN_REAL_CLOUDFLARE=1 not set — opt-in gate skipped"
                : `missing env vars: ${missing.join(", ")}`
          }
        ],
        { env_complete: missing.length === 0 && process.env.RUN_REAL_CLOUDFLARE === "1" },
        startedAt,
        new Date().toISOString()
      )
    );
    process.stderr.write("cloudflare gate: not_run\n");
    return 0;
  }

  const env = process.env as Record<(typeof REQUIRED_ENV)[number], string>;
  const probeHost = new URL(env.CF_PROBE_BASE_URL).hostname;

  // 2. App Link verification.
  const verified = await verifyAppLinks(env.ANDROID_SERIAL, probeHost);
  if (!verified) {
    await emit(
      buildResult(
        "failed",
        [
          {
            name: "app_link_verified",
            passed: false,
            details: `${probeHost} not in verified state per pm get-app-links`
          }
        ],
        { app_link_verified: false },
        startedAt,
        new Date().toISOString()
      )
    );
    return 0;
  }

  // 3. Start loopback origin (detached process group).
  children.origin = spawn(
    "npm",
    ["run", "start", "--prefix", originDir],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  children.origin.stdout?.on("data", () => {});
  children.origin.stderr?.on("data", () => {});

  // 4. Start cloudflared (detached process group).
  children.cloudflared = spawn(
    "cloudflared",
    ["tunnel", "--config", env.CLOUDFLARED_CONFIG, "run"],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  children.cloudflared.stdout?.on("data", () => {});
  children.cloudflared.stderr?.on("data", () => {});

  // 5. Spawn connectedDebugAndroidTest detached, with a hard deadline.
  const cloudflaredConfigAbs = env.CLOUDFLARED_CONFIG.startsWith("/")
    ? env.CLOUDFLARED_CONFIG
    : resolve(process.cwd(), env.CLOUDFLARED_CONFIG);
  const androidEnv = {
    ...process.env,
    CF_PROBE_BASE_URL: env.CF_PROBE_BASE_URL,
    CF_ACCESS_TEAM_DOMAIN: env.CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD: env.CF_ACCESS_AUD,
    CF_EXPECTED_SUBJECT: env.CF_EXPECTED_SUBJECT,
    MAC_LAN_IP: env.MAC_LAN_IP,
    CLOUDFLARED_CONFIG: cloudflaredConfigAbs,
    CF_LOGIN_TIMEOUT_MS: env.CF_LOGIN_TIMEOUT_MS,
    CF_TOKEN_EXPIRY_TIMEOUT_MS: env.CF_TOKEN_EXPIRY_TIMEOUT_MS,
    CF_INSTRUMENTATION_TIMEOUT_MS: env.CF_INSTRUMENTATION_TIMEOUT_MS
  };
  children.gradle = spawn(
    "./gradlew",
    ["connectedDebugAndroidTest"],
    { cwd: resolve(here, "android-probe"), detached: true, stdio: ["ignore", "pipe", "pipe"], env: androidEnv }
  );

  // 6. Deadline bookkeeping.
  const overallMs = parseInt(env.CF_OVERALL_TIMEOUT_MS, 10);
  const loginMs = parseInt(env.CF_LOGIN_TIMEOUT_MS, 10);
  const expiryMs = parseInt(env.CF_TOKEN_EXPIRY_TIMEOUT_MS, 10);
  const instrMs = parseInt(env.CF_INSTRUMENTATION_TIMEOUT_MS, 10);

  const start = Date.now();
  let timedOut = false;
  const overallTimer = setTimeout(() => {
    timedOut = true;
  }, Math.min(overallMs, loginMs + expiryMs + instrMs + 60_000));

  // 7. Wait for barrier file via adb polling.
  const barrierLocal = resolve(here, ".barrier-ready");
  let lastOriginRequestId = "";
  let barrierSeen = false;
  const barrierPoll = setInterval(async () => {
    const r = await runAdb(env.ANDROID_SERIAL, [
      "shell",
      "run-as",
      "dev.clauderemote.probe",
      "cat",
      "/data/data/dev.clauderemote.probe/files/ready-for-tunnel-stop"
    ]);
    if (r.code === 0 && r.stdout.trim().length > 0) {
      barrierSeen = true;
      await writeFile(barrierLocal, r.stdout, "utf8");
      // Record the last origin request id (pulled from origin evidence file).
      try {
        const evText = await readFile(
          resolve(here, "origin/cloudflare-origin-evidence.json"),
          "utf8"
        );
        const ev = JSON.parse(evText) as { httpRequestIds: string[]; wsRequestIds: string[] };
        const all = [...ev.httpRequestIds, ...ev.wsRequestIds];
        lastOriginRequestId = all[all.length - 1] ?? "";
      } catch {
        // ignore
      }
      // Stop the cloudflared process group, then signal Android.
      killGroup(children.cloudflared, "SIGTERM");
      setTimeout(() => killGroup(children.cloudflared, "SIGKILL"), 5000).unref();
      children.cloudflared = null;
      await runAdb(env.ANDROID_SERIAL, [
        "shell",
        "am",
        "broadcast",
        "-a",
        "dev.clauderemote.probe.ACTION_TUNNEL_STOPPED",
        "-n",
        "dev.clauderemote.probe/.TunnelStoppedReceiver"
      ]);
      clearInterval(barrierPoll);
    }
  }, 5000);
  barrierPoll.unref();

  // 8. Await gradle child exit.
  const gradleExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = new Promise((res) => {
    children.gradle?.on("exit", (code, signal) => res({ code, signal }));
    children.gradle?.on("error", () => res({ code: -1, signal: null }));
  });
  const outcome = await gradleExit;
  clearTimeout(overallTimer);
  clearInterval(barrierPoll);
  const finishedAt = new Date().toISOString();

  // 9. Cleanup — always kill all children + force-stop the app.
  killGroup(children.gradle, "SIGKILL");
  killGroup(children.origin, "SIGTERM");
  setTimeout(() => killGroup(children.origin, "SIGKILL"), 5000).unref();
  killGroup(children.cloudflared, "SIGKILL");
  await forceStopApp(env.ANDROID_SERIAL);

  // 10. Pull final evidence + verify.
  const gateLocal = resolve(here, ".cloudflare-gate.json");
  const pulled = await pullFile(
    env.ANDROID_SERIAL,
    "/data/data/dev.clauderemote.probe/files/cloudflare-gate.json",
    gateLocal
  );

  const checks: { name: string; passed: boolean; details?: string }[] = [];
  const evidence: Record<string, string | number | boolean> = {
    timed_out: timedOut,
    barrier_seen: barrierSeen,
    gradle_exit: outcome.code ?? -1
  };

  if (timedOut) {
    checks.push({ name: "deadline", passed: false, details: `exceeded ${overallMs}ms` });
  } else if (outcome.signal) {
    checks.push({ name: "process", passed: false, details: `killed by signal ${outcome.signal}` });
  } else if ((outcome.code ?? -1) !== 0) {
    checks.push({ name: "gradle", passed: false, details: `exit=${outcome.code}` });
  }

  if (!barrierSeen) {
    checks.push({ name: "barrier_seen", passed: false, details: "ready-for-tunnel-stop never appeared" });
  }

  if (pulled && (await pathReadable(gateLocal))) {
    try {
      const text = await readFile(gateLocal, "utf8");
      const gate = JSON.parse(text) as {
        issuer: string;
        audience: string;
        subject: string;
        expiredHttpRejected: boolean;
        expiredWsRejected: boolean;
        refreshedHttpOk: boolean;
        lanUnreachable: boolean;
        postTunnelHttpFailed: boolean;
        postTunnelWsFailed: boolean;
      };
      checks.push({ name: "issuer_match", passed: gate.issuer === `https://${env.CF_ACCESS_TEAM_DOMAIN}` });
      checks.push({ name: "audience_match", passed: gate.audience === env.CF_ACCESS_AUD });
      checks.push({ name: "subject_match", passed: gate.subject === env.CF_EXPECTED_SUBJECT });
      checks.push({ name: "expired_http_rejected", passed: gate.expiredHttpRejected });
      checks.push({ name: "expired_ws_rejected", passed: gate.expiredWsRejected });
      checks.push({ name: "refreshed_http_ok", passed: gate.refreshedHttpOk });
      checks.push({ name: "lan_unreachable", passed: gate.lanUnreachable });
      checks.push({ name: "post_tunnel_http_failed", passed: gate.postTunnelHttpFailed });
      checks.push({ name: "post_tunnel_ws_failed", passed: gate.postTunnelWsFailed });
      evidence.issuer_match = gate.issuer === `https://${env.CF_ACCESS_TEAM_DOMAIN}`;
      evidence.last_origin_request_id = lastOriginRequestId;
    } catch (err) {
      checks.push({ name: "evidence_json", passed: false, details: (err as Error).message });
    }
  } else {
    checks.push({ name: "evidence_pulled", passed: false, details: "could not pull cloudflare-gate.json" });
  }

  const passed = checks.length > 0 && checks.every((c) => c.passed);
  const status: GateResult["status"] = passed ? "passed" : "failed";

  await emit(buildResult(status, checks, evidence, startedAt, finishedAt));
  // Clean local temp artifacts (evidence file remains authoritative).
  await rm(barrierLocal, { force: true });
  await rm(gateLocal, { force: true });

  void hostname;
  process.stderr.write(`cloudflare gate: ${status}\n`);
  return 0;
}

async function withShutdown(handler: () => Promise<number>): Promise<number> {
  let exitCode = 0;
  const onSignal = (sig: NodeJS.Signals) => {
    killGroup(children.gradle, "SIGTERM");
    killGroup(children.origin, "SIGTERM");
    killGroup(children.cloudflared, "SIGTERM");
    setTimeout(() => {
      killGroup(children.gradle, "SIGKILL");
      killGroup(children.origin, "SIGKILL");
      killGroup(children.cloudflared, "SIGKILL");
      process.exit(128 + (sig === "SIGINT" ? 2 : 15));
    }, 5000).unref();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    exitCode = await handler();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return exitCode;
}

void withShutdown(main);
