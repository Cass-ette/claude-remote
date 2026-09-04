import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ROTATED_FILES,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_ROTATE_BYTES,
  MAX_DETAIL_LENGTH,
  MAX_REDACT_DEPTH,
  createAuditLog,
  redact,
  type AuditLog,
} from "../../src/audit/audit-log.js";
import { migrate, openDatabase, transaction, type SqliteDatabase } from "../../src/db/database.js";

/** Fixed epoch (2026-09-01T00:00:00Z) used as the injected clock. */
const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

let dataDir: string;
let db: SqliteDatabase;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "bridge-audit-test-"));
  db = openDatabase(join(dataDir, "bridge.db"));
  migrate(db);
});

afterEach(() => {
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function logPath(): string {
  return join(dataDir, "audit.jsonl");
}

function rotatedPath(index: number): string {
  return `${logPath()}.${index}`;
}

function openAuditLog(overrides: Record<string, unknown> = {}): AuditLog {
  return createAuditLog({ filePath: logPath(), db, now: () => T0, ...overrides });
}

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function lineAt(path: string, index: number): Record<string, unknown> {
  const lines = readLines(path);
  expect(lines.length, `expected at least ${index + 1} lines`).toBeGreaterThan(index);
  return lines[index] as Record<string, unknown>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// redact()
// ---------------------------------------------------------------------------

describe("redact", () => {
  it("passes benign values through", () => {
    expect(redact("session s1 started for project p2")).toBe("session s1 started for project p2");
    expect(redact(42)).toBe("42");
    expect(redact(true)).toBe("true");
    expect(redact(null)).toBe("null");
    expect(redact(undefined)).toBe("undefined");
    expect(redact({ ok: true, count: 3, note: "no secrets" })).toBe(
      '{"ok":true,"count":3,"note":"no secrets"}',
    );
  });

  const forbiddenKeys = [
    "authorization",
    "Authorization",
    "AUTHORIZATION",
    "cookie",
    "set-cookie",
    "cf-access-jwt-assertion",
    "Cf-Access-Jwt-Assertion",
    "x-claude-remote-device-session",
    "X-Claude-Remote-Device-Session",
    "token",
    "apiKey",
    "api_key",
    "secret",
    "password",
    "refreshToken",
    "accessToken",
    "bearer",
  ];

  it.each(forbiddenKeys)("redacts the %s key case-insensitively", (key) => {
    const out = redact({ [key]: "super-secret-value", keep: "ok" });
    expect(out).toContain('"[REDACTED]"');
    expect(out).toContain('"keep":"ok"');
    expect(out).not.toContain("super-secret-value");
  });

  it("redacts forbidden keys in nested objects and arrays", () => {
    const input = {
      outer: { inner: { apiKey: "nested-key-value", safe: "yes" } },
      list: [{ token: "array-token-value" }, "plain"],
    };
    const out = redact(input);
    expect(out).not.toContain("nested-key-value");
    expect(out).not.toContain("array-token-value");
    expect(out).toContain('"[REDACTED]"');
    expect(out).toContain('"safe":"yes"');
    expect(out).toContain('"plain"');
  });

  it("redacts Anthropic-style API keys and honors the 20-char boundary", () => {
    const longKey = `sk-${"a".repeat(30)}`;
    const shortKey = `sk-${"b".repeat(19)}`;
    const out = redact(`call failed with ${longKey} then ${shortKey}`);
    expect(out).toContain("[REDACTED:key]");
    expect(out).not.toContain(longKey);
    // 19 trailing chars is below the {20,} threshold and stays visible.
    expect(out).toContain(shortKey);
  });

  it("redacts Bearer credentials", () => {
    const out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIs abc-_123 rejected");
    expect(out).toContain("[REDACTED:bearer]");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIs");
  });

  it("redacts AWS access key ids and honors the 16-char boundary", () => {
    const valid = `AKIA${"ABCDEFGHIJKLMNOP"}`; // 16 trailing chars
    const tooShort = `AKIA${"ABCDEFGHIJKLMNO"}`; // 15 trailing chars
    const out = redact(`saw ${valid} and ${tooShort}`);
    expect(out).toContain("[REDACTED:aws]");
    expect(out).not.toContain(valid);
    expect(out).toContain(tooShort);
  });

  it("redacts home-directory prefixes while keeping the tail for ops", () => {
    expect(redact("failed to open /Users/alice/proj/src/main.ts")).toBe(
      "failed to open /Users/[REDACTED]/proj/src/main.ts",
    );
    expect(redact("/home/bob/proj/x.ts")).toBe("/home/[REDACTED]/proj/x.ts");
    expect(redact("bare /Users/alice")).toBe("bare /Users/[REDACTED]");
  });

  it("redacts high-entropy base64 runs longer than 32 chars", () => {
    const b64 = "abcdefghij+kLMNOPqrstuvwxyz012345+6789"; // 39 chars, standard charset
    const b64url = `QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk${"=="}`;
    const exact32 = "abcdefghij+kLMNOPqrstuvwxyz0123"; // 32 chars: below threshold
    const out = redact(`got ${b64} and ${b64url} kept ${exact32}`);
    expect(out.match(/\[REDACTED:b64\]/g)).toHaveLength(2);
    expect(out).not.toContain(b64);
    expect(out).not.toContain(b64url);
    expect(out).toContain(exact32);
  });

  it("applies the pattern scan to strings nested inside objects", () => {
    const key = `sk-${"c".repeat(40)}`;
    const out = redact({ error: `key ${key} rejected`, header: "Bearer zzz" });
    expect(out).toContain("[REDACTED:key]");
    expect(out).toContain("[REDACTED:bearer]");
    expect(out).not.toContain(key);
  });

  it("caps string length with a truncation marker", () => {
    const long = "benign filler text ".repeat(400); // ~7600 chars, no 33+ char runs
    const out = redact(long);
    expect(out).toContain("[TRUNCATED:length]");
    expect(out.length).toBeLessThanOrEqual(MAX_DETAIL_LENGTH + "[TRUNCATED:length]".length);
    expect(out.startsWith(long.slice(0, MAX_DETAIL_LENGTH))).toBe(true);
  });

  it("caps object depth", () => {
    let deep: unknown = { leaf: "bottom" };
    for (let i = 0; i < 10; i += 1) deep = { child: deep };
    expect(redact(deep)).toContain("[TRUNCATED:depth]");
    // A shallow object stays untouched by the depth cap.
    expect(redact({ a: { b: { c: 1 } } })).not.toContain("[TRUNCATED:depth]");
    expect(MAX_REDACT_DEPTH).toBe(6);
  });

  it("terminates on circular references", () => {
    const node: Record<string, unknown> = { name: "cycle" };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
    expect(redact(node)).toContain("[TRUNCATED:depth]");
  });
});

// ---------------------------------------------------------------------------
// File lifecycle: mode, rotation, retention
// ---------------------------------------------------------------------------

describe("audit log file lifecycle", () => {
  it("creates the log with owner-only mode 0600 and keeps it after writes", () => {
    const log = openAuditLog();
    expect(fileMode(logPath())).toBe(0o600);
    log.write({ operationType: "bridge.start", resultCode: "ok" });
    log.write({ operationType: "bridge.stop", resultCode: "ok" });
    expect(fileMode(logPath())).toBe(0o600);
  });

  it("re-asserts mode 0600 on an existing file at open", () => {
    writeFileSync(logPath(), "{}\n");
    chmodSync(logPath(), 0o644);
    openAuditLog();
    expect(fileMode(logPath())).toBe(0o600);
  });

  it("defaults to 10 MiB rotation, five rotated files, thirty days", () => {
    expect(DEFAULT_ROTATE_BYTES).toBe(10 * 1024 * 1024);
    expect(DEFAULT_MAX_ROTATED_FILES).toBe(5);
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
  });

  it("rotates when the current file reaches rotateBytes and keeps five rotated files", () => {
    // Tiny threshold: every few entries trigger a rotation; default
    // maxRotatedFiles stays 5, so after ~15 rotations only .1..5 survive.
    const log = openAuditLog({ rotateBytes: 400 });
    for (let i = 0; i < 30; i += 1) {
      log.write({
        operationType: "device.session.renew",
        resultCode: "ok",
        deviceId: "dev-1",
        detail: `rotation filler number ${i} with some padding to grow the line`,
      });
    }
    for (let i = 1; i <= 5; i += 1) {
      expect(existsSync(rotatedPath(i)), `rotated file .${i}`).toBe(true);
    }
    expect(existsSync(rotatedPath(6))).toBe(false);
    expect(existsSync(logPath())).toBe(true);
    // Every rotated file is valid JSONL with structured records only.
    for (let i = 1; i <= 5; i += 1) {
      const lines = readLines(rotatedPath(i));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.operationType).toBe("device.session.renew");
    }
    // The recreated current file AND every rotated file stay owner-only:
    // rotation renames the current away and the next append recreates it.
    expect(statSync(logPath()).mode & 0o777).toBe(0o600);
    for (let i = 1; i <= 5; i += 1) {
      expect(statSync(rotatedPath(i)).mode & 0o777, `rotated .${i} mode`).toBe(0o600);
    }
  });

  it("rotates at least twice and shifts .1 to .2", () => {
    const log = openAuditLog({ rotateBytes: 400 });
    for (let i = 0; i < 8; i += 1) {
      log.write({ operationType: "noop", resultCode: "ok", detail: `rotation entry ${i}` });
    }
    expect(existsSync(rotatedPath(1))).toBe(true);
    expect(existsSync(rotatedPath(2))).toBe(true);
    // The newest rotated file (.1) holds entries written after the previous
    // rotation; the entries shifted into .2 are strictly older.
    const one = readLines(rotatedPath(1)).map((l) => l.redactedDetail);
    const two = readLines(rotatedPath(2)).map((l) => l.redactedDetail);
    expect(one.length).toBeGreaterThan(0);
    expect(two.length).toBeGreaterThan(0);
    expect(two.join(" ")).not.toContain(String(one[one.length - 1] ?? ""));
  });

  it("deletes rotated and current files older than the retention window on open", () => {
    writeFileSync(logPath(), '{"old":true}\n');
    writeFileSync(rotatedPath(1), '{"old":true}\n');
    writeFileSync(rotatedPath(2), '{"fresh":true}\n');
    const expired = new Date(T0 - (DEFAULT_RETENTION_DAYS + 1) * DAY_MS);
    const fresh = new Date(T0 - (DEFAULT_RETENTION_DAYS - 1) * DAY_MS);
    utimesSync(logPath(), expired, expired);
    utimesSync(rotatedPath(1), expired, expired);
    utimesSync(rotatedPath(2), fresh, fresh);

    const log = openAuditLog();
    // Expired current and .1 were removed; the current file is recreated empty.
    expect(existsSync(rotatedPath(1))).toBe(false);
    expect(statSync(logPath()).size).toBe(0);
    // The 29-day-old .2 survives (thirty-day cap, "whichever comes first").
    expect(existsSync(rotatedPath(2))).toBe(true);
    // Writing works after the sweep.
    log.write({ operationType: "bridge.start", resultCode: "ok" });
    expect(readLines(logPath())).toHaveLength(1);
  });

  it("keeps fresh rotated files across reopen", () => {
    const log = openAuditLog({ rotateBytes: 300 });
    for (let i = 0; i < 10; i += 1) {
      log.write({ operationType: "noop", resultCode: "ok", detail: "z".repeat(150) });
    }
    expect(existsSync(rotatedPath(1))).toBe(true);
    openAuditLog({ rotateBytes: 300 });
    expect(existsSync(rotatedPath(1))).toBe(true);
    expect(readLines(rotatedPath(1)).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Audit entries: structured fields, hashing, dual write
// ---------------------------------------------------------------------------

describe("audit log entries", () => {
  it("writes a §10.6 structured record to the JSONL file", () => {
    const log = openAuditLog();
    const record = log.write({
      operationType: "device.session.start",
      resultCode: "ok",
      accessSubject: "user-123@example.com",
      deviceId: "dev-1",
      rayId: "ray-abc",
      sourceIp: "203.0.113.9",
      requestId: "req-1",
      sessionId: "sess-1",
      projectId: "proj-1",
      toolCategory: "bash",
      permissionDecision: "allow",
      detail: "session started",
    });

    expect(record.auditId).toBe(1);
    expect(record.occurredAt).toBe(T0);
    expect(record.accessSubjectHash).toBe(sha256Hex("user-123@example.com"));

    const line = lineAt(logPath(), 0);
    expect(line.auditId).toBe(1);
    expect(line.occurredAt).toBe(T0);
    expect(line.accessSubjectHash).toBe(sha256Hex("user-123@example.com"));
    expect(line.deviceId).toBe("dev-1");
    expect(line.rayId).toBe("ray-abc");
    expect(line.sourceIp).toBe("203.0.113.9");
    expect(line.requestId).toBe("req-1");
    expect(line.operationType).toBe("device.session.start");
    expect(line.sessionId).toBe("sess-1");
    expect(line.projectId).toBe("proj-1");
    expect(line.resultCode).toBe("ok");
    expect(line.toolCategory).toBe("bash");
    expect(line.permissionDecision).toBe("allow");
    expect(line.redactedDetail).toBe("session started");

    // The raw Access subject never appears in the file.
    expect(readFileSync(logPath(), "utf8")).not.toContain("user-123@example.com");
  });

  it("inserts the same record into the audit_events table", () => {
    const log = openAuditLog();
    log.write({
      operationType: "device.pairing.completed",
      resultCode: "ok",
      accessSubject: "subject-a",
      deviceId: "dev-2",
      detail: "paired",
    });
    const rows = db
      .prepare(
        `SELECT occurredAt, accessSubjectHash, deviceId, rayId, sourceIp, requestId, operationType,
                sessionId, projectId, resultCode, toolCategory, permissionDecision, redactedDetail
         FROM audit_events`,
      )
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      occurredAt: T0,
      accessSubjectHash: sha256Hex("subject-a"),
      deviceId: "dev-2",
      rayId: null,
      sourceIp: null,
      requestId: null,
      operationType: "device.pairing.completed",
      sessionId: null,
      projectId: null,
      resultCode: "ok",
      toolCategory: null,
      permissionDecision: null,
      redactedDetail: "paired",
    });
  });

  it("redacts free-form detail before both stores", () => {
    const bearerToken = "eyJhbGciOiJSUzI1NiJ9.supersecret";
    const apiKey = `sk-${"d".repeat(35)}`;
    const log = openAuditLog();
    log.write({
      operationType: "auth.failed",
      resultCode: "4401",
      detail: `Authorization: Bearer ${bearerToken} rejected for /Users/bob/secretproj with key ${apiKey}`,
    });

    const line = lineAt(logPath(), 0);
    expect(line.redactedDetail).toContain("[REDACTED:bearer]");
    expect(line.redactedDetail).toContain("[REDACTED:key]");
    expect(line.redactedDetail).toContain("/Users/[REDACTED]/secretproj");

    const wholeFile = readFileSync(logPath(), "utf8");
    expect(wholeFile).not.toContain(bearerToken);
    expect(wholeFile).not.toContain(apiKey);
    expect(wholeFile).not.toContain("/Users/bob");

    const row = db.prepare("SELECT redactedDetail FROM audit_events").get() as {
      redactedDetail: string;
    };
    expect(row.redactedDetail).toBe(line.redactedDetail);
  });

  it("stores nulls for absent optional fields and increments auditId", () => {
    const log = openAuditLog();
    const first = log.write({ operationType: "bridge.start", resultCode: "ok" });
    const second = log.write({ operationType: "bridge.stop", resultCode: "ok" });
    expect(first.auditId).toBe(1);
    expect(second.auditId).toBe(2);
    const line = lineAt(logPath(), 1);
    expect(line.accessSubjectHash).toBeNull();
    expect(line.deviceId).toBeNull();
    expect(line.redactedDetail).toBeNull();
    expect(line.sessionId).toBeNull();
  });

  it("carries the committed flag in the JSONL trail", () => {
    const log = openAuditLog();
    log.write({ operationType: "session.state", resultCode: "ok", committed: false });
    const line = lineAt(logPath(), 0);
    expect(line.committed).toBe(false);
    // Omitted when not provided.
    log.write({ operationType: "session.state", resultCode: "ok" });
    expect("committed" in lineAt(logPath(), 1)).toBe(false);
  });

  it("never emits fields beyond the §10.6 schema (no prompt/tool payloads)", () => {
    const log = openAuditLog();
    log.write({ operationType: "a.b", resultCode: "ok", detail: { nested: "text" } });
    log.write({ operationType: "c.d", resultCode: "deny", committed: true });
    const allowed = new Set([
      "auditId",
      "occurredAt",
      "occurredAtIso",
      "accessSubjectHash",
      "deviceId",
      "rayId",
      "sourceIp",
      "requestId",
      "operationType",
      "sessionId",
      "projectId",
      "resultCode",
      "toolCategory",
      "permissionDecision",
      "redactedDetail",
      "committed",
    ]);
    for (const line of readLines(logPath())) {
      for (const key of Object.keys(line)) expect(allowed.has(key), `unexpected key ${key}`).toBe(true);
    }
  });

  it("joins a caller-owned transaction: rollback drops the DB row, the JSONL append stays", () => {
    const log = openAuditLog();
    expect(() =>
      transaction(db, () => {
        log.write({ operationType: "session.stop", resultCode: "ok", detail: "then it failed" });
        throw new Error("caller rollback");
      }),
    ).toThrow("caller rollback");

    const count = (db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
    expect(count).toBe(0);
    // The file append is immediate and not transactional by design.
    expect(readLines(logPath())).toHaveLength(1);
  });
});
