/**
 * Local admin CLI (Task 23, spec §10.4, §10.5).
 *
 * `bridge admin <subcommand>` — operator tooling for authorizing projects,
 * managing paired devices, minting pairing QR codes, and preflight checks.
 * Runs against the same BRIDGE_DATA_DIR as the Bridge server:
 *
 *   BRIDGE_DATA_DIR=/path/to/data npm run -w @claude-remote/bridge -- admin \
 *       admin authorize-project /abs/project "My project"
 *       admin list-projects
 *       admin revoke-project <projectId>
 *       admin list-devices
 *       admin revoke-device <deviceId>
 *       admin revoke-all-devices
 *       admin pairing-qrcode        (requires BRIDGE_PUBLIC_HOST)
 *       admin preflight
 *
 * SECURITY INVARIANTS:
 * - Configuration is shared with the server through loadConfig:
 *   BRIDGE_DATA_DIR is required and BRIDGE_HOST must be loopback; the CLI
 *   itself never binds any interface and never opens a Cloudflare Tunnel
 *   (the connector is a separate process; deploy-time checks are Task 36).
 * - Device revocation from the CLI updates the shared database (device rows,
 *   sessions, challenges) but cannot reach a RUNNING bridge's in-memory
 *   permission broker or open sockets — the revocation hooks passed here are
 *   no-ops by design. Live revocation wiring is Task 24's.
 * - Pairing tokens are shown to the local operator only (console + QR) and
 *   never written to the audit trail.
 * - Every mutating admin operation writes an `admin.*` audit event.
 */
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import * as qrcodeTerminalModule from "qrcode-terminal";
import { loadConfig, type BridgeConfig, type EnvSource } from "../config.js";
import { migrate, openDatabase, type SqliteDatabase } from "../db/database.js";
import { defaultJwksFetcher, type JwksFetcher } from "../auth/access-jwt-verifier.js";
import { createDeviceAuth, type DeviceAuth } from "../auth/device-auth.js";
import { createAuditLog, type AuditLog } from "../audit/audit-log.js";
import { createProjectRegistry, type ProjectRegistry } from "../projects/project-registry.js";
import {
  resolvePreflightDeps,
  runPreflight,
  type AccessAppsFetcher,
  type BridgeHealthProber,
  type PreflightCommandRunner,
} from "./preflight.js";

/**
 * Operator-facing failure: printed as `error: <message>` with a nonzero exit.
 * `silent` suppresses that line — used by `preflight --json` so stdout stays
 * a single parsable JSON document even on failure (the report itself carries
 * the failure detail; the installer parses stdout).
 */
export class AdminCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly silent = false,
  ) {
    super(message);
    this.name = "AdminCommandError";
  }
}

// qrcode-terminal is CommonJS whose named exports Node's ESM-CJS interop
// lexer cannot detect: the functions live on the interop `default`
// (module.exports). Prefer it and fall back to the namespace for a future
// real-ESM build.
const qrcodeTerminal =
  (qrcodeTerminalModule as unknown as { default?: typeof qrcodeTerminalModule }).default ??
  qrcodeTerminalModule;

/** Dependencies of the admin CLI; every one is injectable for tests. */
export interface AdminCliDeps {
  /** Environment read by loadConfig (BRIDGE_DATA_DIR, BRIDGE_HOST, ...). */
  readonly env: EnvSource;
  /** Injected clock (the CLI never reads the wall clock directly). */
  readonly now: () => number;
  /** Opens and migrates the SQLite database. */
  readonly openDb: (databasePath: string) => SqliteDatabase;
  readonly createRegistry: (db: SqliteDatabase) => ProjectRegistry;
  readonly createDevices: (db: SqliteDatabase, deviceSessionTtlSeconds: number) => DeviceAuth;
  readonly createAudit: (db: SqliteDatabase, filePath: string, now: () => number) => AuditLog;
  /** JWKS fetcher used by `preflight` (Cloudflare Access certs endpoint). */
  readonly fetchJwks: JwksFetcher;
  /**
   * Preflight-only seams (Task 36); all optional and defaulted to the real
   * implementations by resolvePreflightDeps so existing constructors stay
   * valid. See ./preflight.ts.
   */
  /** Command runner for the cloudflared tunnel check (default: real spawn). */
  readonly runCommand?: PreflightCommandRunner | undefined;
  /** Cloudflare Access apps fetcher for the identity-policy check (default: real API). */
  readonly fetchAccessApps?: AccessAppsFetcher | undefined;
  /** Bridge health prober (default: spawn the built entry, poll the health endpoint, SIGTERM). */
  readonly probeBridgeHealth?: BridgeHealthProber | undefined;
  /** Stat seam for the data-dir mode/ownership check (default: fs.statSync). */
  readonly statDataDir?: ((dataDir: string) => { mode: number; uid: number }) | undefined;
  /** uid seam for the ownership check (default: process.getuid). */
  readonly getuid?: (() => number) | undefined;
  /** Home directory anchoring the plist-path containment check (default: os.homedir). */
  readonly homeDir?: string | undefined;
  /** Health probe timeout in milliseconds (default: 15000). */
  readonly healthTimeoutMs?: number | undefined;
  /** Occupied-port grace window after an OK health answer, in milliseconds (default: 1500). */
  readonly occupiedGraceMs?: number | undefined;
  /** Renders the pairing payload as printable text (the QR block). */
  readonly renderQr: (payload: string) => string;
  /** Single output sink for every line the CLI prints. */
  readonly write: (text: string) => void;
}

/**
 * Per-invocation context: shared config plus the opened database and the
 * registries built on it. `openAudit` is lazy so read-only commands never
 * create the audit file.
 */
interface AdminContext {
  readonly config: BridgeConfig;
  readonly db: SqliteDatabase;
  readonly registry: ProjectRegistry;
  readonly devices: DeviceAuth;
  openAudit(): AuditLog;
  close(): void;
}

function openAdminContext(deps: AdminCliDeps): AdminContext {
  let config: BridgeConfig;
  try {
    config = loadConfig(deps.env);
  } catch (error) {
    // Includes "BRIDGE_DATA_DIR is required" and the non-loopback BRIDGE_HOST
    // refusal — surfaced as an operator error with exit 1.
    throw new AdminCommandError((error as Error).message);
  }
  let db: SqliteDatabase;
  try {
    db = deps.openDb(config.databasePath);
  } catch (error) {
    throw new AdminCommandError(
      `cannot open database at ${config.databasePath}: ${(error as Error).message}`,
    );
  }
  return {
    config,
    db,
    registry: deps.createRegistry(db),
    devices: deps.createDevices(db, config.deviceSessionTtlSeconds),
    openAudit: () => deps.createAudit(db, config.auditLogPath, deps.now),
    close: () => db.close(),
  };
}

/** Wrap any thrown value as an {@link AdminCommandError} (pass-through if it already is one). */
function toCommandError(error: unknown): AdminCommandError {
  if (error instanceof AdminCommandError) return error;
  return new AdminCommandError(error instanceof Error ? error.message : String(error));
}

/**
 * No-op revocation hooks: in the CLI context no permission broker or
 * WebSocket server is running. The database-level effects (device row,
 * sessions, challenges) still apply; revoking against a running bridge's
 * live state is Task 24's wiring.
 */
const CLI_REVOCATION_HOOKS = {
  denyPendingPermissions: () => {},
  closeSockets: () => {},
} as const;

export function buildAdminProgram(deps: AdminCliDeps): Command {
  const program = new Command();
  program
    .name("bridge")
    .description("Claude Remote Bridge local admin (spec §10.4, §10.5)")
    .usage("admin <command> [options]");

  const admin = program
    .command("admin")
    .description("local administration against BRIDGE_DATA_DIR");

  admin
    .command("authorize-project")
    .description("authorize a project directory")
    .argument("<path>", "absolute path of the project root (must not be a symlink)")
    .argument("<displayName>", "human-readable project name")
    .action(async (rawPath: string, displayName: string) => {
      const ctx = openAdminContext(deps);
      try {
        const record = ctx.registry.authorize(rawPath, displayName, { now: deps.now() });
        ctx.openAudit().write({
          operationType: "admin.authorize_project",
          projectId: record.projectId,
          resultCode: "ok",
          detail: { displayName: record.displayName },
          committed: true,
        });
        deps.write(`authorized project ${record.projectId}\n`);
        deps.write(`  name: ${record.displayName}\n`);
        deps.write(`  path: ${record.canonicalRealpath}\n`);
      } catch (error) {
        throw toCommandError(error);
      } finally {
        ctx.close();
      }
    });

  admin
    .command("list-projects")
    .description("list authorized projects")
    .action(async () => {
      const ctx = openAdminContext(deps);
      try {
        const projects = ctx.registry.list();
        if (projects.length === 0) {
          deps.write("no authorized projects\n");
          return;
        }
        deps.write(`${projects.length} authorized project(s):\n`);
        for (const project of projects) {
          deps.write(`${project.projectId}  ${project.displayName}  ${project.canonicalRealpath}\n`);
        }
      } finally {
        ctx.close();
      }
    });

  admin
    .command("revoke-project")
    .description("de-authorize a project")
    .argument("<projectId>", "projectId from list-projects")
    .action(async (projectId: string) => {
      const ctx = openAdminContext(deps);
      try {
        const existing = ctx.registry.get(projectId);
        if (existing === undefined) {
          throw new AdminCommandError(`unknown projectId ${projectId}`);
        }
        ctx.registry.remove(projectId);
        ctx.openAudit().write({
          operationType: "admin.revoke_project",
          projectId,
          resultCode: "ok",
          committed: true,
        });
        deps.write(`revoked project ${projectId} (${existing.displayName})\n`);
      } catch (error) {
        throw toCommandError(error);
      } finally {
        ctx.close();
      }
    });

  admin
    .command("list-devices")
    .description("list paired devices")
    .action(async () => {
      const ctx = openAdminContext(deps);
      try {
        const devices = ctx.devices.listDevices();
        if (devices.length === 0) {
          deps.write("no paired devices\n");
          return;
        }
        deps.write(`${devices.length} device(s):\n`);
        for (const device of devices) {
          const status =
            device.revokedAt === null
              ? "active"
              : `revoked ${new Date(device.revokedAt).toISOString()}`;
          deps.write(
            `${device.deviceId}  ${device.displayName}  ` +
              `paired ${new Date(device.pairedAt).toISOString()}  ${status}\n`,
          );
        }
      } finally {
        ctx.close();
      }
    });

  admin
    .command("revoke-device")
    .description("revoke a paired device (sessions and challenges are deleted)")
    .argument("<deviceId>", "deviceId from list-devices")
    .action(async (deviceId: string) => {
      const ctx = openAdminContext(deps);
      try {
        const device = ctx.devices.listDevices().find((d) => d.deviceId === deviceId);
        if (device === undefined) {
          throw new AdminCommandError(`unknown device ${deviceId}`);
        }
        if (device.revokedAt !== null) {
          throw new AdminCommandError(`device ${deviceId} is already revoked`);
        }
        ctx.devices.revokeDevice(deviceId, deps.now(), CLI_REVOCATION_HOOKS);
        ctx.openAudit().write({
          operationType: "admin.revoke_device",
          deviceId,
          resultCode: "ok",
          committed: true,
        });
        deps.write(`revoked device ${deviceId} (${device.displayName})\n`);
        deps.write(
          "note: a running bridge may keep its in-memory state and open sockets until " +
            "its next check; live revocation is the server-side path.\n",
        );
      } catch (error) {
        throw toCommandError(error);
      } finally {
        ctx.close();
      }
    });

  admin
    .command("revoke-all-devices")
    .description("revoke every non-revoked paired device")
    .action(async () => {
      const ctx = openAdminContext(deps);
      try {
        const active = ctx.devices.listDevices().filter((d) => d.revokedAt === null);
        if (active.length === 0) {
          deps.write("no active devices\n");
          return;
        }
        for (const device of active) {
          ctx.devices.revokeDevice(device.deviceId, deps.now(), CLI_REVOCATION_HOOKS);
          ctx.openAudit().write({
            operationType: "admin.revoke_device",
            deviceId: device.deviceId,
            resultCode: "ok",
            committed: true,
          });
          deps.write(`revoked device ${device.deviceId} (${device.displayName})\n`);
        }
        deps.write(`revoked ${active.length} device(s)\n`);
      } catch (error) {
        throw toCommandError(error);
      } finally {
        ctx.close();
      }
    });

  admin
    .command("pairing-qrcode")
    .description(
      "mint a fresh five-minute single-use pairing token and print it with a QR code " +
        "(requires BRIDGE_PUBLIC_HOST)",
    )
    .action(async () => {
      const ctx = openAdminContext(deps);
      try {
        const host = ctx.config.publicHost;
        if (host === undefined) {
          throw new AdminCommandError(
            "BRIDGE_PUBLIC_HOST is required: set it to the Bridge's public hostname " +
              "(the Cloudflare Tunnel address devices reach, e.g. bridge.example.com) " +
              "before generating a pairing QR code",
          );
        }
        const { token, expiresAt } = ctx.devices.mintPairingToken(deps.now());
        const payload = `claude-remote://pair?host=${encodeURIComponent(host)}&token=${encodeURIComponent(token)}`;
        // Audited WITHOUT the token — only its existence and the target host.
        ctx.openAudit().write({
          operationType: "admin.mint_pairing_token",
          resultCode: "ok",
          detail: { host },
          committed: true,
        });
        deps.write(`host: ${host}\n`);
        deps.write(`token: ${token}\n`);
        deps.write(`expires: ${new Date(expiresAt).toISOString()} (five minutes, single use)\n`);
        deps.write(`${deps.renderQr(payload)}\n`);
      } catch (error) {
        throw toCommandError(error);
      } finally {
        ctx.close();
      }
    });

  admin
    .command("preflight")
    .description(
      "self-check before exposing the bridge: loopback bind, data dir (mode+owner), database, " +
        "audit log, Cloudflare Access JWKS, launchd plist containment, cloudflared tunnel, " +
        "Access identity policy, and a loopback /api/v1/health probe of the built entry",
    )
    .option("--json", "emit the structured report as a single JSON document (for the launchd installer)")
    .action(async (options: { json?: boolean }) => {
      const preflightReport = await runPreflight(resolvePreflightDeps(deps));
      if (options.json === true) {
        // Machine mode: stdout is exactly one JSON document — no trailing
        // error line, secrets never appear in check details.
        deps.write(`${JSON.stringify(preflightReport, null, 2)}\n`);
        if (!preflightReport.ok) {
          throw new AdminCommandError(
            `preflight failed: ${preflightReport.failed} check(s) failed`,
            1,
            true,
          );
        }
        return;
      }
      const label = { pass: "PASS", fail: "FAIL", info: "INFO" } as const;
      for (const check of preflightReport.checks) {
        deps.write(`${label[check.status]}  ${check.name}: ${check.details}\n`);
      }
      if (!preflightReport.ok) {
        const reason =
          preflightReport.fatal !== undefined
            ? preflightReport.fatal
            : `${preflightReport.failed} check(s) failed`;
        throw new AdminCommandError(`preflight failed: ${reason}`);
      }
    });

  // Route commander's own output (help, usage errors) through the injected
  // writer and replace process.exit with a thrown CommanderError so tests
  // survive commander-generated failures. Applied to every declared command.
  const capture = (cmd: Command): void => {
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: deps.write, writeErr: deps.write });
    for (const child of cmd.commands) capture(child);
  };
  capture(program);

  return program;
}

/**
 * Parse and run the admin CLI against `argv` (user-style, i.e. without the
 * node/script prefix). Returns the process exit code; never calls exit.
 */
export async function runAdminCli(
  argv: string[],
  deps: AdminCliDeps = realAdminCliDeps(),
): Promise<number> {
  const program = buildAdminProgram(deps);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof AdminCommandError) {
      if (!error.silent) {
        deps.write(`error: ${error.message}\n`);
      }
      return error.exitCode;
    }
    if (error instanceof CommanderError) {
      // commander already printed the message through the configured writer.
      return error.exitCode;
    }
    deps.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Production dependencies: real database, registries, JWKS fetch, QR render, stdout. */
export function realAdminCliDeps(): AdminCliDeps {
  return {
    env: process.env,
    now: () => Date.now(),
    openDb: (databasePath) => {
      const db = openDatabase(databasePath, { createDir: false });
      migrate(db);
      return db;
    },
    createRegistry: (db) => createProjectRegistry(db),
    createDevices: (db, deviceSessionTtlSeconds) =>
      createDeviceAuth(db, { deviceSessionTtlSeconds }),
    createAudit: (db, filePath, now) => createAuditLog({ filePath, db, now }),
    fetchJwks: defaultJwksFetcher,
    renderQr: (payload) => {
      let rendered = "";
      qrcodeTerminal.generate(payload, { small: true }, (qrcode) => {
        rendered = qrcode;
      });
      return rendered;
    },
    write: (text) => {
      process.stdout.write(text);
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runAdminCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
