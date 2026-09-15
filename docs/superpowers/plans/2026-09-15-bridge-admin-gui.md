# Bridge Admin GUI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Mac operator a menu-bar GUI (project/device/pairing management, status panel, log/audit viewing) backed by a loopback-only admin API inside the bridge process — per spec `docs/superpowers/specs/2026-09-15-bridge-admin-gui-design.md`.

**Architecture:** The bridge (Node/Fastify) gains a second Fastify instance bound to `127.0.0.1:43112` (`BRIDGE_ADMIN_PORT`), never proxied by cloudflared, guarded by a bearer token stored 0600 in `<dataDir>/admin-api-token`. A SwiftUI menu-bar app (`macos/BridgeBar`, SwiftPM executable + bundle script, zero third-party deps) is a thin polling client of that API. Device revocation from the GUI reuses the bridge's live revocation hooks (deny pending permissions → close sockets → DB already committed inside `devices.revokeDevice`).

**Tech Stack:** TypeScript (NodeNext, Fastify 5, better-sqlite3, vitest) for the bridge; Swift 6 / SwiftUI (`MenuBarExtra`, `@Observable`, `CIQRCodeGenerator`, `SMAppService`) with `swift build`/`swift test` for the app.

**Verification commands used throughout:**
- Bridge: `npm test -w @claude-remote/bridge` (or targeted `npx vitest run test/admin/...`), `npm run typecheck -w @claude-remote/bridge`
- App: `cd macos/BridgeBar && swift test`, `swift build -c release`
- No commits carry Co-Authored-By lines (user rule).

---

## File Structure

```
bridge/src/config.ts                        Modify: +adminPort, export port parsing
bridge/src/admin/admin-token.ts             Create: token file lifecycle + constant-time verify
bridge/src/admin/admin-reads.ts             Create: read-only queries (audit page, sessions, counts, expiry, db size)
bridge/src/admin/api-server.ts              Create: admin Fastify instance + routes + bearer hook
bridge/src/main.ts                          Modify: extract named revocation hooks, start/stop admin server, expose on Runtime
bridge/test/admin/admin-token.test.ts       Create
bridge/test/admin/admin-reads.test.ts       Create
bridge/test/admin/api-server.test.ts        Create
bridge/test/main.smoke.test.ts              Modify: admin server smoke assertions
bridge/test/config.test.ts                  Modify: adminPort parsing
docs/operations/deploy.md                   Modify: admin API + GUI notes

macos/BridgeBar/Package.swift               Create: SwiftPM package (executable + tests)
macos/BridgeBar/README.md                   Create: how to run/test/bundle
macos/BridgeBar/scripts/make-app.sh         Create: release build → BridgeBar.app (LSUIElement) → ad-hoc sign
macos/BridgeBar/Sources/BridgeBar/BridgeBarApp.swift        @main MenuBarExtra app
macos/BridgeBar/Sources/BridgeBar/Core/AdminModels.swift    Codable DTOs
macos/BridgeBar/Sources/BridgeBar/Core/AdminClient.swift    actor: URLSession + token + error normalization
macos/BridgeBar/Sources/BridgeBar/Core/Backoff.swift        pure backoff math
macos/BridgeBar/Sources/BridgeBar/Core/IconState.swift      status → menu icon mapping
macos/BridgeBar/Sources/BridgeBar/Core/StatusStore.swift    @Observable polling store
macos/BridgeBar/Sources/BridgeBar/Views/MenuPanelView.swift dropdown panel
macos/BridgeBar/Sources/BridgeBar/Views/PairingSheet.swift  QR sheet (CoreImage)
macos/BridgeBar/Sources/BridgeBar/Views/MainWindow.swift    TabView shell + 5 tabs
macos/BridgeBar/Sources/BridgeBar/Views/SettingsView.swift  paths, base URL, login item
macos/BridgeBar/Tests/BridgeBarTests/*.swift                Backoff/IconState/AdminModels/AdminClient tests
```

## Chunk 1: Bridge Admin API

### Task 1: config — `adminPort` + reusable port parsing

**Files:**
- Modify: `bridge/src/config.ts`
- Test: `bridge/test/config.test.ts`

- [ ] **Step 1: Write failing tests** (append to `bridge/test/config.test.ts`)

```ts
describe("adminPort", () => {
  it("defaults to 43112", () => {
    const cfg = loadConfig({ BRIDGE_DATA_DIR: "/tmp/x" });
    expect(cfg.adminPort).toBe(43112);
  });
  it("reads BRIDGE_ADMIN_PORT", () => {
    const cfg = loadConfig({ BRIDGE_DATA_DIR: "/tmp/x", BRIDGE_ADMIN_PORT: "50000" });
    expect(cfg.adminPort).toBe(50000);
  });
  it("rejects garbage and privileged ports", () => {
    expect(() => loadConfig({ BRIDGE_DATA_DIR: "/tmp/x", BRIDGE_ADMIN_PORT: "nope" })).toThrow(/BRIDGE_ADMIN_PORT/);
    expect(() => loadConfig({ BRIDGE_DATA_DIR: "/tmp/x", BRIDGE_ADMIN_PORT: "80" })).toThrow(/BRIDGE_ADMIN_PORT/);
  });
  it("rejects adminPort equal to the public port", () => {
    expect(() =>
      loadConfig({ BRIDGE_DATA_DIR: "/tmp/x", BRIDGE_PORT: "43111", BRIDGE_ADMIN_PORT: "43111" }),
    ).toThrow(/BRIDGE_ADMIN_PORT must differ from BRIDGE_PORT/);
  });
});
```

Note: `/tmp/x` is a placeholder — REQUIRED: follow however `config.test.ts` constructs its data dir today (likely a `mkdtempSync` temp dir in `beforeEach`; `loadConfig` mkdirs whatever it gets, but never commit a test that writes to a fixed shared path).

- [ ] **Step 2: Run** `cd bridge && npx vitest run test/config.test.ts` — expect the 4 new cases FAIL (no `adminPort` field).

- [ ] **Step 3: Implement in `bridge/src/config.ts`**

```ts
export const DEFAULT_BRIDGE_ADMIN_PORT = 43112;

/** Exported so the admin server reuses identical validation (loopback rule stays private to parseHost). */
export function parsePortValue(env: EnvSource, key: string, defaultPort: number): number {
  const raw = readString(env, key) ?? String(defaultPort);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${key} must be an integer between 1024 and 65535; got ${JSON.stringify(raw)}.`);
  }
  return port;
}
```

Refactor `parsePort(env)` to `return parsePortValue(env, "BRIDGE_PORT", DEFAULT_BRIDGE_PORT);`. In `BridgeConfig` add `/** Loopback port of the local admin API (never proxied by the tunnel). */ readonly adminPort: number;`. In `loadConfig`:

```ts
const port = parsePort(source);
const adminPort = parsePortValue(source, "BRIDGE_ADMIN_PORT", DEFAULT_BRIDGE_ADMIN_PORT);
if (adminPort === port) {
  throw new Error(`BRIDGE_ADMIN_PORT must differ from BRIDGE_PORT (both are ${port}).`);
}
```

and include `adminPort` in the frozen return.

- [ ] **Step 4: Run** `npx vitest run test/config.test.ts` — ALL PASS. Then `npm run typecheck -w @claude-remote/bridge` (may surface main.ts needing nothing yet — no other file reads adminPort at this point).

- [ ] **Step 5: Commit**

```bash
git add bridge/src/config.ts bridge/test/config.test.ts
git commit -m "feat(bridge): BRIDGE_ADMIN_PORT config with shared port validation"
```

### Task 2: admin-token — token file lifecycle + constant-time verify

**Files:**
- Create: `bridge/src/admin/admin-token.ts`
- Test: `bridge/test/admin/admin-token.test.ts`

- [ ] **Step 1: Write failing tests** (`bridge/test/admin/admin-token.test.ts`)

```ts
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAdminToken, verifyAdminToken } from "../../src/admin/admin-token.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "admin-token-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ensureAdminToken", () => {
  it("creates a 0600 file with a base64url 32-byte token on first call", () => {
    const { token, path } = ensureAdminToken(dir);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(path).toBe(join(dir, "admin-api-token"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe(token);
  });
  it("reuses the existing token and never rotates", () => {
    const first = ensureAdminToken(dir);
    const second = ensureAdminToken(dir);
    expect(second.token).toBe(first.token);
  });
  it("fails closed when the existing file is group/world readable", () => {
    ensureAdminToken(dir);
    chmodSync(join(dir, "admin-api-token"), 0o644);
    expect(() => ensureAdminToken(dir)).toThrow(/admin-api-token/);
  });
});

describe("verifyAdminToken", () => {
  it("accepts the exact token and rejects anything else", () => {
    const { token } = ensureAdminToken(dir);
    expect(verifyAdminToken(token, token)).toBe(true);
    expect(verifyAdminToken(token, token.slice(0, -1))).toBe(false);
    expect(verifyAdminToken(token, "")).toBe(false);
    expect(verifyAdminToken(token, `${token}x`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/admin/admin-token.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `bridge/src/admin/admin-token.ts`**

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** File name of the admin API bearer token inside BRIDGE_DATA_DIR (mode 0600). */
export const ADMIN_TOKEN_FILENAME = "admin-api-token";

/**
 * Load the admin API bearer token, creating it on first boot. Never rotates:
 * the menu-bar app reads this file, and rotating on restart would lock it out.
 * Fails closed when an existing file is readable by group/others.
 */
export function ensureAdminToken(dataDir: string): { token: string; path: string } {
  const path = join(dataDir, ADMIN_TOKEN_FILENAME);
  try {
    const raw = readFileSync(path, "utf8").trim();
    const mode = statSync(path).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `${path} must be mode 0600 (got 0${(mode & 0o777).toString(8)}); refusing to serve the admin API with a leaked token. Delete the file to force a fresh one.`,
      );
    }
    if (raw === "") throw new Error(`${path} is empty; delete it to force a fresh token.`);
    return { token: raw, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return { token, path };
}

/** Constant-time bearer comparison; length mismatch is a plain false. */
export function verifyAdminToken(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Caveat: an existing-file permission error must NOT fall through to the recreate path — the `catch` only continues on `ENOENT`, every other throw propagates. Keep that structure.

- [ ] **Step 4: Run** `npx vitest run test/admin/admin-token.test.ts` — ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/admin/admin-token.ts bridge/test/admin/admin-token.test.ts
git commit -m "feat(bridge): admin API bearer token file lifecycle"
```

### Task 3: admin-reads — read-only queries

**Files:**
- Create: `bridge/src/admin/admin-reads.ts`
- Test: `bridge/test/admin/admin-reads.test.ts`

- [ ] **Step 1: Write failing tests** (`bridge/test/admin/admin-reads.test.ts`)

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { createAdminReads } from "../../src/admin/admin-reads.js";

let dir: string;
let db: SqliteDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "admin-reads-"));
  db = openDatabase(join(dir, "bridge.db"), { createDir: true });
  migrate(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function seed() {
  db.prepare(`INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
              VALUES ('p1', '/tmp/a', 1, 2, 'Alpha', 0, 0)`).run();
  db.prepare(`INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
              VALUES ('s1', 'p1', 'S1', 'running', 'bridge', 100, 0)`).run();
  db.prepare(`INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
              VALUES ('s2', 'p1', 'S2', 'inactive', 'bridge', 50, 0)`).run();
  db.prepare(`INSERT INTO session_locks (sessionId, bridgeInstanceId, processPid, heartbeatAt)
              VALUES ('s1', 'inst-1', 4242, 100)`).run();
  db.prepare(`INSERT INTO devices (deviceId, publicKeySpki, accessSubject, displayName, pairedAt)
              VALUES ('d1', 'k', 'sub', 'Phone', 0)`).run();
  db.prepare(`INSERT INTO device_sessions (tokenHash, deviceId, accessSubject, expiresAt, createdAt)
              VALUES ('t1', 'd1', 'sub', 5000, 0)`).run();
  db.prepare(`INSERT INTO device_sessions (tokenHash, deviceId, accessSubject, expiresAt, createdAt)
              VALUES ('t2', 'd1', 'sub', 9000, 0)`).run();
}

describe("admin reads", () => {
  it("activeSessionCount counts only live statuses", () => {
    seed();
    expect(createAdminReads(db, { databasePath: join(dir, "bridge.db") }).activeSessionCount()).toBe(1);
  });
  it("sessions() joins project name and lock holder", () => {
    seed();
    const rows = createAdminReads(db, { databasePath: join(dir, "bridge.db") }).sessions();
    expect(rows[0]).toMatchObject({ sessionId: "s1", status: "running", projectDisplayName: "Alpha", lockedBy: "inst-1", processPid: 4242 });
    expect(rows[1]).toMatchObject({ sessionId: "s2", lockedBy: null });
  });
  it("deviceSessionExpiryMs returns max live expiry, null when none", () => {
    seed();
    const reads = createAdminReads(db, { databasePath: join(dir, "bridge.db") });
    expect(reads.deviceSessionExpiryMs("d1", 100)).toBe(9000);
    expect(reads.deviceSessionExpiryMs("missing", 100)).toBeNull();
  });
  it("auditPage pages newest-first by auditId and reports nextCursor only when more exist", () => {
    seed();
    for (let i = 1; i <= 5; i++) {
      db.prepare(`INSERT INTO audit_events (occurredAt, operationType, resultCode) VALUES (?, 'op', 'ok')`).run(i * 100);
    }
    // auditId AUTOINCREMENT assigns 1..5
    const reads = createAdminReads(db, { databasePath: join(dir, "bridge.db") });
    const page1 = reads.auditPage({ limit: 2 });
    expect(page1.items.map((r) => r.auditId)).toEqual([5, 4]);
    expect(page1.nextCursor).toBe(4);
    const last = reads.auditPage({ before: 2, limit: 5 });
    expect(last.items.map((r) => r.auditId)).toEqual([1]);
    expect(last.nextCursor).toBeNull();
  });
  it("dbSizeBytes stats the database file", () => {
    const reads = createAdminReads(db, { databasePath: join(dir, "bridge.db") });
    expect(reads.dbSizeBytes()).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/admin/admin-reads.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `bridge/src/admin/admin-reads.ts`**

```ts
import { statSync } from "node:fs";
import type { SqliteDatabase } from "../db/database.js";

export interface AuditEventRow {
  readonly auditId: number;
  readonly occurredAt: number;
  readonly operationType: string;
  readonly resultCode: string;
  readonly deviceId: string | null;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly redactedDetail: string | null;
}

export interface SessionListRow {
  readonly sessionId: string;
  readonly displayName: string;
  readonly status: string;
  readonly projectDisplayName: string;
  readonly lockedBy: string | null;
  readonly processPid: number | null;
  readonly lastActivityAt: number;
  readonly createdAt: number;
}

/** Sessions the operator would consider "in flight" for the status card. */
const LIVE_SESSION_STATUSES = new Set(["starting", "idle", "running", "waiting_permission", "interrupting", "releasing"]);

export interface AdminReads {
  auditPage(input: { before?: number; limit: number }): { items: AuditEventRow[]; nextCursor: number | null };
  sessions(): SessionListRow[];
  activeSessionCount(): number;
  deviceSessionExpiryMs(deviceId: string, nowMs: number): number | null;
  dbSizeBytes(): number;
}

export function createAdminReads(db: SqliteDatabase, options: { databasePath: string }): AdminReads {
  const auditStmt = db.prepare(
    `SELECT auditId, occurredAt, operationType, resultCode, deviceId, sessionId, projectId, redactedDetail
     FROM audit_events WHERE (? IS NULL OR auditId < ?) ORDER BY auditId DESC LIMIT ?`,
  );
  const sessionsStmt = db.prepare(
    `SELECT s.sessionId, s.displayName, s.status, p.displayName AS projectDisplayName,
            l.bridgeInstanceId AS lockedBy, l.processPid AS processPid,
            s.lastActivityAt, s.createdAt
     FROM sessions s
     JOIN projects p ON p.projectId = s.projectId
     LEFT JOIN session_locks l ON l.sessionId = s.sessionId
     ORDER BY s.lastActivityAt DESC LIMIT 50`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status IN ('starting','idle','running','waiting_permission','interrupting','releasing')`);
  const expiryStmt = db.prepare(
    `SELECT MAX(expiresAt) AS e FROM device_sessions WHERE deviceId = ? AND revokedAt IS NULL AND expiresAt > ?`,
  );

  return {
    auditPage({ before, limit }) {
      const capped = Math.min(Math.max(1, limit), 200);
      const rows = auditStmt.all(before ?? null, before ?? null, capped + 1) as AuditEventRow[];
      const hasMore = rows.length > capped;
      const items = hasMore ? rows.slice(0, capped) : rows;
      return { items, nextCursor: hasMore && items.length > 0 ? items[items.length - 1].auditId : null };
    },
    sessions() {
      return sessionsStmt.all() as SessionListRow[];
    },
    activeSessionCount() {
      return (countStmt.get() as { n: number }).n;
    },
    deviceSessionExpiryMs(deviceId, nowMs) {
      const row = expiryStmt.get(deviceId, nowMs) as { e: number | null };
      return row?.e ?? null;
    },
    dbSizeBytes() {
      return statSync(options.databasePath).size;
    },
  };
}
```

(`LIVE_SESSION_STATUSES` is documentation-only — the SQL enumerates the same values because SQLite has no parameterized IN with a set; delete the const if your linter flags it as unused, keep the SQL as the single source.)

- [ ] **Step 4: Run** `npx vitest run test/admin/admin-reads.test.ts` — ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/admin/admin-reads.ts bridge/test/admin/admin-reads.test.ts
git commit -m "feat(bridge): read-only admin queries (audit page, sessions, expiry, db size)"
```

### Task 4: api-server — admin Fastify instance

**Files:**
- Create: `bridge/src/admin/api-server.ts`
- Modify: `bridge/src/server/http-server.ts` (export `getBridgeVersion()`)
- Test: `bridge/test/admin/api-server.test.ts`

- [ ] **Step 1: Export the version helper** — in `http-server.ts` change `const bridgeVersion: string = require(pkgPath).version as string;` to keep the const but add:

```ts
/** Package version, reused by the admin API status route. */
export function getBridgeVersion(): string {
  return bridgeVersion;
}
```

- [ ] **Step 2: Write failing tests** (`bridge/test/admin/api-server.test.ts`). Test harness notes: build a real temp DB + real registries (same pattern as `test/admin/cli.test.ts`), a hand-rolled `config` object literal (only `publicHost` / `dataDir` / `databasePath` fields are read by the server), an injected `probePublicHealth`, and a call-recording fake `RevocationHooks`. Drive everything with `app.inject({ headers: { authorization: "Bearer " + token } } })`.

```ts
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
    const audited = db.prepare(`SELECT * FROM audit_events WHERE operationType LIKE 'admin.%'`).all();
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
    build({ publicHost: undefined });
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
```

- [ ] **Step 3: Run** `npx vitest run test/admin/api-server.test.ts` — FAIL.

- [ ] **Step 4: Implement `bridge/src/admin/api-server.ts`**

```ts
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { BridgeConfig } from "../config.js";
import type { DeviceAuth, RevocationHooks } from "../auth/device-auth.js";
import type { ProjectRegistry } from "../projects/project-registry.js";
import type { AuditLog } from "../audit/audit-log.js";
import { getBridgeVersion } from "../server/http-server.js";
import { verifyAdminToken } from "./admin-token.js";
import { createAdminReads, type AdminReads } from "./admin-reads.js";

/** Log file names under <dataDir>/logs (launchd StandardOut/ErrPath convention). */
const LOG_FILES = { out: "bridge.out.log", err: "bridge.err.log" } as const;
const LOG_TAIL_DEFAULT_BYTES = 32_768;
const LOG_TAIL_MAX_BYTES = 256 * 1024;
const AUTH_FAIL_AUDIT_WINDOW_MS = 10_000;

export interface AdminApiDeps {
  readonly config: BridgeConfig;
  readonly token: string;
  readonly registry: ProjectRegistry;
  readonly devices: DeviceAuth;
  readonly audit: AuditLog;
  readonly reads: AdminReads;
  readonly revocationHooks: RevocationHooks;
  readonly now: () => number;
  readonly uptimeSeconds: () => number;
  /** Probe the public health endpoint: true/false reachable, null when no publicHost. */
  readonly probePublicHealth: () => Promise<boolean | null>;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send(errorBody(code, message));
}

export function createAdminServer(deps: AdminApiDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: "info", redact: { paths: ["req.headers.authorization"], censor: "[redacted]" } },
  });
  let lastAuthFailAuditAt = -Infinity;

  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!verifyAdminToken(deps.token, presented)) {
      const t = deps.now();
      if (t - lastAuthFailAuditAt >= AUTH_FAIL_AUDIT_WINDOW_MS) {
        lastAuthFailAuditAt = t;
        deps.audit.write({ operationType: "admin.auth_failed", resultCode: "denied", sourceIp: request.ip });
      }
      await sendError(reply, 401, "unauthorized", "missing or invalid admin bearer token");
    }
  });

  app.get("/admin/v1/status", async () => {
    const active = deps.devices.listDevices().find((d) => d.revokedAt === null) ?? null;
    return {
      uptimeSeconds: Math.floor(deps.uptimeSeconds()),
      publicReachable: await deps.probePublicHealth(),
      activeSessions: deps.reads.activeSessionCount(),
      device: active === null ? null : {
        deviceId: active.deviceId,
        displayName: active.displayName,
        pairedAt: active.pairedAt,
        sessionExpiresAt: deps.reads.deviceSessionExpiryMs(active.deviceId, deps.now()),
      },
      dbSizeBytes: deps.reads.dbSizeBytes(),
      version: getBridgeVersion(),
    };
  });

  app.get("/admin/v1/projects", async () => deps.registry.list());

  app.post("/admin/v1/projects", async (request, reply) => {
    const body = request.body as { path?: unknown; name?: unknown };
    const path = typeof body.path === "string" ? body.path : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!isAbsolute(path) || name === "") {
      return sendError(reply, 400, "invalid_project", "path must be absolute and name must be non-empty");
    }
    try {
      const record = deps.registry.authorize(path, name, { now: deps.now() });
      deps.audit.write({ operationType: "admin.authorize_project", resultCode: "ok", projectId: record.projectId, detail: { source: "admin_api" } });
      return reply.code(201).send(record);
    } catch (error) {
      return sendError(reply, 400, "invalid_project", (error as Error).message);
    }
  });

  app.delete("/admin/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const existing = deps.registry.get(projectId);
    if (existing === undefined) return sendError(reply, 404, "project_not_found", `no authorized project ${projectId}`);
    deps.registry.remove(projectId);
    deps.audit.write({ operationType: "admin.revoke_project", resultCode: "ok", projectId, detail: { source: "admin_api" } });
    return reply.code(204).send();
  });

  app.get("/admin/v1/devices", async () => {
    const all = deps.devices.listDevices();
    return { active: all.find((d) => d.revokedAt === null) ?? null, revoked: all.filter((d) => d.revokedAt !== null) };
  });

  app.post("/admin/v1/devices/:deviceId/revoke", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const target = deps.devices.listDevices().find((d) => d.deviceId === deviceId && d.revokedAt === null);
    if (target === undefined) return sendError(reply, 404, "device_not_found", `no active device ${deviceId}`);
    // Domain semantics: DB transaction commits first, then hooks (deny → close).
    deps.devices.revokeDevice(deviceId, deps.now(), deps.revocationHooks);
    deps.audit.write({ operationType: "admin.revoke_device", resultCode: "ok", deviceId, detail: { source: "admin_api" } });
    return reply.code(204).send();
  });

  app.post("/admin/v1/devices/revoke-all", async (_request, reply) => {
    for (const device of deps.devices.listDevices().filter((d) => d.revokedAt === null)) {
      deps.devices.revokeDevice(device.deviceId, deps.now(), deps.revocationHooks);
      deps.audit.write({ operationType: "admin.revoke_device", resultCode: "ok", deviceId: device.deviceId, detail: { source: "admin_api" } });
    }
    return reply.code(204).send();
  });

  app.post("/admin/v1/pairing/qrcode", async (_request, reply) => {
    if (deps.config.publicHost === undefined) {
      return sendError(reply, 409, "public_host_unset", "bridge runs local-only; set BRIDGE_PUBLIC_HOST and restart to mint pairing codes");
    }
    if (deps.devices.listDevices().some((d) => d.revokedAt === null)) {
      return sendError(reply, 409, "already_paired", "a device is already paired; revoke it first");
    }
    const minted = deps.devices.mintPairingToken(deps.now());
    // The pairing token itself never reaches the audit trail. Host and token
    // are URI-encoded exactly like the CLI's pairing-qrcode payload builder.
    deps.audit.write({ operationType: "admin.mint_pairing_token", resultCode: "ok", detail: { source: "admin_api" } });
    const host = encodeURIComponent(deps.config.publicHost);
    const token = encodeURIComponent(minted.token);
    return { payload: `claude-remote://pair?host=${host}&token=${token}`, expiresAt: minted.expiresAt };
  });

  app.get("/admin/v1/sessions", async () => deps.reads.sessions());

  app.get("/admin/v1/audit", async (request) => {
    const q = request.query as { limit?: string; cursor?: string };
    const limit = Number(q.limit ?? "50");
    const before = q.cursor === undefined ? undefined : Number(q.cursor);
    return deps.reads.auditPage({
      limit: Number.isFinite(limit) ? limit : 50,
      before: Number.isFinite(before as number) ? (before as number) : undefined,
    });
  });

  app.get("/admin/v1/logs/tail", async (request, reply) => {
    const q = request.query as { file?: string; bytes?: string };
    const file = LOG_FILES[q.file as keyof typeof LOG_FILES];
    if (file === undefined) return sendError(reply, 400, "invalid_file", "file must be out or err");
    const requested = Number(q.bytes ?? String(LOG_TAIL_DEFAULT_BYTES));
    const n = Number.isFinite(requested) ? Math.min(Math.max(1, Math.trunc(requested)), LOG_TAIL_MAX_BYTES) : LOG_TAIL_DEFAULT_BYTES;
    const path = join(deps.config.dataDir, "logs", file);
    if (!existsSync(path)) return { content: "" };
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(n, size));
      readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return { content: buffer.toString("utf8") };
    } finally {
      closeSync(fd);
    }
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, "not_found", "unknown admin route"));

  return app;
}
```

Spec deviation notes (record in the PR description, not the spec): (1) `/status.device` omits the spec's `sessionRevoked` field — constant-false for the only value the route can return; (2) `GET /sessions` returns `{displayName, projectDisplayName, status, lockedBy, processPid, lastActivityAt, createdAt}` rather than the spec sketch's `{projectId, startedAt, updatedAt}` — richer and matches the DB; the Swift DTOs in Chunk 2 encode this real shape; (3) `GET /projects` returns the raw `ProjectRecord` (`canonicalRealpath`/`displayName`), not the spec sketch's `path`/`name`.

- [ ] **Step 5: Run** `npx vitest run test/admin/api-server.test.ts` — ALL PASS. Then the full bridge suite: `npm test -w @claude-remote/bridge` — ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add bridge/src/admin/api-server.ts bridge/src/server/http-server.ts bridge/test/admin/api-server.test.ts
git commit -m "feat(bridge): loopback admin API (status/projects/devices/pairing/sessions/audit/logs)"
```

### Task 5: main.ts wiring — extract hooks, start admin server

**Files:**
- Modify: `bridge/src/main.ts`
- Test: `bridge/test/main.smoke.test.ts`

- [ ] **Step 1: Write the failing smoke assertions first.** Read `bridge/test/main.smoke.test.ts` to see how it boots `startBridge` (temp `BRIDGE_DATA_DIR` + `freePort()` env injection). Append one test that: boots the bridge, reads `adminPort` from the returned runtime's `config` (`handle.config.adminPort`), then

```ts
// admin API answers on its own loopback port with bearer auth
const tokenPath = join(dataDir, "admin-api-token");
expect(existsSync(tokenPath)).toBe(true);
const token = readFileSync(tokenPath, "utf8").trim();
const unauthed = await fetch(`http://127.0.0.1:${adminPort}/admin/v1/status`);
expect(unauthed.status).toBe(401);
const authed = await fetch(`http://127.0.0.1:${adminPort}/admin/v1/status`, {
  headers: { authorization: `Bearer ${token}` },
});
expect(authed.status).toBe(200);
expect((await authed.json()).uptimeSeconds).toBeGreaterThanOrEqual(0);
```

If the smoke test runs the bridge on a fixed port, add `BRIDGE_ADMIN_PORT: "<some free port>"` to its env the same way it pins/avoids the main port. Expected: FAIL (admin port never listens).

- [ ] **Step 2: Implement in `bridge/src/main.ts`.**

a) Import near the auth imports:

```ts
import { ensureAdminToken } from "./admin/admin-token.js";
import { createAdminServer } from "./admin/api-server.js";
import { createAdminReads } from "./admin/admin-reads.js";
```

b) Replace the inline hooks object inside `const revokeDevice = ...` (around main.ts:545) with a named factory shared with the admin API — place it right before `revokeDevice`:

```ts
const buildRevocationHooks = (): RevocationHooks => ({
  denyPendingPermissions: (target) => {
    void broker.denyAllForDevice(target, "device revoked").catch(() => undefined);
  },
  closeSockets: (target) => {
    wsService.closeDevice(target, CLOSE_CODE.AUTH_INVALID, "device revoked");
  },
});
```

`revokeDevice` becomes:

```ts
const revokeDevice = (deviceId: string): void => {
  devices.revokeDevice(deviceId, now(), buildRevocationHooks());
  handledRevocations.add(deviceId);
  audit.write({
    operationType: "device.revoke",
    deviceId,
    resultCode: "ok",
    detail: { source: "runtime" },
    committed: true,
  });
};
```

(`RevocationHooks` needs importing from `./auth/device-auth.js` if not already.)

c) After `await app.listen(...)` / before or after `supervisor.recoverOnStartup()` (any spot where `registry`, `devices`, `audit`, `db` are all in scope — right after `app.log.info(... "bridge listening")` is cleanest):

```ts
// --- Loopback admin API (never proxied by the tunnel) ---------------------
const adminToken = ensureAdminToken(config.dataDir);
const adminApp = createAdminServer({
  config,
  token: adminToken.token,
  registry,
  devices,
  audit,
  reads: createAdminReads(db, { databasePath: config.databasePath }),
  revocationHooks: buildRevocationHooks(),
  now,
  uptimeSeconds: () => process.uptime(),
  probePublicHealth: async () => {
    if (config.publicHost === undefined) return null;
    try {
      // Any HTTP answer (including Cloudflare Access 401/302) proves the
      // tunnel path is up; only network failure means down.
      await fetch(`https://${config.publicHost}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
      return true;
    } catch {
      return false;
    }
  },
});
await adminApp.listen({ host: config.host, port: config.adminPort });
```

d) In `close()`: after `await app.close()` add

```ts
try {
  await adminApp.close();
} catch (error) {
  app.log.warn({ err: error }, "admin server close failed");
}
```

e) Extend the returned runtime object with `adminApp`.

- [ ] **Step 3: Run the smoke test** `npx vitest run test/main.smoke.test.ts` — PASS. Then full suite `npm test -w @claude-remote/bridge` and `npm run typecheck -w @claude-remote/bridge` — ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add bridge/src/main.ts bridge/test/main.smoke.test.ts
git commit -m "feat(bridge): start loopback admin API with shared revocation hooks"
```

### Task 6: deploy docs

**Files:**
- Modify: `docs/operations/deploy.md`

- [ ] **Step 1:** Add a short "Admin API（本机管理接口）" subsection after the doctor section: default port 43112 / `BRIDGE_ADMIN_PORT`, loopback-only and never behind the tunnel, token at `<data-dir>/admin-api-token` (0600, delete to rotate — the GUI gets locked out until it re-reads), consumed by the BridgeBar menu-bar app (see `macos/BridgeBar/README.md`). Mention the launchd plist needs no change (defaults apply).

- [ ] **Step 2: Commit**

```bash
git add docs/operations/deploy.md
git commit -m "docs: admin API port/token conventions"
```

## Chunk 2: macOS menu-bar app (BridgeBar)

Swift 6 / SwiftUI via SwiftPM (no Xcode project file needed; the folder opens in Xcode if the user wants). Zero third-party dependencies.

### Task 7: SwiftPM scaffold + app skeleton + bundle script

**Files:**
- Create: `macos/BridgeBar/Package.swift`
- Create: `macos/BridgeBar/Sources/BridgeBar/BridgeBarApp.swift`
- Create: `macos/BridgeBar/scripts/make-app.sh` (chmod +x)
- Create: `macos/BridgeBar/README.md`

- [ ] **Step 1: `Package.swift`**

```swift
// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "BridgeBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "BridgeBar"),
        .testTarget(name: "BridgeBarTests", dependencies: ["BridgeBar"]),
    ]
)
```

- [ ] **Step 2: `Sources/BridgeBar/BridgeBarApp.swift`**

```swift
import SwiftUI

@main
struct BridgeBarApp: App {
    @State private var store = StatusStore()

    var body: some Scene {
        MenuBarExtra {
            MenuPanelView()
                .environment(store)
        } label: {
            Image(systemName: store.icon.symbolName)
        }
        .menuBarExtraStyle(.window)

        Window("Bridge 管理", id: "main") {
            MainWindow()
                .environment(store)
        }
        .defaultSize(width: 720, height: 480)

        Settings {
            SettingsView()
                .environment(store)
        }
    }
}
```

This won't compile until Tasks 8-11 land (`StatusStore`, `MenuPanelView`, `MainWindow`, `SettingsView`). To keep TDD cadence, create minimal placeholder versions in this task and replace them later:

```swift
// Sources/BridgeBar/Core/StatusStore.swift (placeholder until Task 10)
import Foundation
import Observation

@MainActor @Observable
final class StatusStore {
    var icon: IconState { .red }
}
```
```swift
// Sources/BridgeBar/Core/IconState.swift (placeholder until Task 9)
enum IconState {
    case red
    var symbolName: String { "xmark.octagon.fill" }
}
```
```swift
// Sources/BridgeBar/Views/MenuPanelView.swift (placeholder)
import SwiftUI
struct MenuPanelView: View {
    var body: some View { Text("BridgeBar") }
}
```
```swift
// Sources/BridgeBar/Views/MainWindow.swift (placeholder)
import SwiftUI
struct MainWindow: View {
    var body: some View { Text("Bridge 管理") }
}
```
```swift
// Sources/BridgeBar/Views/SettingsView.swift (placeholder)
import SwiftUI
struct SettingsView: View {
    var body: some View { Text("Settings") }
}
```

- [ ] **Step 3: Verify the scaffold compiles**

Run: `cd macos/BridgeBar && swift build`
Expected: BUILD SUCCEEDED. (No test files yet — LogicTests/AdminClientTests land in Tasks 8-9. The placeholder `IconState` carries one case so `StatusStore.icon { .red }` compiles; Task 9 replaces the whole file.)

- [ ] **Step 4: `scripts/make-app.sh`**

```bash
#!/usr/bin/env bash
# Assemble BridgeBar.app (menu-bar agent) from a release build, ad-hoc signed.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
APP="build/release/BridgeBar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/BridgeBar "$APP/Contents/MacOS/BridgeBar"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>BridgeBar</string>
    <key>CFBundleIdentifier</key><string>dev.clauderemote.BridgeBar</string>
    <key>CFBundleName</key><string>BridgeBar</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
codesign --force --sign - "$APP"
echo "Built $APP — drag it into /Applications, then launch once"
```

Run `chmod +x scripts/make-app.sh && ./scripts/make-app.sh` — expect "Built build/release/BridgeBar.app ...", and `codesign -dv build/release/BridgeBar.app` shows ad-hoc signature. (Launching it now shows a menu bar `xmark.octagon` icon that does nothing useful yet.)

- [ ] **Step 5: `README.md`**

```markdown
# BridgeBar

macOS 菜单栏管理端 for the claude-remote Bridge（spec: docs/superpowers/specs/2026-09-15-bridge-admin-gui-design.md）。

- 开发：`swift run`（先启动 bridge，token 默认读 `~/.local/share/claude-remote/admin-api-token`）
- 测试：`swift test`
- 打包：`./scripts/make-app.sh` → 拖 `build/release/BridgeBar.app` 进 /Applications
- 设置里可改 data dir、admin 端口；开机自启走系统登录项（Settings 勾选）
```

- [ ] **Step 6: Commit**

```bash
git add macos/BridgeBar
git commit -m "feat(macos): BridgeBar SwiftPM scaffold with menu bar skeleton"
```

### Task 8: AdminModels + AdminClient (the only networking code)

**Files:**
- Create: `macos/BridgeBar/Sources/BridgeBar/Core/AdminModels.swift`
- Create: `macos/BridgeBar/Sources/BridgeBar/Core/AdminClient.swift`
- Test: `macos/BridgeBar/Tests/BridgeBarTests/AdminClientTests.swift`

- [ ] **Step 1: `AdminModels.swift`**

```swift
import Foundation

struct BridgeStatus: Codable, Equatable, Sendable {
    var uptimeSeconds: Int
    var publicReachable: Bool?
    var activeSessions: Int
    var device: DeviceCard?
    var dbSizeBytes: Int
    var version: String

    struct DeviceCard: Codable, Equatable, Sendable {
        var deviceId: String
        var displayName: String
        var pairedAt: Double
        var sessionExpiresAt: Double?
    }
}

struct Project: Codable, Equatable, Identifiable, Sendable {
    var projectId: String
    var canonicalRealpath: String
    var deviceNumber: Int
    var inode: Int
    var displayName: String
    var createdAt: Double
    var authorizedAt: Double
    var id: String { projectId }
}

struct Device: Codable, Equatable, Identifiable, Sendable {
    var deviceId: String
    var displayName: String
    var accessSubject: String
    var pairedAt: Double
    var revokedAt: Double?
    var id: String { deviceId }
}

struct DeviceList: Codable, Equatable, Sendable {
    var active: Device?
    var revoked: [Device]
}

struct PairingCode: Codable, Equatable, Sendable {
    var payload: String
    var expiresAt: Double
}

struct SessionRow: Codable, Equatable, Identifiable, Sendable {
    var sessionId: String
    var displayName: String
    var status: String
    var projectDisplayName: String
    var lockedBy: String?
    var processPid: Int?
    var lastActivityAt: Double
    var createdAt: Double
    var id: String { sessionId }
}

struct AuditRow: Codable, Equatable, Identifiable, Sendable {
    var auditId: Int
    var occurredAt: Double
    var operationType: String
    var resultCode: String
    var deviceId: String?
    var sessionId: String?
    var projectId: String?
    var id: Int { auditId }
}

struct AuditPage: Codable, Equatable, Sendable {
    var items: [AuditRow]
    var nextCursor: Int?
}

struct LogTail: Codable, Equatable, Sendable {
    var content: String
}
```

- [ ] **Step 2: Write failing tests** (`Tests/BridgeBarTests/AdminClientTests.swift`)

```swift
import Foundation
import Testing
@testable import BridgeBar

@Test func errorMapping() async throws {
    // 401 → unauthorized
    #expect(AdminClient.error(fromStatus: 401, data: Data()) == .unauthorized)
    // API error body → .api(code,message)
    let body = try JSONEncoder().encode(["error": ["code": "already_paired", "message": "a device is already paired"]])
    #expect(
        AdminClient.error(fromStatus: 409, data: body)
            == .api(code: "already_paired", message: "a device is already paired")
    )
    // Malformed body on non-2xx → generic api error carrying the status
    if case let .api(code, _) = AdminClient.error(fromStatus: 500, data: Data("nope".utf8)) {
        #expect(code == "http_500")
    } else {
        Issue.record("expected generic api error")
    }
}

@Test func endpointLoadReadsTokenFile() throws {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("bb-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let tokenPath = dir.appendingPathComponent("admin-api-token")
    try Data("tok123\n".utf8).write(to: tokenPath)

    let endpoint = AdminClient.loadEndpoint(dataDirPath: dir.path, baseURL: URL(string: "http://127.0.0.1:43112")!)
    #expect(endpoint?.token == "tok123")
    #expect(endpoint?.baseURL.absoluteString == "http://127.0.0.1:43112")

    try? FileManager.default.removeItem(at: dir)
}

@Test func decodeStatus() throws {
    let json = """
    {"uptimeSeconds":42,"publicReachable":false,"activeSessions":1,
     "device":{"deviceId":"d","displayName":"Phone","pairedAt":0,"sessionExpiresAt":99},
     "dbSizeBytes":1024,"version":"0.1.0"}
    """
    let status = try JSONDecoder().decode(BridgeStatus.self, from: Data(json.utf8))
    #expect(status.device?.sessionExpiresAt == 99)
    #expect(status.publicReachable == false)
}
```

- [ ] **Step 3: Run** `swift test` — expect errorMapping + endpoint tests FAIL (no AdminClient).

- [ ] **Step 4: `AdminClient.swift`**

```swift
import Foundation

enum AdminError: Error, Equatable, Sendable {
    case unreachable(String)
    case unauthorized
    case api(code: String, message: String)
}

struct AdminEndpoint: Equatable, Sendable {
    var baseURL: URL
    var token: String
}

/// The ONLY networking code in the app. An actor so token/endpoint swaps are
/// race-free; all responses are decoded into AdminModels value types.
actor AdminClient {
    private var endpoint: AdminEndpoint
    private let session: URLSession

    init(endpoint: AdminEndpoint, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    func updateEndpoint(_ newEndpoint: AdminEndpoint) {
        endpoint = newEndpoint
    }

    /// Resolve the endpoint the same way the bridge writes it: token file at
    /// `<dataDir>/admin-api-token`. Returns nil when the file is missing.
    nonisolated static func loadEndpoint(dataDirPath: String, baseURL: URL) -> AdminEndpoint? {
        guard let raw = try? String(contentsOfFile: dataDirPath + "/admin-api-token", encoding: .utf8) else { return nil }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : AdminEndpoint(baseURL: baseURL, token: token)
    }

    // MARK: - Typed API

    func status() async throws -> BridgeStatus { try await get("status") }
    func projects() async throws -> [Project] { try await get("projects") }
    func devices() async throws -> DeviceList { try await get("devices") }
    func sessions() async throws -> [SessionRow] { try await get("sessions") }
    func audit(limit: Int, cursor: Int?) async throws -> AuditPage {
        try await get("audit?limit=\(limit)\(cursor.map { "&cursor=\($0)" } ?? "")")
    }
    func logTail(file: String, bytes: Int) async throws -> LogTail {
        try await get("logs/tail?file=\(file)&bytes=\(bytes)")
    }

    func authorizeProject(path: String, name: String) async throws -> Project {
        try await post("projects", body: ["path": path, "name": name])
    }

    func deleteProject(_ projectId: String) async throws {
        try await expectEmpty("projects/\(projectId)", method: "DELETE")
    }

    func revokeDevice(_ deviceId: String) async throws {
        try await expectEmpty("devices/\(deviceId)/revoke", method: "POST")
    }

    func revokeAllDevices() async throws {
        try await expectEmpty("devices/revoke-all", method: "POST")
    }

    func pairingQRCode() async throws -> PairingCode {
        try await postEmpty("pairing/qrcode")
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await decode(request(for: path))
    }

    private func postEmpty<T: Decodable>(_ path: String) async throws -> T {
        var request = request(for: path)
        request.httpMethod = "POST"
        return try await decode(request)
    }

    private func post<T: Decodable>(_ path: String, body: some Encodable & Sendable) async throws -> T {
        var request = request(for: path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        return try await decode(request)
    }

    private func expectEmpty(_ path: String, method: String) async throws {
        var request = request(for: path)
        request.httpMethod = method
        let (_, response) = try await send(request)
        try check(response: response, data: Data())
    }

    private func request(for path: String) -> URLRequest {
        // URL(string:) leaves an existing query string intact; appendingPathComponent would escape "?".
        guard let url = URL(string: endpoint.baseURL.absoluteString + "/admin/v1/" + path) else {
            preconditionFailure("invalid admin URL for path \(path)")
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        return request
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw AdminError.unreachable("non-HTTP response")
            }
            return (data, http)
        } catch let error as AdminError {
            throw error
        } catch {
            throw AdminError.unreachable(error.localizedDescription)
        }
    }

    private func decode<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await send(request)
        try check(response: response, data: data)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw AdminError.unreachable("malformed response: \(error.localizedDescription)")
        }
    }

    private func check(response: HTTPURLResponse, data: Data) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        throw Self.error(fromStatus: response.statusCode, data: data)
    }

    /// Pure error normalization — tested directly.
    nonisolated static func error(fromStatus status: Int, data: Data) -> AdminError {
        if status == 401 { return .unauthorized }
        struct ErrorBody: Decodable {
            struct Inner: Decodable { var code: String; var message: String }
            var error: Inner
        }
        if let parsed = try? JSONDecoder().decode(ErrorBody.self, from: data) {
            return .api(code: parsed.error.code, message: parsed.error.message)
        }
        return .api(code: "http_\(status)", message: "request failed with HTTP \(status)")
    }
}

/// Type-erasing box so one transport can encode any body type.
private struct AnyEncodable: Encodable {
    private let encodeFunc: (Encoder) throws -> Void
    init(_ wrapped: some Encodable) { encodeFunc = { try wrapped.encode(to: $0) } }
    func encode(to encoder: Encoder) throws { try encodeFunc(encoder) }
}
```

- [ ] **Step 5: Run** `swift test` — ALL PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add macos/BridgeBar/Sources/BridgeBar/Core macos/BridgeBar/Tests/BridgeBarTests/AdminClientTests.swift
git commit -m "feat(macos): admin API client with typed DTOs and error normalization"
```

### Task 9: Backoff + IconState (pure logic, replaces placeholders)

**Files:**
- Modify: `macos/BridgeBar/Sources/BridgeBar/Core/IconState.swift` (replace placeholder)
- Create: `macos/BridgeBar/Sources/BridgeBar/Core/Backoff.swift`
- Test: `macos/BridgeBar/Tests/BridgeBarTests/LogicTests.swift`

- [ ] **Step 1: Write failing tests** (`Tests/BridgeBarTests/LogicTests.swift`)

```swift
import Foundation
import Testing
@testable import BridgeBar

@Test func backoffDoublesAndCaps() {
    var backoff = Backoff()
    #expect(backoff.delay == 1)
    backoff.recordFailure() // 1 failure → 2s
    #expect(backoff.delay == 2)
    backoff.recordFailure(); backoff.recordFailure() // 3 failures → 8s
    #expect(backoff.delay == 8)
    for _ in 0..<20 { backoff.recordFailure() }
    #expect(backoff.delay == 60) // capped
    backoff.recordSuccess()
    #expect(backoff.delay == 1)
}

@Test func iconStates() {
    let nowMs = 1_000_000.0
    let ok = BridgeStatus(uptimeSeconds: 1, publicReachable: true, activeSessions: 0, device: nil, dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: ok, bridgeReachable: true, nowMs: nowMs) == .green)
    // bridge down → red regardless of last status
    #expect(IconState.from(status: ok, bridgeReachable: false, nowMs: nowMs) == .red)
    // tunnel down → yellow
    let tunnelDown = BridgeStatus(uptimeSeconds: 1, publicReachable: false, activeSessions: 0, device: nil, dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: tunnelDown, bridgeReachable: true, nowMs: nowMs) == .yellow)
    // publicReachable nil (local-only) is neutral, not yellow
    let local = BridgeStatus(uptimeSeconds: 1, publicReachable: nil, activeSessions: 0, device: nil, dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: local, bridgeReachable: true, nowMs: nowMs) == .green)
    // device session expiring within 24h → yellow
    let soon = BridgeStatus(uptimeSeconds: 1, publicReachable: true, activeSessions: 0,
                            device: .init(deviceId: "d", displayName: "P", pairedAt: 0, sessionExpiresAt: nowMs + 3_600_000),
                            dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: soon, bridgeReachable: true, nowMs: nowMs) == .yellow)
    let far = BridgeStatus(uptimeSeconds: 1, publicReachable: true, activeSessions: 0,
                           device: .init(deviceId: "d", displayName: "P", pairedAt: 0, sessionExpiresAt: nowMs + 7 * 86_400_000),
                           dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: far, bridgeReachable: true, nowMs: nowMs) == .green)
    #expect(IconState.red.symbolName == "xmark.octagon.fill")
}
```

- [ ] **Step 2: Run** `swift test` — FAIL (Backoff missing; IconState placeholder lacks `from(_:bridgeReachable:nowMs:)` and the green/yellow cases).

- [ ] **Step 3: Implement.** Replace `Core/IconState.swift`:

```swift
import Foundation

enum IconState: Equatable, Sendable {
    case green, yellow, red

    var symbolName: String {
        switch self {
        case .green: "checkmark.circle.fill"
        case .yellow: "exclamationmark.triangle.fill"
        case .red: "xmark.octagon.fill"
        }
    }

    /// green = bridge reachable AND tunnel up AND device session not near expiry.
    /// yellow = reachable but degraded (tunnel down, or device session < 24h).
    /// red = admin API unreachable. publicReachable == nil (local-only) is neutral.
    static func from(status: BridgeStatus?, bridgeReachable: Bool, nowMs: Double) -> IconState {
        guard bridgeReachable, let status else { return .red }
        if status.publicReachable == false { return .yellow }
        if let expires = status.device?.sessionExpiresAt, expires - nowMs < 24 * 3_600_000 { return .yellow }
        return .green
    }
}
```

Create `Core/Backoff.swift`:

```swift
import Foundation

/// Exponential backoff for failed polls: 1s → 2s → 4s → … capped at 60s.
struct Backoff: Equatable, Sendable {
    private(set) var failures: Int = 0
    static let base: TimeInterval = 1
    static let cap: TimeInterval = 60

    var delay: TimeInterval { min(Self.base * pow(2, Double(failures)), Self.cap) }

    mutating func recordFailure() { failures += 1 }
    mutating func recordSuccess() { failures = 0 }
}
```

- [ ] **Step 4: Run** `swift test` — ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/BridgeBar/Sources/BridgeBar/Core macos/BridgeBar/Tests/BridgeBarTests/LogicTests.swift
git commit -m "feat(macos): icon state mapping and poll backoff"
```

### Task 10: StatusStore — polling, endpoint config, error surface

**Files:**
- Modify: `macos/BridgeBar/Sources/BridgeBar/Core/StatusStore.swift` (replace placeholder)
- Test: covered indirectly by LogicTests + manual; store itself is UI-glue (kept thin on purpose)

- [ ] **Step 1: Implement `Core/StatusStore.swift`**

```swift
import Foundation
import Observation
import SwiftUI

/// Owns the admin endpoint config (UserDefaults-backed) and the /status poll.
/// The panel sets `fastPolling` on appear/disappear: 5s while open, 30s idle.
@MainActor @Observable
final class StatusStore {
    private(set) var status: BridgeStatus?
    private(set) var lastError: AdminError?
    private(set) var endpoint: AdminEndpoint?
    private(set) var bridgeReachable = false

    var fastPolling = false {
        didSet { scheduleNext(immediate: true) }
    }

    private var backoff = Backoff()
    private var pollTask: Task<Void, Never>?
    private var client: AdminClient?

    // UserDefaults-backed settings
    var dataDirPath: String {
        didSet { persistAndReload() }
    }
    var baseURLString: String {
        didSet { persistAndReload() }
    }

    init(defaults: UserDefaults = .standard) {
        dataDirPath = defaults.string(forKey: "dataDirPath") ?? NSHomeDirectory() + "/.local/share/claude-remote"
        baseURLString = defaults.string(forKey: "baseURLString") ?? "http://127.0.0.1:43112"
        self.defaults = defaults
        reloadEndpoint()
        startPolling()
    }

    private let defaults: UserDefaults

    var icon: IconState {
        IconState.from(status: status, bridgeReachable: bridgeReachable, nowMs: Date.now.timeIntervalSince1970 * 1000)
    }

    var pollInterval: TimeInterval {
        bridgeReachable ? (fastPolling ? 5 : 30) : backoff.delay
    }

    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                let delay = self?.pollInterval ?? 30
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    private func tick() async {
        guard let client else {
            lastError = .unreachable("token file not found — check the data dir in Settings")
            bridgeReachable = false
            return
        }
        do {
            let fresh = try await client.status()
            status = fresh
            bridgeReachable = true
            lastError = nil
            backoff.recordSuccess()
        } catch let error as AdminError {
            lastError = error
            bridgeReachable = false
            backoff.recordFailure()
        } catch {
            lastError = .unreachable(error.localizedDescription)
            bridgeReachable = false
            backoff.recordFailure()
        }
    }

    /// One-shot helpers the views use for non-status routes; errors surface via `lastError`.
    func withClient<T>(_ body: @Sendable (AdminClient) async throws -> T) async throws -> T {
        guard let client else { throw AdminError.unreachable("token file not found — check the data dir in Settings") }
        return try await body(client)
    }

    private func scheduleNext(immediate: Bool) {
        // The run loop picks the new interval up on the next sleep; immediate
        // re-tick keeps the panel snappy when it opens.
        if immediate { pollTask?.cancel(); pollTask = nil; startPolling() }
    }

    private func persistAndReload() {
        defaults.set(dataDirPath, forKey: "dataDirPath")
        defaults.set(baseURLString, forKey: "baseURLString")
        reloadEndpoint()
    }

    private func reloadEndpoint() {
        guard let url = URL(string: baseURLString),
              let loaded = AdminClient.loadEndpoint(dataDirPath: dataDirPath, baseURL: url) else {
            endpoint = nil
            client = nil
            return
        }
        endpoint = loaded
        client = AdminClient(endpoint: loaded)
    }
}
```

- [ ] **Step 2: Build** `swift build` — SUCCEEDED. (`swift test` still passes — LogicTests only touches `Backoff`/`IconState`, which this task does not change.)

- [ ] **Step 3: Commit**

```bash
git add macos/BridgeBar/Sources/BridgeBar/Core/StatusStore.swift
git commit -m "feat(macos): status polling store with endpoint config"
```

### Task 11: Menu panel + pairing QR sheet

**Files:**
- Modify: `macos/BridgeBar/Sources/BridgeBar/Views/MenuPanelView.swift` (replace placeholder)
- Create: `macos/BridgeBar/Sources/BridgeBar/Views/PairingSheet.swift`

- [ ] **Step 1: `MenuPanelView.swift`**

```swift
import SwiftUI

struct MenuPanelView: View {
    @Environment(StatusStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @State private var showPairing = false
    @State private var confirmRevoke = false
    @State private var busy = false

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 10) {
            statusCard
            if let error = store.lastError {
                Label(message(for: error), systemImage: "exclamationmark.bubble")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            Button { showPairing = true } label: { Label("配对新设备", systemImage: "qrcode") }
            Button(role: .destructive) { confirmRevoke = true } label: {
                Label(store.status?.device == nil ? "撤销设备（无设备）" : "撤销此设备", systemImage: "iphone.slash")
            }
            .disabled(store.status?.device == nil || busy)
            Divider()
            Button { openWindow(id: "main") } label: { Label("打开管理窗口", systemImage: "macwindow") }
            SettingsLink { Label("设置…", systemImage: "gearshape") }
            Divider()
            Button(role: .destructive) { NSApplication.shared.terminate(nil) } label: {
                Label("退出 BridgeBar", systemImage: "power")
            }
        }
        .padding(12)
        .frame(width: 280)
        .onAppear { store.fastPolling = true }
        .onDisappear { store.fastPolling = false }
        .sheet(isPresented: $showPairing) { PairingSheet() }
        .confirmationDialog("撤销后手机会立即断开，需要重新扫码配对", isPresented: $confirmRevoke, titleVisibility: .visible) {
            Button("撤销设备", role: .destructive) {
                guard let deviceId = store.status?.device?.deviceId else { return }
                busy = true
                Task {
                    defer { busy = false }
                    try? await store.withClient { try await $0.revokeDevice(deviceId) }
                }
            }
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: store.icon.symbolName)
                Text(store.bridgeReachable ? "Bridge 在线" : "Bridge 未运行").bold()
                Spacer()
                Text("v\(store.status?.version ?? "?")").font(.caption).foregroundStyle(.secondary)
            }
            if let s = store.status {
                row("运行时长", Self.duration(s.uptimeSeconds))
                row("隧道", s.publicReachable == nil ? "本机模式" : (s.publicReachable! ? "可达" : "不可达"))
                row("活跃会话", "\(s.activeSessions)")
                if let device = s.device {
                    row("设备", device.displayName + " · " + Self.expiryText(device.sessionExpiresAt))
                }
            }
            if !store.bridgeReachable {
                HStack(spacing: 4) {
                    Text(Self.startBridgeCommand)
                        .font(.system(.caption2, design: .monospaced))
                        .lineLimit(1).truncationMode(.middle)
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(Self.startBridgeCommand, forType: .string)
                    } label: { Image(systemName: "doc.on.doc") }
                        .buttonStyle(.borderless)
                }
            }
        }
    }

    private func row(_ key: String, _ value: String) -> some View {
        HStack { Text(key); Spacer(); Text(value).foregroundStyle(.secondary) }.font(.caption)
    }

    private func message(for error: AdminError) -> String {
        switch error {
        case .unreachable(let why): "连不上 admin API：\(why)"
        case .unauthorized: "token 与 bridge 不匹配，检查设置里的 data dir"
        case .api(let code, let message): "[\(code)] \(message)"
        }
    }

    static func duration(_ seconds: Int) -> String {
        let d = seconds / 86400, h = seconds % 86400 / 3600, m = seconds % 3600 / 60
        if d > 0 { return "\(d)天\(h)时" }
        if h > 0 { return "\(h)时\(m)分" }
        return "\(m)分"
    }

    /// Spec §7: show the restart command, never execute it.
    static let startBridgeCommand = "launchctl kickstart -k gui/501/dev.clauderemote.bridge"

    static func expiryText(_ expiresAtMs: Double?) -> String {
        guard let ms = expiresAtMs else { return "无会话" }
        let remainSeconds = Int((ms - Date.now.timeIntervalSince1970 * 1000) / 1000)
        if remainSeconds <= 0 { return "已过期" }
        if remainSeconds < 3600 { return "会话 \(remainSeconds / 60) 分钟后过期" }
        return "会话 \(remainSeconds / 3600) 小时后过期"
    }
}
```

- [ ] **Step 2: `PairingSheet.swift`** — fetches a code, renders the QR with CoreImage; on `already_paired` offers the revoke-then-retry flow (spec §7).

```swift
import CoreImage.CIFilterBuiltins
import SwiftUI

struct PairingSheet: View {
    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var code: PairingCode?
    @State private var error: AdminError?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 14) {
            Text("配对新设备").font(.headline)
            if let code {
                if let image = Self.qrImage(for: code.payload) {
                    Image(nsImage: image).interpolation(.none)
                        .resizable().frame(width: 220, height: 220)
                }
                Text("有效期至 \(Self.time(code.expiresAt))").font(.caption).foregroundStyle(.secondary)
            } else if let error {
                errorView(error)
            } else {
                ProgressView().controlSize(.large)
            }
            Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
        }
        .padding(18)
        .frame(width: 300)
        .task { if code == nil && error == nil { fetch() } }
    }

    private func fetch() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do { code = try await store.withClient { try await $0.pairingQRCode() } }
            catch let e as AdminError { error = e }
        }
    }

    @ViewBuilder
    private func errorView(_ error: AdminError) -> some View {
        switch error {
        case .api(let code, _) where code == "already_paired":
            VStack(spacing: 8) {
                Text("已有设备配对。撤销旧设备并重新配对？").font(.callout)
                Button("撤销并出码", role: .destructive) {
                    Task {
                        try? await store.withClient { try await $0.revokeAllDevices() }
                        fetch()
                    }
                }
            }
        case .api(let code, _) where code == "public_host_unset":
            // Spec §7: dedicated hint, no retry button — the precondition is on
            // the operator side (set BRIDGE_PUBLIC_HOST, restart bridge).
            Text("Bridge 未设置公网地址：设置 BRIDGE_PUBLIC_HOST 并重启 bridge 后再出码")
                .font(.callout).multilineTextAlignment(.center)
        case .api(let code, let message):
            VStack(spacing: 8) {
                Text("[\(code)] \(message)").font(.callout)
                Button("重试") { fetch() }
            }
        default:
            VStack(spacing: 8) {
                Text("无法出码：\(error)").font(.callout)
                Button("重试") { fetch() }
            }
        }
    }

    private static func time(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        return date.formatted(date: .omitted, time: .shortened)
    }

    /// System QR generator — no third-party dependency.
    static func qrImage(for string: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
```

- [ ] **Step 3: Add the expiry/countdown formatter tests** — append to `Tests/BridgeBarTests/LogicTests.swift` (spec §8 lists 会话过期倒计时格式化 among app-side tests; the +30s margins keep Int division stable against the second `Date.now` read inside `expiryText`):

```swift
@Test func expiryTextFormats() {
    let nowMs = Date.now.timeIntervalSince1970 * 1000
    #expect(MenuPanelView.expiryText(nil) == "无会话")
    #expect(MenuPanelView.expiryText(nowMs - 1_000) == "已过期")
    #expect(MenuPanelView.expiryText(nowMs + 30 * 60_000 + 30_000) == "会话 30 分钟后过期")
    #expect(MenuPanelView.expiryText(nowMs + 5 * 3_600_000 + 30_000) == "会话 5 小时后过期")
}
```

- [ ] **Step 4: Build & test** `swift build && swift test` — BUILD SUCCEEDED, ALL PASS (6 tests total: 3 AdminClientTests + 3 LogicTests).

- [ ] **Step 5: Commit**

```bash
git add macos/BridgeBar/Sources/BridgeBar/Views macos/BridgeBar/Tests/BridgeBarTests/LogicTests.swift
git commit -m "feat(macos): menu panel status card and pairing QR sheet"
```

## Chunk 3: Management window, settings + live E2E

### Task 12: Management window — 5 tabs

**Files:**
- Modify: `macos/BridgeBar/Sources/BridgeBar/Views/MainWindow.swift` (replace placeholder)
- Create: `macos/BridgeBar/Sources/BridgeBar/Views/Tabs.swift` (all five tab views; each is small and they change together)

- [ ] **Step 1: `MainWindow.swift`**

```swift
import SwiftUI

struct MainWindow: View {
    var body: some View {
        TabView {
            ProjectsTab().tabItem { Label("项目", systemImage: "folder.badge.gearshape") }
            DevicesTab().tabItem { Label("设备", systemImage: "iphone") }
            SessionsTab().tabItem { Label("会话", systemImage: "terminal") }
            AuditTab().tabItem { Label("审计", systemImage: "list.bullet.rectangle") }
            LogsTab().tabItem { Label("日志", systemImage: "doc.text") }
        }
        .frame(minWidth: 640, minHeight: 420)
    }
}
```

- [ ] **Step 2: `Tabs.swift`**

```swift
import SwiftUI

// MARK: - Projects

struct ProjectsTab: View {
    @Environment(StatusStore.self) private var store
    @State private var projects: [Project] = []
    @State private var errorText: String?
    @State private var showPicker = false
    @State private var pickedURL: URL?
    @State private var projectName = ""
    @State private var confirmDelete: Project?

    var body: some View {
        Table(projects) {
            TableColumn("名称") { $0.displayName }
            TableColumn("路径") { Text($0.canonicalRealpath).font(.system(.caption, design: .monospaced)) }
            TableColumn("授权于") { Text(Self.date($0.authorizedAt)) }
            TableColumn("操作") { project in
                Button("撤销授权", role: .destructive) { confirmDelete = project }
                    .buttonStyle(.borderless)
            }
        }
        .overlay { if projects.isEmpty { ContentUnavailableView("暂无授权项目", systemImage: "folder") } }
        .safeAreaInset(edge: .bottom) {
            HStack {
                TextField("项目名称", text: $projectName).frame(width: 160)
                Button("选择目录…") { showPicker = true }
                Button("授权") { authorize() }
                    .disabled(pickedURL == nil || projectName.trimmingCharacters(in: .whitespaces).isEmpty)
                Spacer()
            }
            .padding(8)
        }
        .alert("操作失败", isPresented: .init(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
            Button("好") {}
        } message: { Text(errorText ?? "") }
        .confirmationDialog(
            "撤销「\(confirmDelete?.displayName ?? "")」的授权？",
            isPresented: .init(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("撤销授权", role: .destructive) {
                guard let project = confirmDelete else { return }
                Task {
                    do {
                        try await store.withClient { try await $0.deleteProject(project.projectId) }
                        reload()
                    } catch { errorText = "\(error)" }
                }
            }
        }
        .sheet(isPresented: $showPicker) {
            NSOpenPanelView { url in pickedURL = url }
        }
        .task { reload() }
    }

    private func reload() {
        Task {
            do { projects = try await store.withClient { try await $0.projects() } }
            catch { errorText = "\(error)" }
        }
    }

    private func authorize() {
        guard let url = pickedURL else { return }
        Task {
            do {
                _ = try await store.withClient { try await $0.authorizeProject(path: url.path, name: projectName) }
                pickedURL = nil; projectName = ""
                reload()
            } catch { errorText = "\(error)" }
        }
    }

    static func date(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}

/// NSOpenPanel wrapped for SwiftUI (directory chooser).
private struct NSOpenPanelView: View {
    @Environment(\.dismiss) private var dismiss
    let onPick: (URL?) -> Void

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .task {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                if panel.runModal() == .OK { onPick(panel.url) } else { onPick(nil) }
                dismiss()
            }
    }
}

// MARK: - Devices

struct DevicesTab: View {
    @Environment(StatusStore.self) private var store
    @State private var devices = DeviceList(active: nil, revoked: [])
    @State private var errorText: String?
    @State private var confirmRevoke = false

    var body: some View {
        List {
            if let active = devices.active {
                Section("当前设备") {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(active.displayName).bold()
                            Text("配对于 \(ProjectsTab.date(active.pairedAt))").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("撤销", role: .destructive) { confirmRevoke = true }
                    }
                }
            } else {
                ContentUnavailableView("无配对设备", systemImage: "iphone.slash")
            }
            if !devices.revoked.isEmpty {
                Section("已撤销") {
                    ForEach(devices.revoked) { device in
                        VStack(alignment: .leading) {
                            Text(device.displayName).strikethrough()
                            Text("撤销于 \(ProjectsTab.date(device.revokedAt ?? 0))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .alert("操作失败", isPresented: .init(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
            Button("好") {}
        } message: { Text(errorText ?? "") }
        .confirmationDialog("撤销后手机会立即断开，需要重新扫码配对", isPresented: $confirmRevoke, titleVisibility: .visible) {
            Button("撤销设备", role: .destructive) {
                guard let id = devices.active?.deviceId else { return }
                Task {
                    do { try await store.withClient { try await $0.revokeDevice(id) }; reload() }
                    catch { errorText = "\(error)" }
                }
            }
        }
        .task { reload() }
    }

    private func reload() {
        Task {
            do { devices = try await store.withClient { try await $0.devices() } }
            catch { errorText = "\(error)" }
        }
    }
}

// MARK: - Sessions (read-only)

struct SessionsTab: View {
    @Environment(StatusStore.self) private var store
    @State private var sessions: [SessionRow] = []

    var body: some View {
        Table(sessions) {
            TableColumn("会话") { $0.displayName }
            TableColumn("项目") { $0.projectDisplayName }
            TableColumn("状态") { row in
                Text(row.status).foregroundStyle(row.status == "running" ? Color.green : Color.secondary)
            }
            TableColumn("锁") { row in Text(row.lockedBy ?? "—").font(.caption) }
            TableColumn("最近活动") { Text(ProjectsTab.date($0.lastActivityAt)) }
        }
        .overlay { if sessions.isEmpty { ContentUnavailableView("暂无会话", systemImage: "terminal") } }
        .refreshable { reload() }
        .task { reload() }
    }

    private func reload() {
        Task { sessions = (try? await store.withClient { try await $0.sessions() }) ?? sessions }
    }
}

// MARK: - Audit

struct AuditTab: View {
    @Environment(StatusStore.self) private var store
    @State private var rows: [AuditRow] = []
    @State private var nextCursor: Int?

    var body: some View {
        Table(rows) {
            TableColumn("时间") { Text(ProjectsTab.date($0.occurredAt)) }.width(min: 120, ideal: 150)
            TableColumn("操作") { $0.operationType }
            TableColumn("结果") { row in
                Text(row.resultCode).foregroundStyle(row.resultCode == "ok" ? Color.green : Color.orange)
            }
            TableColumn("设备") { Text($0.deviceId ?? "—").font(.caption) }
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                Spacer()
                if nextCursor != nil {
                    Button("加载更多") { loadMore() }
                } else {
                    Text("没有更多了").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(6)
        }
        .task { if rows.isEmpty { loadMore() } }
    }

    private func loadMore() {
        Task {
            guard let page = try? await store.withClient({ try await $0.audit(limit: 50, cursor: nextCursor) }) else { return }
            rows += page.items
            nextCursor = page.nextCursor
        }
    }
}

// MARK: - Logs

struct LogsTab: View {
    @Environment(StatusStore.self) private var store
    @State private var file = "out"
    @State private var content = ""
    @State private var paused = false

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $file) {
                Text("stdout").tag("out"); Text("stderr").tag("err")
            }
            .pickerStyle(.segmented).frame(width: 160).padding(8)
            HStack {
                Button(paused ? "继续" : "暂停") { paused.toggle() }
                Spacer()
                Text("\(content.utf16.count) 字符").font(.caption).foregroundStyle(.secondary)
            }.padding(.horizontal, 12)
            ScrollViewReader { proxy in
                ScrollView {
                    Text(content.isEmpty ? "（空）" : content)
                        .font(.system(size: 11, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .id("bottom")
                }
                .onChange(of: content) { _, _ in
                    if !paused { proxy.scrollTo("bottom") }
                }
            }
        }
        .task(id: file) {
            while !Task.isCancelled {
                if !paused, let tail = try? await store.withClient({ try await $0.logTail(file: file, bytes: 32_768) }) {
                    content = tail.content
                }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
}
```

- [ ] **Step 3: Build** `swift build` — SUCCEEDED. Quick manual smoke with the bridge running: `swift run`, open the window, watch 项目/审计 load.

- [ ] **Step 4: Commit**

```bash
git add macos/BridgeBar/Sources/BridgeBar/Views
git commit -m "feat(macos): management window with projects/devices/sessions/audit/logs tabs"
```

### Task 13: Settings + login item

**Files:**
- Modify: `macos/BridgeBar/Sources/BridgeBar/Views/SettingsView.swift` (replace placeholder)

- [ ] **Step 1: `SettingsView.swift`**

```swift
import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @Environment(StatusStore.self) private var store
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginItemError: String?

    var body: some View {
        @Bindable var store = store
        Form {
            Section("连接") {
                TextField("Data 目录", text: $store.dataDirPath)
                TextField("Admin 地址", text: $store.baseURLString)
                LabeledContent("Token 状态") {
                    if store.endpoint != nil {
                        Label("已读取", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        Label("未找到 admin-api-token", systemImage: "xmark.circle.fill").foregroundStyle(.red)
                    }
                }
            }
            Section("登录项") {
                Toggle("开机自动启动", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in
                        do {
                            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                            loginItemError = nil
                        } catch { loginItemError = "\(error)" }
                    }
                if let loginItemError {
                    Text(loginItemError).font(.caption).foregroundStyle(.red)
                }
                Text("`swift run` 的裸进程无法注册登录项；用 make-app.sh 打包后从 /Applications 运行再开启。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 420)
    }
}
```

Caveat: `SMAppService.mainApp.register()` only works for a real `.app` bundle — running via `swift run` throws, which the caption explains and the toggle surfaces. The TextFields bind straight to the store's `didSet`-persisted properties, so every keystroke reloads token/endpoint — deliberate: a half-typed path just fails the token read (shows 未找到) and the wiring stays one line.

- [ ] **Step 2: Build + full test** `swift build && swift test` — SUCCEEDED / ALL PASS. Rebuild the bundle: `./scripts/make-app.sh`.

- [ ] **Step 3: Commit**

```bash
git add macos/BridgeBar/Sources/BridgeBar/Views/SettingsView.swift
git commit -m "feat(macos): settings pane with endpoint config and login item"
```

### Task 14: Live E2E against the real bridge (manual, no new code)

**Files:** none (verification only; update `macos/BridgeBar/README.md` if any step revealed wrong instructions)

This task requires the operator's Mac: bridge launchd service + cloudflared tunnel + the paired Android phone. Run each step and record PASS/FAIL in the PR description.

- [ ] **Step 1: Restart the bridge with the new build.** `cd bridge && npm run build`, then `launchctl bootout gui/501/dev.clauderemote.bridge && launchctl bootstrap gui/501 ~/Library/LaunchAgents/dev.clauderemote.bridge.plist`. Verify: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:43112/admin/v1/status` → `401` (admin API up, auth enforced).

- [ ] **Step 2: Confirm the admin port is NOT tunnel-reachable.** Source the host from the launchd env file rather than hardcoding it (the `tr` strips quotes so both `KEY=value` and `KEY="value"` formats work): `HOST=$(sed -n 's/^BRIDGE_PUBLIC_HOST=//p' ~/Library/LaunchAgents/dev.clauderemote.bridge.env | tr -d '"' | tr -d "'")`, then `curl -s -o /dev/null -w '%{http_code}' "https://$HOST/admin/v1/status"` → expect a Cloudflare Access redirect/401 page (the route exists only behind CF auth; the admin Fastify is a different listener). If it ever answers 401 from the admin server itself, STOP — the tunnel is proxying the admin port, which violates the spec's core invariant.

- [ ] **Step 3: Icon states.** Launch BridgeBar (`open macos/BridgeBar/build/release/BridgeBar.app`). Expect green. Stop cloudflared (`launchctl bootout gui/501/dev.clauderemote.cloudflared`) → within one poll cycle the icon turns yellow, panel shows 隧道不可达. Restart cloudflared → green. Stop the bridge → red with「Bridge 未运行」. Restore both.

- [ ] **Step 4: Revocation is immediate.** With the phone connected (send it a message to confirm live traffic), click 撤销此设备 → confirm. PASS criteria: the phone's connection drops immediately (会话页 shows 断开, no need to wait for the next request), and the audit tab shows `admin.revoke_device`.

- [ ] **Step 5: Pairing round-trip.** 配对新设备 → QR sheet renders → scan with the phone → complete OAuth → the panel's 设备 card shows the new device. Then verify the `already_paired` flow: try 配对 again while a device is active → confirm dialog 撤销并出码 works end-to-end.

- [ ] **Step 6: Project authorize/revoke.** In 项目 tab authorize a scratch directory, confirm it appears on the phone's project picker (project.list), then revoke it from the GUI and confirm it disappears from the picker after refresh.

- [ ] **Step 7: Logs + audit tabs.** Generate activity (any session message), confirm 日志 tab streams new lines and 审计 tab shows today's `admin.*` / `auth.*` events paginated.

- [ ] **Step 8: Record results.** Note any FAIL plus repro in the PR/commit message of the fix that follows; do not mark the plan complete with a silent FAIL.


