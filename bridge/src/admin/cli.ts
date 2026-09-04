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
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import * as qrcodeTerminalModule from "qrcode-terminal";
import { loadConfig, type BridgeConfig, type EnvSource } from "../config.js";
import { migrate, openDatabase, type SqliteDatabase } from "../db/database.js";
import { defaultJwksFetcher, type JwksFetcher } from "../auth/access-jwt-verifier.js";
import { createDeviceAuth, type DeviceAuth } from "../auth/device-auth.js";
import { createAuditLog, type AuditLog } from "../audit/audit-log.js";
import { createProjectRegistry, type ProjectRegistry } from "../projects/project-registry.js";

/** Operator-facing failure: printed as `error: <message>` with a nonzero exit. */
export class AdminCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
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
    .description("check loopback bind, data dir, database, audit log, and Cloudflare Access JWKS reachability")
    .action(async () => {
      let failures = 0;
      const report = (ok: boolean, name: string, info: string): void => {
        failures += ok ? 0 : 1;
        deps.write(`${ok ? "PASS" : "FAIL"}  ${name}: ${info}\n`);
      };

      // 1. Loopback-only bind (loadConfig refuses any non-loopback BRIDGE_HOST
      //    and requires BRIDGE_DATA_DIR). Every later check needs the config.
      let config: BridgeConfig;
      try {
        config = loadConfig(deps.env);
        report(
          true,
          "loopback-bind",
          `BRIDGE_HOST=${config.host} (loopback only), port ${config.port}`,
        );
      } catch (error) {
        report(false, "loopback-bind", (error as Error).message);
        throw new AdminCommandError("preflight failed: configuration is invalid; later checks skipped");
      }

      // 2. Data dir exists with exactly 0700. Report only — never chmod.
      try {
        const mode = statSync(config.dataDir).mode & 0o777;
        if (mode === 0o700) {
          report(true, "data-dir", `${config.dataDir} (mode 0700)`);
        } else {
          report(
            false,
            "data-dir",
            `${config.dataDir} has mode ${mode.toString(8).padStart(3, "0")}, expected 0700`,
          );
        }
      } catch (error) {
        report(false, "data-dir", `cannot stat ${config.dataDir}: ${(error as Error).message}`);
      }

      // 3. Database opens and migrates cleanly.
      let db: SqliteDatabase | undefined;
      try {
        db = deps.openDb(config.databasePath);
        report(true, "database", `${config.databasePath} opens and migrates cleanly`);
      } catch (error) {
        report(false, "database", (error as Error).message);
      }

      // 4. Audit log opens (creating/rotating is its own concern; no probe write).
      if (db === undefined) {
        deps.write("INFO  audit-log: skipped (database unavailable)\n");
      } else {
        try {
          deps.createAudit(db, config.auditLogPath, deps.now);
          report(true, "audit-log", `${config.auditLogPath} opens (0600, rotating)`);
        } catch (error) {
          report(false, "audit-log", (error as Error).message);
        } finally {
          db.close();
        }
      }

      // 5. Cloudflare Access JWKS reachability — only when Access is
      //    configured. The check reports reachable/unreachable and never
      //    logs assertion contents (it only fetches the public certs URL).
      if (config.cloudflareTeamDomain === undefined) {
        deps.write(
          "INFO  cloudflare-jwks: BRIDGE_CLOUDFLARE_TEAM_DOMAIN not set (local-only bridge); check skipped\n",
        );
      } else if (config.cloudflareAud === undefined) {
        report(
          false,
          "cloudflare-jwks",
          "BRIDGE_CLOUDFLARE_TEAM_DOMAIN is set without BRIDGE_CLOUDFLARE_AUD; " +
            "both are required for Access assertion verification",
        );
      } else {
        try {
          await deps.fetchJwks(config.cloudflareTeamDomain);
          report(
            true,
            "cloudflare-jwks",
            `https://${config.cloudflareTeamDomain}/cdn-cgi/access/certs reachable`,
          );
        } catch (error) {
          report(false, "cloudflare-jwks", `JWKS unreachable: ${(error as Error).message}`);
        }
      }

      // 6. Tunnel-only exposure: derived from the loopback config above
      //    (the bridge itself can never expose a non-loopback interface).
      //    Verifying the DEPLOYMENT (connector config, DNS, LAN exposure)
      //    is Task 36's deploy-time preflight.
      report(
        true,
        "tunnel-only",
        "bridge binds loopback only; remote exposure must come from the external " +
          "Cloudflare Tunnel (deploy-time verification: Task 36)",
      );

      if (failures > 0) {
        throw new AdminCommandError(`preflight failed: ${failures} check(s) failed`);
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
      deps.write(`error: ${error.message}\n`);
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
