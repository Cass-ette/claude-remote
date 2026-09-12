import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type BridgeConfig, type EnvSource } from "../config.js";
import type { JwksFetcher } from "../auth/access-jwt-verifier.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { SqliteDatabase } from "../db/database.js";

/**
 * Bridge preflight self-check (implementation-plan Task 36; spec §10.1, §11).
 *
 * Extends the Task 23 in-CLI checks with the deploy-time verifications the
 * plan enumerates. Every check returns a typed {@link PreflightCheck}; the
 * report is printed human-readably by the admin CLI, or as JSON via
 * `--json` for the launchd installer (deploy/scripts/install-launchd.ts,
 * which spawns `node <dist>/src/admin/cli.js admin preflight --json` as its
 * default pre-install gate; deploy/scripts/preflight.ts is the standalone
 * launcher).
 *
 * SECURITY INVARIANTS:
 * - Secrets are never logged: the Cloudflare API token (CF_API_TOKEN) rides
 *   the Authorization header only, Access assertion material is never
 *   fetched or printed (the JWKS check touches the public certs endpoint
 *   only), and pairing tokens are out of scope here.
 * - The health check spawns the built bridge entry with
 *   BRIDGE_PREFLIGHT_HEALTH_ONLY=1 on the loopback bind, polls
 *   GET /api/v1/health until it answers, holds an occupied-port grace
 *   window before trusting an OK answer, and terminates the child.
 * - The preflight NEVER calls `launchctl bootstrap` — that stays in the
 *   installer, and only after this gate passes.
 * - Checks whose configuration is absent (Cloudflare team domain, tunnel
 *   name, CF policy triple, built bridge entry) are INFO-skipped, so a
 *   local-only bridge still passes; they are REQUIRED (fail) once their
 *   configuration is present, partially or fully.
 */

/** Outcome category of a single preflight check. */
export type PreflightStatus = "pass" | "fail" | "info";

/** One typed check result — the plan's `{ name, passed, details }` plus status. */
export interface PreflightCheck {
  readonly name: string;
  /** Machine-readable outcome; INFO means "not applicable / skipped". */
  readonly status: PreflightStatus;
  /** False only for FAIL; INFO-skips do not fail the run. */
  readonly passed: boolean;
  readonly details: string;
}

/** Full report; directly JSON-serializable for `--json`. */
export interface PreflightReport {
  readonly ok: boolean;
  readonly failed: number;
  readonly checks: readonly PreflightCheck[];
  /** Present only when configuration was invalid and later checks were skipped. */
  readonly fatal?: string | undefined;
}

function pass(name: string, details: string): PreflightCheck {
  return { name, status: "pass", passed: true, details };
}
function fail(name: string, details: string): PreflightCheck {
  return { name, status: "fail", passed: false, details };
}
function info(name: string, details: string): PreflightCheck {
  return { name, status: "info", passed: true, details };
}

/**
 * Default occupied-port grace window (ms): how long the prober waits after an
 * OK health answer before trusting that the spawned child is the responder.
 */
export const DEFAULT_OCCUPIED_GRACE_MS = 1_500;

/**
 * Probe URL for the loopback health endpoint. IPv6 hosts (the config accepts
 * `::1`) must be bracketed per RFC 3986, or `http://::1:43111/...` is not a
 * valid URL and every fetch throws.
 */
export function healthUrl(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${port}/api/v1/health`;
}

/** Result of one external command (cloudflared …) via the injectable runner. */
export interface CommandOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable command runner; tests never invoke the real cloudflared. */
export type PreflightCommandRunner = (command: string[]) => Promise<CommandOutcome>;

/** Injectable Cloudflare Access apps fetcher (GET /zones/<zone>/access/apps). */
export type AccessAppsFetcher = (input: { apiToken: string; zoneId: string }) => Promise<unknown>;

/** Spawn contract for the loopback health probe (plan Task 36, step 3). */
export interface BridgeHealthProbeInput {
  readonly nodeBin: string;
  readonly bridgeMain: string;
  /** Loopback host the child must bind (validated by loadConfig). */
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  /**
   * How long (ms) to keep waiting after an OK health answer before trusting
   * it, so a child that hits EADDRINUSE has time to die (default 1.5s).
   */
  readonly occupiedGraceMs?: number | undefined;
  /** Child environment; always carries BRIDGE_PREFLIGHT_HEALTH_ONLY=1. */
  readonly env: Record<string, string>;
}

export type BridgeHealthProber = (
  input: BridgeHealthProbeInput,
) => Promise<{ readonly healthy: boolean; readonly detail: string }>;

/** Resolved dependencies for {@link runPreflight}; every seam injectable. */
export interface PreflightDeps {
  readonly env: EnvSource;
  readonly now: () => number;
  readonly fetchJwks: JwksFetcher;
  readonly openDb: (databasePath: string) => SqliteDatabase;
  readonly createAudit: (db: SqliteDatabase, filePath: string, now: () => number) => AuditLog;
  readonly runCommand: PreflightCommandRunner;
  readonly fetchAccessApps: AccessAppsFetcher;
  readonly probeBridgeHealth: BridgeHealthProber;
  /** Stat seam returning raw mode + owner uid of the data dir. */
  readonly statDataDir: (dataDir: string) => { mode: number; uid: number };
  readonly getuid: () => number;
  readonly homeDir: string;
  readonly healthTimeoutMs: number;
  /** Occupied-port grace window for the health probe (default 1.5s). */
  readonly occupiedGraceMs: number;
}

/**
 * Injectable subset of the admin CLI deps (AdminCliDeps is structurally
 * compatible); the Task 36 seams are optional and default to the real
 * implementations in {@link resolvePreflightDeps}.
 */
export interface PreflightDepsInput {
  readonly env: EnvSource;
  readonly now: () => number;
  readonly fetchJwks: JwksFetcher;
  readonly openDb: (databasePath: string) => SqliteDatabase;
  readonly createAudit: (db: SqliteDatabase, filePath: string, now: () => number) => AuditLog;
  readonly runCommand?: PreflightCommandRunner | undefined;
  readonly fetchAccessApps?: AccessAppsFetcher | undefined;
  readonly probeBridgeHealth?: BridgeHealthProber | undefined;
  readonly statDataDir?: ((dataDir: string) => { mode: number; uid: number }) | undefined;
  readonly getuid?: (() => number) | undefined;
  readonly homeDir?: string | undefined;
  readonly healthTimeoutMs?: number | undefined;
  readonly occupiedGraceMs?: number | undefined;
}

/** readString twin of config.ts: trim, empty string counts as unset. */
function readEnvString(env: EnvSource, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function tailOf(text: string, maxLength = 300): string {
  const trimmed = text.trim();
  return trimmed === "" ? "" : trimmed.slice(-maxLength);
}

// ---------------------------------------------------------------------------
// Real implementations of the injectable seams
// ---------------------------------------------------------------------------

/** Real command runner: spawns argv[0] directly; spawn errors surface as code 1. */
export const realPreflightCommandRunner: PreflightCommandRunner = (command) =>
  new Promise<CommandOutcome>((resolveRun) => {
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
    child.on("error", (error: Error) =>
      resolveRun({ code: 1, stdout, stderr: `${stderr}${String(error)}` }),
    );
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });

/**
 * Real Cloudflare Access apps fetcher. The API token is used in the
 * Authorization header only and must never reach a detail string.
 */
export const realFetchAccessApps: AccessAppsFetcher = async ({ apiToken, zoneId }) => {
  const url =
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/access/apps?per_page=100`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${apiToken}` } });
  if (!res.ok) {
    throw new Error(`Cloudflare API responded HTTP ${res.status}`);
  }
  return (await res.json()) as unknown;
};

/**
 * Real health prober (plan Task 36, step 3): spawn `node <bridgeMain>` with
 * BRIDGE_PREFLIGHT_HEALTH_ONLY=1 on the loopback bind, then repeatedly GET
 * /api/v1/health (150ms apart) until it answers, the child exits, or the
 * deadline passes — and finally terminate the child (SIGTERM with a SIGKILL
 * fallback), resolving only after the child is gone.
 *
 * An OK answer alone is not trusted: a pre-existing listener on the port
 * (e.g. the old launchd job during a reinstall) answers in ~ms while the
 * freshly spawned child takes far longer to hit EADDRINUSE and exit, so an
 * immediate liveness check would false-pass. After an OK answer the prober
 * holds an occupied-port grace window ({@link BridgeHealthProbeInput.occupiedGraceMs},
 * default {@link DEFAULT_OCCUPIED_GRACE_MS}) and only reports healthy if the
 * child is STILL alive afterwards; a child that died during the window means
 * another process answered, which is reported as unhealthy.
 */
export const defaultBridgeHealthProber: BridgeHealthProber = async (input) => {
  const child = spawn(input.nodeBin, [input.bridgeMain], {
    env: { ...process.env, ...input.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrTail = "";
  child.stdout?.on("data", () => {}); // drain so the child never blocks
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + String(chunk)).slice(-2000);
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("close", (code) => resolveExit(code));
  });
  const kill = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal);
    } catch {
      // Already gone — nothing to do.
    }
  };
  const stderrNote = (): string => {
    const tail = tailOf(stderrTail, 500);
    return tail === "" ? "" : `; child stderr: ${tail.replace(/\r?\n/g, " | ")}`;
  };

  const url = healthUrl(input.host, input.port);
  const deadline = Date.now() + input.timeoutMs;
  let lastProblem = "no response";
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        return {
          healthy: false,
          detail: `bridge child exited with code ${child.exitCode} before answering ${url}${stderrNote()}`,
        };
      }
      try {
        const res = await fetch(url);
        if (res.ok) {
          let status = "";
          try {
            status = String(((await res.json()) as { status?: unknown }).status ?? "");
          } catch {
            status = "";
          }
          if (status === "ok") {
            // Occupied-port guard: a pre-existing listener (the old launchd
            // job during a reinstall) answers in ~ms while the fresh child
            // needs far longer to hit EADDRINUSE and exit, so the child must
            // STILL be alive after a grace window before this counts as
            // healthy. The race resolves early when the child dies.
            const graceMs = input.occupiedGraceMs ?? DEFAULT_OCCUPIED_GRACE_MS;
            let graceTimer: NodeJS.Timeout | undefined;
            const childSurvived = await Promise.race([
              exited.then(() => false),
              new Promise<true>((resolveGrace) => {
                graceTimer = setTimeout(() => resolveGrace(true), graceMs);
              }),
            ]);
            if (graceTimer !== undefined) clearTimeout(graceTimer);
            if (!childSurvived) {
              return {
                healthy: false,
                detail:
                  `another process on ${input.host}:${input.port} answered ${url}; the spawned bridge exited ` +
                  `with code ${child.exitCode}${stderrNote()}`,
              };
            }
            return {
              healthy: true,
              detail:
                `GET ${url} answered {"status":"ok"} and the child stayed alive through the ` +
                `${graceMs}ms occupied-port grace window (child spawned with BRIDGE_PREFLIGHT_HEALTH_ONLY=1 ` +
                "on the loopback bind; terminated after the probe)",
            };
          }
          lastProblem = `HTTP ${res.status} (body status ${JSON.stringify(status)})`;
        } else {
          lastProblem = `HTTP ${res.status}`;
        }
      } catch (error) {
        lastProblem = (error as Error).message;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }
    return {
      healthy: false,
      detail: `${url} did not answer within ${input.timeoutMs}ms (${lastProblem})${stderrNote()}`,
    };
  } finally {
    kill("SIGTERM");
    // The bridge exits 0 on SIGTERM (spec §11.5); force-kill as a fallback.
    const forceKill = setTimeout(() => kill("SIGKILL"), 3_000);
    await exited;
    clearTimeout(forceKill);
  }
};

/** Fill every optional seam with its real implementation. */
export function resolvePreflightDeps(input: PreflightDepsInput): PreflightDeps {
  return {
    env: input.env,
    now: input.now,
    fetchJwks: input.fetchJwks,
    openDb: input.openDb,
    createAudit: input.createAudit,
    runCommand: input.runCommand ?? realPreflightCommandRunner,
    fetchAccessApps: input.fetchAccessApps ?? realFetchAccessApps,
    probeBridgeHealth: input.probeBridgeHealth ?? defaultBridgeHealthProber,
    statDataDir:
      input.statDataDir ??
      ((dataDir) => {
        const stats = statSync(dataDir);
        return { mode: stats.mode, uid: stats.uid };
      }),
    getuid: input.getuid ?? (() => process.getuid?.() ?? -1),
    homeDir: input.homeDir ?? homedir(),
    healthTimeoutMs: input.healthTimeoutMs ?? 15_000,
    occupiedGraceMs: input.occupiedGraceMs ?? DEFAULT_OCCUPIED_GRACE_MS,
  };
}

// ---------------------------------------------------------------------------
// Check 4 helper — plist containment
// ---------------------------------------------------------------------------

/**
 * Validate that the plist path stays strictly inside
 * `<homeDir>/Library/LaunchAgents` (and is never /Library/LaunchDaemons).
 *
 * This intentionally duplicates the containment rules of
 * deploy/scripts/install-launchd.ts `resolvePlistTarget` (same
 * `/Library${sep}LaunchDaemons` refusal and strict prefix check): the
 * deploy workspace is not importable from the bridge workspace, so the
 * small validation is kept in sync by hand — see install-launchd.test.ts
 * and preflight.test.ts which assert the same outcomes on both sides.
 */
function checkPlistPath(
  homeDir: string,
  plistPath: string,
): { ok: true; detail: string } | { ok: false; detail: string } {
  if (!isAbsolute(plistPath)) {
    return {
      ok: false,
      detail: `BRIDGE_PLIST_PATH must be an absolute path; got ${JSON.stringify(plistPath)}.`,
    };
  }
  const launchAgentsDir = resolve(homeDir, "Library", "LaunchAgents");
  const target = resolve(plistPath);
  if (target.startsWith(`/Library${sep}LaunchDaemons`)) {
    return {
      ok: false,
      detail:
        `${target} points at /Library/LaunchDaemons: the Bridge is a per-user LaunchAgent and must ` +
        "never run as root. Use ~/Library/LaunchAgents.",
    };
  }
  if (target === launchAgentsDir || !target.startsWith(launchAgentsDir + sep)) {
    return {
      ok: false,
      detail: `${target} is outside ${launchAgentsDir}: the launchd installer only writes under ~/Library/LaunchAgents.`,
    };
  }
  return { ok: true, detail: `${target} resolves inside ~/Library/LaunchAgents` };
}

// ---------------------------------------------------------------------------
// Check 6 helpers — Access application identity policy
// ---------------------------------------------------------------------------

interface AccessAppLike {
  readonly aud?: unknown;
  readonly name?: unknown;
  readonly id?: unknown;
  readonly include?: unknown;
  readonly policies?: unknown;
}

/** Accept both the bare-array and the `{ result: [...] }` API envelope. */
function extractAccessApps(body: unknown): AccessAppLike[] | undefined {
  if (Array.isArray(body)) return body as AccessAppLike[];
  if (body !== null && typeof body === "object") {
    const result = (body as { result?: unknown }).result;
    if (Array.isArray(result)) return result as AccessAppLike[];
  }
  return undefined;
}

/** Human-readable app reference for detail strings (never a secret). */
function describeAccessApp(app: AccessAppLike): string {
  const name = typeof app.name === "string" && app.name !== "" ? app.name : undefined;
  const id = typeof app.id === "string" && app.id !== "" ? app.id : undefined;
  if (name !== undefined && id !== undefined) return `"${name}" (${id})`;
  return name ?? id ?? "<unnamed app>";
}

/** Include rules from both the legacy app-level and the nested policies[] shape. */
function collectIncludeRules(app: AccessAppLike): unknown[] {
  const rules: unknown[] = [];
  if (Array.isArray(app.include)) rules.push(...app.include);
  if (Array.isArray(app.policies)) {
    for (const policy of app.policies) {
      if (policy !== null && typeof policy === "object" && Array.isArray((policy as { include?: unknown }).include)) {
        rules.push(...((policy as { include: unknown[] }).include));
      }
    }
  }
  return rules;
}

/** Does one include rule cover the expected subject? (email / everyone) */
function ruleIncludesSubject(rule: unknown, subject: string): boolean {
  if (rule === null || typeof rule !== "object") return false;
  const record = rule as Record<string, unknown>;
  if ("everyone" in record) return true;
  const email = record["email"];
  if (typeof email === "string") return email.toLowerCase() === subject.toLowerCase();
  if (email !== null && typeof email === "object") {
    const inner = (email as Record<string, unknown>)["email"];
    if (typeof inner === "string") return inner.toLowerCase() === subject.toLowerCase();
  }
  return false;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Run every preflight check against {@link PreflightDeps.env} and return the
 * structured report. Check order: configuration (loopback) → data dir →
 * database → audit log → JWKS → plist path → cloudflared tunnel → Access
 * policy subject → bridge health → tunnel-only note.
 */
export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];

  // 1. Loopback-only bind (loadConfig refuses any non-loopback BRIDGE_HOST
  //    and requires BRIDGE_DATA_DIR). Every later check needs the config.
  let config: BridgeConfig;
  try {
    config = loadConfig(deps.env);
    checks.push(
      pass("loopback-bind", `BRIDGE_HOST=${config.host} (loopback only), port ${config.port}`),
    );
  } catch (error) {
    checks.push(fail("loopback-bind", (error as Error).message));
    return {
      ok: false,
      failed: 1,
      checks,
      fatal: "configuration is invalid; later checks skipped",
    };
  }

  // 2. Data dir: 0700 or stronger (no group/other access) AND owned by the
  //    current user. Report only — never chmod/chown.
  try {
    const stats = deps.statDataDir(config.dataDir);
    const mode = stats.mode & 0o777;
    const modeOk = (mode & 0o077) === 0;
    const currentUid = deps.getuid();
    const ownerOk = currentUid < 0 || stats.uid === currentUid;
    if (modeOk && ownerOk) {
      checks.push(
        pass("data-dir", `${config.dataDir} (mode 0${mode.toString(8)}, owner uid ${stats.uid})`),
      );
    } else if (!modeOk) {
      checks.push(
        fail(
          "data-dir",
          `${config.dataDir} has mode ${mode.toString(8).padStart(3, "0")}, expected 0700 ` +
            "(no group/other access)",
        ),
      );
    } else {
      checks.push(
        fail(
          "data-dir",
          `${config.dataDir} is owned by uid ${stats.uid}, expected the current user (uid ${currentUid})`,
        ),
      );
    }
  } catch (error) {
    checks.push(fail("data-dir", `cannot stat ${config.dataDir}: ${(error as Error).message}`));
  }

  // 3. Database opens and migrates cleanly.
  let db: SqliteDatabase | undefined;
  try {
    db = deps.openDb(config.databasePath);
    checks.push(pass("database", `${config.databasePath} opens and migrates cleanly`));
  } catch (error) {
    checks.push(fail("database", (error as Error).message));
  }

  // 4. Audit log opens (creating/rotating is its own concern; no probe write).
  if (db === undefined) {
    checks.push(info("audit-log", "skipped (database unavailable)"));
  } else {
    try {
      deps.createAudit(db, config.auditLogPath, deps.now);
      checks.push(pass("audit-log", `${config.auditLogPath} opens (0600, rotating)`));
    } catch (error) {
      checks.push(fail("audit-log", (error as Error).message));
    } finally {
      db.close();
    }
  }

  // 5. Cloudflare Access JWKS reachability — only when Access is configured.
  //    Only the public certs URL is fetched; assertion material never exists
  //    here, so it can never be logged.
  if (config.cloudflareTeamDomain === undefined) {
    checks.push(
      info(
        "cloudflare-jwks",
        "BRIDGE_CLOUDFLARE_TEAM_DOMAIN not set (local-only bridge); check skipped",
      ),
    );
  } else if (config.cloudflareAud === undefined) {
    checks.push(
      fail(
        "cloudflare-jwks",
        "BRIDGE_CLOUDFLARE_TEAM_DOMAIN is set without BRIDGE_CLOUDFLARE_AUD; " +
          "both are required for Access assertion verification",
      ),
    );
  } else {
    try {
      await deps.fetchJwks(config.cloudflareTeamDomain);
      checks.push(
        pass(
          "cloudflare-jwks",
          `https://${config.cloudflareTeamDomain}/cdn-cgi/access/certs reachable`,
        ),
      );
    } catch (error) {
      checks.push(fail("cloudflare-jwks", `JWKS unreachable: ${(error as Error).message}`));
    }
  }

  // 6. Plist path containment (Task 34's resolvePlistTarget rules, verified
  //    from the bridge side when BRIDGE_PLIST_PATH is provided — the
  //    launchd installer and deploy/scripts/preflight.ts set it).
  const plistPath = readEnvString(deps.env, "BRIDGE_PLIST_PATH");
  if (plistPath === undefined) {
    checks.push(
      info("plist-path", "BRIDGE_PLIST_PATH not set (bridge not installed via launchd); check skipped"),
    );
  } else {
    const outcome = checkPlistPath(deps.homeDir, plistPath);
    checks.push(outcome.ok ? pass("plist-path", outcome.detail) : fail("plist-path", outcome.detail));
  }

  // 7. cloudflared installed and the named tunnel findable. One command
  //    proves both: a missing binary surfaces as a spawn ENOENT failure.
  const tunnelName = readEnvString(deps.env, "BRIDGE_CLOUDFLARE_TUNNEL_NAME");
  if (tunnelName === undefined) {
    checks.push(
      info(
        "cloudflared-tunnel",
        "BRIDGE_CLOUDFLARE_TUNNEL_NAME not set (local-only bridge); check skipped",
      ),
    );
  } else {
    try {
      const result = await deps.runCommand(["cloudflared", "tunnel", "info", tunnelName]);
      if (result.code === 0) {
        checks.push(pass("cloudflared-tunnel", `cloudflared tunnel info ${tunnelName} exited 0`));
      } else {
        const tail = tailOf(result.stderr === "" ? result.stdout : result.stderr);
        if (/ENOENT/i.test(result.stderr)) {
          checks.push(
            fail(
              "cloudflared-tunnel",
              `cloudflared is not installed or not on PATH: install cloudflared to serve the tunnel`,
            ),
          );
        } else {
          checks.push(
            fail(
              "cloudflared-tunnel",
              `cloudflared tunnel info ${tunnelName} exited ${result.code}${tail === "" ? "" : `: ${tail}`}`,
            ),
          );
        }
      }
    } catch (error) {
      checks.push(
        fail(
          "cloudflared-tunnel",
          `cloudflared is not installed or cannot be executed: ${(error as Error).message}`,
        ),
      );
    }
  }

  // 8. The configured Access application's identity policy must include the
  //    configured expected subject. Optional (Task 37 e2e env): runs only
  //    when CF_API_TOKEN + CF_ZONE_ID + CF_EXPECTED_SUBJECT are provided.
  //    The token is used in the Authorization header only and never logged.
  const cfApiToken = readEnvString(deps.env, "CF_API_TOKEN");
  const cfZoneId = readEnvString(deps.env, "CF_ZONE_ID");
  const cfExpectedSubject = readEnvString(deps.env, "CF_EXPECTED_SUBJECT");
  if (cfApiToken === undefined && cfZoneId === undefined && cfExpectedSubject === undefined) {
    checks.push(
      info(
        "access-policy-subject",
        "CF_API_TOKEN/CF_ZONE_ID/CF_EXPECTED_SUBJECT not set; Access policy review skipped",
      ),
    );
  } else if (cfApiToken === undefined || cfZoneId === undefined || cfExpectedSubject === undefined) {
    checks.push(
      fail(
        "access-policy-subject",
        "CF_API_TOKEN, CF_ZONE_ID, and CF_EXPECTED_SUBJECT must be set together to review the " +
          "Access application identity policy",
      ),
    );
  } else if (config.cloudflareAud === undefined) {
    checks.push(
      fail(
        "access-policy-subject",
        "BRIDGE_CLOUDFLARE_AUD is required to identify the Access application whose policy must " +
          "include the expected subject",
      ),
    );
  } else {
    try {
      const apps = extractAccessApps(await deps.fetchAccessApps({ apiToken: cfApiToken, zoneId: cfZoneId }));
      if (apps === undefined) {
        checks.push(
          fail("access-policy-subject", "Cloudflare API response had no parsable application list"),
        );
      } else {
        const app = apps.find(
          (candidate) => candidate.aud === config.cloudflareAud,
        );
        if (app === undefined) {
          checks.push(
            fail(
              "access-policy-subject",
              `no Access application with aud ${config.cloudflareAud} found in the zone; check ` +
                "BRIDGE_CLOUDFLARE_AUD against the Access application",
            ),
          );
        } else if (
          collectIncludeRules(app).some((rule) => ruleIncludesSubject(rule, cfExpectedSubject))
        ) {
          checks.push(
            pass(
              "access-policy-subject",
              `Access app ${describeAccessApp(app)} include policy covers ${cfExpectedSubject}`,
            ),
          );
        } else {
          checks.push(
            fail(
              "access-policy-subject",
              `Access app ${describeAccessApp(app)} policy does not include ${cfExpectedSubject}`,
            ),
          );
        }
      }
    } catch (error) {
      checks.push(fail("access-policy-subject", `Access apps lookup failed: ${(error as Error).message}`));
    }
  }

  // 9. Bridge health: spawn the built entry with BRIDGE_PREFLIGHT_HEALTH_ONLY=1
  //    bound to the loopback host/port, poll GET /api/v1/health until it
  //    answers (plus the occupied-port grace window), terminate the child.
  //    Runs only when a built bridge entry exists — the deploy
  //    launcher / installer always set BRIDGE_MAIN to the dist entry.
  const bridgeMain =
    readEnvString(deps.env, "BRIDGE_MAIN") ??
    // From dist/src/admin/preflight.js this is dist/src/main.js; from src
    // (vitest/tsx) it is src/main.js, which does not exist until built —
    // that is exactly the INFO-skip condition for unbuilt checkouts.
    fileURLToPath(new URL("../main.js", import.meta.url));
  const nodeBin = readEnvString(deps.env, "BRIDGE_NODE_BIN") ?? process.execPath;
  let bridgeMainIsFile = false;
  try {
    bridgeMainIsFile = statSync(bridgeMain).isFile();
  } catch {
    bridgeMainIsFile = false;
  }
  if (!bridgeMainIsFile) {
    checks.push(
      info(
        "bridge-health",
        `no built bridge entry at ${bridgeMain}; build with ` +
          "npm run build -w @claude-remote/bridge to enable the loopback health probe",
      ),
    );
  } else {
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(deps.env)) {
      if (typeof value === "string" && value !== "") childEnv[key] = value;
    }
    childEnv.BRIDGE_PREFLIGHT_HEALTH_ONLY = "1";
    childEnv.BRIDGE_HOST = config.host;
    childEnv.BRIDGE_PORT = String(config.port);
    const probe = await deps.probeBridgeHealth({
      nodeBin,
      bridgeMain,
      host: config.host,
      port: config.port,
      timeoutMs: deps.healthTimeoutMs,
      occupiedGraceMs: deps.occupiedGraceMs,
      env: childEnv,
    });
    checks.push(
      probe.healthy ? pass("bridge-health", probe.detail) : fail("bridge-health", probe.detail),
    );
  }

  // 10. Tunnel-only exposure note: derived from the loopback config above.
  checks.push(
    pass(
      "tunnel-only",
      "bridge binds loopback only; remote exposure must come from the external Cloudflare Tunnel " +
        "(cloudflared runs as a separate process; verified by the cloudflared-tunnel check when configured)",
    ),
  );

  const failed = checks.filter((check) => !check.passed).length;
  return { ok: failed === 0, failed, checks };
}
