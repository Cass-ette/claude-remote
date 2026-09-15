import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { createDeviceAuth, type RevocationHooks } from "../../src/auth/device-auth.js";
import { createProjectRegistry } from "../../src/projects/project-registry.js";
import { createAuditLog } from "../../src/audit/audit-log.js";
import { ensureAdminToken } from "../../src/admin/admin-token.js";
import { createAdminReads } from "../../src/admin/admin-reads.js";
import { createAdminServer } from "../../src/admin/api-server.js";

const T0 = 1_000_000_000;

let dir: string;
let db: SqliteDatabase;
let token: string;
let audit: ReturnType<typeof createAuditLog>;
let hookCalls: string[];
let hooks: RevocationHooks;
let app: ReturnType<typeof Fastify> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "admin-api-"));
  db = openDatabase(join(dir, "bridge.db"), { createDir: true });
  migrate(db);
  token = ensureAdminToken(dir).token;
  audit = createAuditLog({ filePath: join(dir, "audit.jsonl"), db, now: () => T0 });
  hookCalls = [];
  hooks = {
    denyPendingPermissions: (id) => { hookCalls.push(`deny:${id}`); },
    closeSockets: (id) => { hookCalls.push(`close:${id}`); },
  };
});
afterEach(async () => {
  await app?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeConfig(publicHost?: string) {
  return { host: "127.0.0.1", port: 43111, adminPort: 43112, dataDir: dir, databasePath: join(dir, "bridge.db"), publicHost } as unknown as Parameters<typeof createAdminServer>[0]["config"];
}

function build(opts: { publicHost?: string; probe?: () => Promise<boolean | null> } = {}) {
  app = createAdminServer({
    config: makeConfig(opts.publicHost),
    token,
    registry: createProjectRegistry(db),
    devices: createDeviceAuth(db, {}),
    audit,
    reads: createAdminReads(db, { databasePath: join(dir, "bridge.db") }),
    revocationHooks: hooks,
    now: () => T0,
    uptimeSeconds: () => 42,
    probePublicHealth: opts.probe ?? (async () => true),
  });
  return app;
}

// `app!` — the helpers only run after build() assigned it; `| undefined` keeps afterEach honest.
function get(path: string) {
  return app!.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${token}` } });
}
function post(path: string, payload?: unknown) {
  return app!.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${token}` }, payload });
}
function del(path: string) {
  return app!.inject({ method: "DELETE", url: path, headers: { authorization: `Bearer ${token}` } });
}
function seedDevice(id = "d1") {
  db.prepare(`INSERT INTO devices (deviceId, publicKeySpki, accessSubject, displayName, pairedAt) VALUES (?, 'k', 'sub', 'Phone', 0)`).run(id);
}

describe("auth", () => {
  it("401s without/with wrong token and rate-limits the audit row", async () => {
    build();
    const no = await app!.inject({ method: "GET", url: "/admin/v1/status" });
    expect(no.statusCode).toBe(401);
    const wrong = await app!.inject({ method: "GET", url: "/admin/v1/status", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
    const rows = db.prepare(`SELECT * FROM audit_events WHERE operationType = 'admin.auth_failed'`).all();
    expect(rows).toHaveLength(1); // second failure inside the 10s window is not re-audited
  });
});

describe("status", () => {
  it("aggregates uptime/reachability/sessions/device", async () => {
    seedDevice();
    db.prepare(`INSERT INTO device_sessions (tokenHash, deviceId, accessSubject, expiresAt, createdAt) VALUES ('t','d1','sub',?,0)`).run(T0 + 600_000);
    const res = await build({ probe: async () => false }).then(() => get("/admin/v1/status"));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uptimeSeconds).toBe(42);
    expect(body.publicReachable).toBe(false);
    expect(body.activeSessions).toBe(0);
    expect(body.device).toMatchObject({ deviceId: "d1", sessionExpiresAt: T0 + 600_000 });
    expect(typeof body.dbSizeBytes).toBe("number");
    expect(typeof body.version).toBe("string");
  });
  it("reports device null and publicReachable null in local-only mode", async () => {
    const res = await build({ probe: async () => null }).then(() => get("/admin/v1/status"));
    expect(res.json().device).toBeNull();
    expect(res.json().publicReachable).toBeNull();
  });
});

describe("projects", () => {
  it("authorizes, lists, deletes; 404 on unknown", async () => {
    build();
    const path = join(dir, "proj"); mkdirSync(path);
    const created = await post("/admin/v1/projects", { path, name: "Proj" });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().projectId;
    expect((await get("/admin/v1/projects")).json()).toHaveLength(1);
    expect((await del(`/admin/v1/projects/${projectId}`)).statusCode).toBe(204);
    expect((await del(`/admin/v1/projects/${projectId}`)).statusCode).toBe(404);
    const audited = db.prepare(`SELECT * FROM audit_events WHERE operationType LIKE 'admin.%'`).all() as Array<{ operationType: string }>;
    expect(audited.map((r) => r.operationType)).toContain("admin.authorize_project");
    expect(audited.map((r) => r.operationType)).toContain("admin.revoke_project");
  });
  it("rejects non-absolute paths with 400", async () => {
    build();
    expect((await post("/admin/v1/projects", { path: "relative", name: "x" })).statusCode).toBe(400);
  });
});

describe("devices", () => {
  it("lists active+revoked, revokes via live hooks in order, 404 unknown", async () => {
    build();
    seedDevice("d1"); seedDevice("d2");
    db.prepare(`UPDATE devices SET revokedAt = 1 WHERE deviceId = 'd2'`).run();
    const list = await get("/admin/v1/devices");
    expect(list.json().active.deviceId).toBe("d1");
    expect(list.json().revoked).toHaveLength(1);
    expect((await post("/admin/v1/devices/d1/revoke")).statusCode).toBe(204);
    expect(hookCalls).toEqual(["deny:d1", "close:d1"]);
    expect((await post("/admin/v1/devices/d1/revoke")).statusCode).toBe(404); // already revoked → unknown active id
  });
  it("revoke-all drains every active device", async () => {
    build();
    seedDevice("d1"); seedDevice("d2");
    expect((await post("/admin/v1/devices/revoke-all")).statusCode).toBe(204);
    expect(hookCalls).toContain("close:d1");
    expect(hookCalls).toContain("close:d2");
  });
});

describe("pairing", () => {
  it("409 public_host_unset when no publicHost", async () => {
    build();
    const res = await post("/admin/v1/pairing/qrcode");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("public_host_unset");
  });
  it("409 already_paired while a device is active, then mints after revoke", async () => {
    build({ publicHost: "bridge.example.com" });
    seedDevice();
    const res = await post("/admin/v1/pairing/qrcode");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("already_paired");
    await post("/admin/v1/devices/revoke-all");
    const ok = await post("/admin/v1/pairing/qrcode");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().payload).toMatch(/^claude-remote:\/\/pair\?host=bridge\.example\.com&token=/);
    expect(ok.json().expiresAt).toBeGreaterThan(T0);
  });
});

describe("logs", () => {
  it("tails the out log, clamps bytes, whitelists file", async () => {
    build();
    mkdirSync(join(dir, "logs"));
    writeFileSync(join(dir, "logs", "bridge.out.log"), "x".repeat(100) + "TAIL");
    const res = await get("/admin/v1/logs/tail?file=out&bytes=4");
    expect(res.json().content).toBe("TAIL");
    const clamp = await get("/admin/v1/logs/tail?file=out&bytes=999999999");
    expect(clamp.statusCode).toBe(200);
    expect((await get("/admin/v1/logs/tail?file=../../../etc/passwd")).statusCode).toBe(400);
    expect((await get("/admin/v1/logs/tail?file=err")).json().content).toBe(""); // missing file → empty
  });
});

describe("audit + sessions routes", () => {
  it("pages audit rows", async () => {
    build();
    for (let i = 0; i < 3; i++) audit.write({ operationType: "op", resultCode: "ok" });
    const res = await get("/admin/v1/audit?limit=2");
    expect(res.json().items).toHaveLength(2);
    expect(res.json().nextCursor).not.toBeNull();
  });
  it("lists sessions", async () => {
    build();
    const res = await get("/admin/v1/sessions");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
