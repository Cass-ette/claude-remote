/**
 * Admin CLI tests (Task 23, spec §10.4, §10.5).
 *
 * Tests drive the commander program through runAdminCli with a temporary
 * BRIDGE_DATA_DIR and fully injected dependencies (clock, JWKS fetcher, QR
 * renderer, output writer) and assert the exit code, captured output,
 * database state, and audit rows.
 */
import { generateKeyPairSync, createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { createDeviceAuth, deviceIdFromSpki } from "../../src/auth/device-auth.js";
import { createProjectRegistry } from "../../src/projects/project-registry.js";
import { createAuditLog } from "../../src/audit/audit-log.js";
import { runAdminCli, type AdminCliDeps } from "../../src/admin/cli.js";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const B64U_32BYTES = /[A-Za-z0-9_-]{43}/;

let dataDir: string;
let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "admin-cli-test-"));
  dataDir = join(tempRoot, "data");
  // seedDevice/withDb open the database before the first CLI run would
  // create the directory via loadConfig.
  mkdirSync(dataDir, { mode: 0o700 });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeDeps(
  envExtra: Record<string, string> = {},
  overrides: Partial<AdminCliDeps> = {},
): { deps: AdminCliDeps; output: () => string } {
  const chunks: string[] = [];
  const deps: AdminCliDeps = {
    env: { BRIDGE_DATA_DIR: dataDir, ...envExtra },
    now: () => T0,
    openDb: (databasePath) => {
      const db = openDatabase(databasePath, { createDir: false });
      migrate(db);
      return db;
    },
    createRegistry: (db) => createProjectRegistry(db),
    createDevices: (db, deviceSessionTtlSeconds) =>
      createDeviceAuth(db, { deviceSessionTtlSeconds }),
    createAudit: (db, filePath, now) => createAuditLog({ filePath, db, now }),
    fetchJwks: async () => {
      throw new Error("fetchJwks not stubbed for this test");
    },
    renderQr: (payload) => `<QR>${payload}</QR>`,
    write: (text) => {
      chunks.push(text);
    },
    ...overrides,
  };
  return { deps, output: () => chunks.join("") };
}

function run(argv: string[], deps: AdminCliDeps): Promise<number> {
  return runAdminCli(argv, deps);
}

/** Reopen the CLI's database and read state; migrations are idempotent. */
function withDb<T>(fn: (db: SqliteDatabase) => T): T {
  const db = openDatabase(join(dataDir, "bridge.db"), { createDir: false });
  try {
    migrate(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function makeProjectDir(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir);
  return dir;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Seed a paired device directly through the device-auth module. */
function seedDevice(options: { displayName?: string; revoke?: boolean } = {}): { deviceId: string } {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const deviceId = deviceIdFromSpki(spki);
  const db = openDatabase(join(dataDir, "bridge.db"), { createDir: false });
  try {
    migrate(db);
    const auth = createDeviceAuth(db);
    const { token } = auth.mintPairingToken(T0);
    auth.pairWithToken({
      pairingToken: token,
      publicKeySpkiB64u: spki.toString("base64url"),
      deviceId,
      accessSubject: "user@example.com",
      displayName: options.displayName ?? "Pixel 9",
      now: T0,
    });
    if (options.revoke) {
      auth.revokeDevice(deviceId, T0 + 1, {
        denyPendingPermissions: () => {},
        closeSockets: () => {},
      });
    }
  } finally {
    db.close();
  }
  return { deviceId };
}

// ---------------------------------------------------------------------------
// environment guards (shared with the server via loadConfig)
// ---------------------------------------------------------------------------

describe("environment guards", () => {
  it("fails any command when BRIDGE_DATA_DIR is missing", async () => {
    const { deps, output } = makeDeps({}, { env: {} });
    const code = await run(["admin", "list-projects"], deps);
    expect(code).toBe(1);
    expect(output()).toContain("BRIDGE_DATA_DIR");
  });

  it("refuses a non-loopback BRIDGE_HOST", async () => {
    const { deps, output } = makeDeps({ BRIDGE_HOST: "0.0.0.0" });
    const code = await run(["admin", "list-projects"], deps);
    expect(code).toBe(1);
    expect(output()).toContain("loopback");
  });
});

// ---------------------------------------------------------------------------
// authorize-project / list-projects / revoke-project
// ---------------------------------------------------------------------------

describe("authorize-project", () => {
  it("authorizes a project, prints the projectId, and audits admin.authorize_project", async () => {
    const dir = makeProjectDir("alpha");
    const { deps, output } = makeDeps();
    const code = await run(["admin", "authorize-project", dir, "Alpha"], deps);
    expect(code).toBe(0);

    const text = output();
    const projectId = UUID.exec(text)?.[0];
    expect(projectId).toBeDefined();
    expect(text).toContain(`authorized project ${projectId}`);
    expect(text).toContain(realpathSync.native(dir));

    withDb((db) => {
      const row = db.prepare("SELECT * FROM projects WHERE projectId = ?").get(projectId) as {
        displayName: string;
        canonicalRealpath: string;
      } | undefined;
      expect(row?.displayName).toBe("Alpha");
      expect(row?.canonicalRealpath).toBe(realpathSync.native(dir));
      const audit = db
        .prepare("SELECT * FROM audit_events WHERE operationType = 'admin.authorize_project'")
        .all() as { projectId: string; resultCode: string }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ projectId, resultCode: "ok" });
    });
  });

  it("rejects a symlink project root with exit 1 and no DB row", async () => {
    const dir = makeProjectDir("beta");
    const link = join(tempRoot, "beta-link");
    symlinkSync(dir, link);
    const { deps, output } = makeDeps();
    const code = await run(["admin", "authorize-project", link, "Beta"], deps);
    expect(code).toBe(1);
    expect(output()).toContain("symlink");
    expect(
      withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }),
    ).toEqual({ n: 0 });
  });

  it("rejects authorizing the same canonical path twice", async () => {
    const dir = makeProjectDir("gamma");
    const { deps, output } = makeDeps();
    await run(["admin", "authorize-project", dir, "Gamma"], deps);
    const code = await run(["admin", "authorize-project", dir, "Gamma again"], deps);
    expect(code).toBe(1);
    expect(output()).toContain("already authorized");
    expect(
      withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }),
    ).toEqual({ n: 1 });
  });
});

describe("list-projects", () => {
  it("lists authorized project ids, names, and canonical paths", async () => {
    const dir = makeProjectDir("delta");
    const { deps, output } = makeDeps();
    await run(["admin", "authorize-project", dir, "Delta"], deps);
    const projectId = withDb(
      (db) => (db.prepare("SELECT projectId FROM projects").get() as { projectId: string }).projectId,
    );

    const code = await run(["admin", "list-projects"], deps);
    expect(code).toBe(0);
    const text = output();
    expect(text).toContain("1 authorized project(s)");
    expect(text).toContain(projectId);
    expect(text).toContain("Delta");
    expect(text).toContain(realpathSync.native(dir));
  });

  it("prints a hint when no projects are authorized", async () => {
    const { deps, output } = makeDeps();
    const code = await run(["admin", "list-projects"], deps);
    expect(code).toBe(0);
    expect(output()).toContain("no authorized projects");
  });
});

describe("revoke-project", () => {
  it("revokes an authorized project and audits admin.revoke_project", async () => {
    const dir = makeProjectDir("epsilon");
    const { deps, output } = makeDeps();
    await run(["admin", "authorize-project", dir, "Epsilon"], deps);
    const projectId = withDb(
      (db) => (db.prepare("SELECT projectId FROM projects").get() as { projectId: string }).projectId,
    );

    const code = await run(["admin", "revoke-project", projectId], deps);
    expect(code).toBe(0);
    expect(output()).toContain(`revoked project ${projectId}`);

    withDb((db) => {
      expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).toEqual({
        n: 0,
      });
      const audit = db
        .prepare("SELECT * FROM audit_events WHERE operationType = 'admin.revoke_project'")
        .all() as { projectId: string; resultCode: string }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ projectId, resultCode: "ok" });
    });
  });

  it("fails on an unknown projectId", async () => {
    const { deps, output } = makeDeps();
    const code = await run(
      ["admin", "revoke-project", "0b7b7f2e-1111-4222-8333-444455556666"],
      deps,
    );
    expect(code).toBe(1);
    expect(output()).toContain("unknown projectId");
  });
});

// ---------------------------------------------------------------------------
// list-devices / revoke-device / revoke-all-devices
// ---------------------------------------------------------------------------

describe("list-devices", () => {
  it("lists paired devices with pairing and revocation status", async () => {
    const { deviceId } = seedDevice({ displayName: "Pixel 9" });
    const { deps, output } = makeDeps();
    const code = await run(["admin", "list-devices"], deps);
    expect(code).toBe(0);
    const text = output();
    expect(text).toContain(deviceId);
    expect(text).toContain("Pixel 9");
    expect(text).toContain("active");
  });

  it("marks revoked devices", async () => {
    const { deviceId } = seedDevice({ revoke: true });
    const { deps, output } = makeDeps();
    const code = await run(["admin", "list-devices"], deps);
    expect(code).toBe(0);
    expect(output()).toContain(deviceId);
    expect(output()).toContain("revoked");
  });

  it("prints a hint when no devices are paired", async () => {
    const { deps, output } = makeDeps();
    const code = await run(["admin", "list-devices"], deps);
    expect(code).toBe(0);
    expect(output()).toContain("no paired devices");
  });
});

describe("revoke-device", () => {
  it("revokes a device, clears its sessions, and audits admin.revoke_device", async () => {
    const { deviceId } = seedDevice();
    const { deps, output } = makeDeps();
    const code = await run(["admin", "revoke-device", deviceId], deps);
    expect(code).toBe(0);
    expect(output()).toContain(`revoked device ${deviceId}`);

    withDb((db) => {
      expect(
        db.prepare("SELECT revokedAt FROM devices WHERE deviceId = ?").get(deviceId) as {
          revokedAt: number;
        },
      ).toEqual({ revokedAt: T0 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM device_sessions WHERE deviceId = ?")
          .get(deviceId) as { n: number },
      ).toEqual({ n: 0 });
      const audit = db
        .prepare("SELECT * FROM audit_events WHERE operationType = 'admin.revoke_device'")
        .all() as { deviceId: string; resultCode: string }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ deviceId, resultCode: "ok" });
    });
  });

  it("fails on an unknown device", async () => {
    const { deps, output } = makeDeps();
    const code = await run(["admin", "revoke-device", "not-a-device"], deps);
    expect(code).toBe(1);
    expect(output()).toContain("unknown device");
  });

  it("fails when the device is already revoked", async () => {
    const { deviceId } = seedDevice({ revoke: true });
    const { deps, output } = makeDeps();
    const code = await run(["admin", "revoke-device", deviceId], deps);
    expect(code).toBe(1);
    expect(output()).toContain("already revoked");
  });
});

describe("revoke-all-devices", () => {
  it("revokes every non-revoked device and leaves revoked ones untouched", async () => {
    const old = seedDevice({ displayName: "Old", revoke: true });
    const current = seedDevice({ displayName: "New" });
    const { deps, output } = makeDeps();
    const code = await run(["admin", "revoke-all-devices"], deps);
    expect(code).toBe(0);
    const text = output();
    expect(text).toContain(`revoked device ${current.deviceId}`);
    expect(text).toContain("revoked 1 device");

    withDb((db) => {
      expect(
        db.prepare("SELECT revokedAt FROM devices WHERE deviceId = ?").get(current.deviceId) as {
          revokedAt: number;
        },
      ).toEqual({ revokedAt: T0 });
      expect(
        db.prepare("SELECT revokedAt FROM devices WHERE deviceId = ?").get(old.deviceId) as {
          revokedAt: number;
        },
      ).toEqual({ revokedAt: T0 + 1 });
    });
  });

  it("prints a hint when there is no active device", async () => {
    seedDevice({ revoke: true });
    const { deps, output } = makeDeps();
    const code = await run(["admin", "revoke-all-devices"], deps);
    expect(code).toBe(0);
    expect(output()).toContain("no active devices");
  });
});

// ---------------------------------------------------------------------------
// pairing-qrcode
// ---------------------------------------------------------------------------

describe("pairing-qrcode", () => {
  it("mints a five-minute single-use token and prints the QR of the pairing URI", async () => {
    const { deps, output } = makeDeps({ BRIDGE_PUBLIC_HOST: "bridge.example.com" });
    const code = await run(["admin", "pairing-qrcode"], deps);
    expect(code).toBe(0);

    const text = output();
    expect(text).toContain("bridge.example.com");
    const token = B64U_32BYTES.exec(text)?.[0];
    expect(token).toBeDefined();
    expect(text).toContain(`claude-remote://pair?host=bridge.example.com&token=${token}`);

    withDb((db) => {
      const rows = db
        .prepare("SELECT tokenHash, expiresAt, consumedAt FROM pairing_tokens")
        .all() as { tokenHash: string; expiresAt: number; consumedAt: number | null }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        tokenHash: sha256Hex(token as string),
        expiresAt: T0 + 300_000,
        consumedAt: null,
      });
      const audit = db
        .prepare("SELECT * FROM audit_events WHERE operationType = 'admin.mint_pairing_token'")
        .all() as { redactedDetail: string | null; deviceId: string | null }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]?.deviceId).toBeNull();
      // The raw token never reaches the audit trail.
      expect(audit[0]?.redactedDetail).not.toContain(token as string);
    });
  });

  it("refuses without BRIDGE_PUBLIC_HOST and mints nothing", async () => {
    const { deps, output } = makeDeps();
    const code = await run(["admin", "pairing-qrcode"], deps);
    expect(code).toBe(1);
    expect(output()).toContain("BRIDGE_PUBLIC_HOST");
    expect(
      withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM pairing_tokens").get() as { n: number }),
    ).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

describe("preflight", () => {
  it("passes all checks on a healthy local-only data dir", async () => {
    const { deps, output } = makeDeps();
    const code = await run(["admin", "preflight"], deps);
    expect(code).toBe(0);
    const text = output();
    expect(text).toContain("PASS  loopback-bind: BRIDGE_HOST=127.0.0.1 (loopback only)");
    expect(text).toContain("PASS  data-dir:");
    expect(text).toContain("PASS  database:");
    expect(text).toContain("PASS  audit-log:");
    expect(text).toContain("INFO  cloudflare-jwks:");
    expect(text).toContain("PASS  tunnel-only:");
    expect(text).not.toContain("FAIL");
  });

  it("verifies Cloudflare Access JWKS reachability when Access is configured", async () => {
    const fetched: string[] = [];
    const { deps, output } = makeDeps(
      {
        BRIDGE_CLOUDFLARE_TEAM_DOMAIN: "myteam.cloudflareaccess.com",
        BRIDGE_CLOUDFLARE_AUD: "deadbeef-tag",
      },
      {
        fetchJwks: async (teamDomain) => {
          fetched.push(teamDomain);
          return { keys: [] };
        },
      },
    );
    const code = await run(["admin", "preflight"], deps);
    expect(code).toBe(0);
    expect(fetched).toEqual(["myteam.cloudflareaccess.com"]);
    expect(output()).toContain(
      "PASS  cloudflare-jwks: https://myteam.cloudflareaccess.com/cdn-cgi/access/certs reachable",
    );
  });

  it("fails when the team JWKS endpoint is unreachable but keeps other checks green", async () => {
    const { deps, output } = makeDeps(
      {
        BRIDGE_CLOUDFLARE_TEAM_DOMAIN: "myteam.cloudflareaccess.com",
        BRIDGE_CLOUDFLARE_AUD: "deadbeef-tag",
      },
      {
        fetchJwks: async () => {
          throw new Error("JWKS fetch failed: HTTP 503");
        },
      },
    );
    const code = await run(["admin", "preflight"], deps);
    expect(code).toBe(1);
    const text = output();
    expect(text).toContain("FAIL  cloudflare-jwks: JWKS unreachable: JWKS fetch failed: HTTP 503");
    expect(text).toContain("PASS  database:");
    expect(text).toContain("error: preflight failed: 1 check(s) failed");
  });

  it("fails when the team domain is configured without an AUD tag", async () => {
    const { deps, output } = makeDeps(
      { BRIDGE_CLOUDFLARE_TEAM_DOMAIN: "myteam.cloudflareaccess.com" },
      {
        fetchJwks: async () => {
          throw new Error("fetchJwks must not be called without an AUD tag");
        },
      },
    );
    const code = await run(["admin", "preflight"], deps);
    expect(code).toBe(1);
    const text = output();
    expect(text).toContain("FAIL  cloudflare-jwks:");
    expect(text).toContain("BRIDGE_CLOUDFLARE_AUD");
  });

  it("stops after the configuration check on a non-loopback BRIDGE_HOST", async () => {
    const { deps, output } = makeDeps({ BRIDGE_HOST: "0.0.0.0" });
    const code = await run(["admin", "preflight"], deps);
    expect(code).toBe(1);
    const text = output();
    expect(text).toContain("FAIL  loopback-bind:");
    expect(text).toContain("configuration is invalid");
    expect(text).not.toContain("PASS  database:");
  });

  it("fails when the data dir permissions are not 0700", async () => {
    const { deps, output } = makeDeps();
    chmodSync(dataDir, 0o755);
    const code = await run(["admin", "preflight"], deps);
    expect(code).toBe(1);
    const text = output();
    expect(text).toContain("FAIL  data-dir:");
    expect(text).toMatch(/expected 0700/);
  });

  it("fails and skips the audit check when the database cannot be opened", async () => {
    const { deps, output } = makeDeps(
      {},
      {
        openDb: () => {
          throw new Error("disk I/O error");
        },
      },
    );
    const code = await run(["admin", "preflight"], deps);
    expect(code).toBe(1);
    const text = output();
    expect(text).toContain("FAIL  database: disk I/O error");
    expect(text).toContain("INFO  audit-log: skipped (database unavailable)");
  });
});
