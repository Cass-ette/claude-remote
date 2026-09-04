/**
 * Redacted, rotating JSONL audit log (Task 22, spec §10.6 / §11).
 *
 * Storage split:
 * - The JSONL FILE (default `<dataDir>/audit.jsonl`) is the durable
 *   human/admin-readable trail. It is created with mode 0600, rotated at
 *   10 MiB, and keeps five rotated files or thirty days — whichever limit
 *   is reached first (expired files are swept at open).
 * - The `audit_events` TABLE is the queryable projection for the admin CLI
 *   (Task 23). Every write appends the JSONL line AND inserts the same
 *   §10.6 record into the table, sharing the DB auditId as the audit
 *   event ID.
 *
 * Never logged (spec §10.6/§11): full prompts, Claude replies, raw tool
 * params, tool outputs, raw stderr, OAuth tokens, device session tokens,
 * API keys, or file contents. Callers pass only structured fields plus an
 * optional free-form `detail`, which ALWAYS passes through `redact()`
 * before storage. The raw Access subject is accepted only to be hashed
 * (SHA-256 hex) — it never reaches either store.
 *
 * Transactions: `write()` is standalone. When a caller invokes it while
 * holding a better-sqlite3 transaction on the same DB handle, the
 * audit_events insert joins that transaction (and is rolled back with it);
 * the JSONL append is immediate either way. Callers that cannot share a
 * transaction should write right after the action and set `committed` on
 * the entry. Task 24 owns that wiring — this module builds none of it.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SqliteDatabase } from "../db/database.js";

/** Single-file rotation threshold: 10 MiB (spec §10.6). */
export const DEFAULT_ROTATE_BYTES = 10 * 1024 * 1024;
/** Retained rotated files (`.1` … `.5`) alongside the current file. */
export const DEFAULT_MAX_ROTATED_FILES = 5;
/** Rotated/current files older than this are swept at open. */
export const DEFAULT_RETENTION_DAYS = 30;
/** Nesting cap for object details (also terminates cyclic structures). */
export const MAX_REDACT_DEPTH = 6;
/** Per-string and final output cap for redacted detail text. */
export const MAX_DETAIL_LENGTH = 2000;

const DAY_MS = 86_400_000;

// --- Redaction ------------------------------------------------------------------

const REDACTED = "[REDACTED]";

/** Header/credential keys whose VALUES are always replaced wholesale. */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "cf-access-jwt-assertion",
  "x-claude-remote-device-session",
  "token",
  "apikey",
  "api_key",
  "secret",
  "password",
  "refreshtoken",
  "accesstoken",
  "bearer",
]);

/**
 * Ordered string patterns. Credential-shaped runs must run BEFORE the
 * base64 catch-all so they get their specific markers; home paths run
 * before it too so `/Users/<name>/…` keeps its readable tail.
 */
const STRING_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  { pattern: /sk-[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:key]" },
  { pattern: /Bearer\s+[A-Za-z0-9._-]+/gi, replacement: "[REDACTED:bearer]" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED:aws]" },
  // `/Users/<name>` / `/home/<name>` prefix → keep the tail for ops.
  { pattern: /\/(Users|home)\/[^/\s"']+/g, replacement: "/$1/[REDACTED]" },
  // High-entropy base64/base64url run longer than 32 chars.
  { pattern: /[A-Za-z0-9+/_-]{33,}={0,2}/g, replacement: "[REDACTED:b64]" },
];

function clampString(value: string): string {
  if (value.length <= MAX_DETAIL_LENGTH) return value;
  return `${value.slice(0, MAX_DETAIL_LENGTH)}[TRUNCATED:length]`;
}

/** Scan one string for credential patterns, then cap its length. */
function redactString(value: string): string {
  let out = value;
  for (const { pattern, replacement } of STRING_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return clampString(out);
}

/** Recursively produce a JSON-safe value with secrets stripped. */
function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") {
    // Numbers/booleans pass through; bigint is not JSON-serializable.
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (depth >= MAX_REDACT_DEPTH) return "[TRUNCATED:depth]";
  if (Array.isArray(value)) return value.map((element) => redactValue(element, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(val, depth + 1);
  }
  return out;
}

/**
 * Convert any input into a string that is safe for the audit log:
 * forbidden keys become `"[REDACTED]"`, credential-shaped substrings get
 * `[REDACTED:*]` markers, home-directory prefixes lose the username, and
 * depth/length caps bound the output. This is defense-in-depth — callers
 * must still never pass prompts, tool params, or outputs as detail.
 */
export function redact(input: unknown): string {
  const safe = redactValue(input, 0);
  if (typeof safe === "string") return safe;
  const serialized = JSON.stringify(safe);
  return serialized === undefined ? "undefined" : clampString(serialized);
}

// --- Audit log ------------------------------------------------------------------

/** One audit event, spec §10.6. Only operationType and resultCode are required. */
export interface AuditEntry {
  /** Cloudflare Access subject; hashed (SHA-256 hex) before storage. */
  readonly accessSubject?: string;
  readonly deviceId?: string;
  readonly rayId?: string;
  readonly sourceIp?: string;
  readonly requestId?: string;
  readonly operationType: string;
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly resultCode: string;
  /** Tool category for permission events. */
  readonly toolCategory?: string;
  /** `allow`/`deny` for permission events. */
  readonly permissionDecision?: string;
  /**
   * Free-form context. Passed through {@link redact}; must never be a
   * prompt, full tool params, or a tool output.
   */
  readonly detail?: unknown;
  /**
   * Set by callers writing after (not inside) the action's transaction:
   * whether the audited action was already committed at write time.
   */
  readonly committed?: boolean;
}

/** A record exactly as persisted to the JSONL file and audit_events. */
export interface AuditRecord {
  readonly auditId: number;
  /** Epoch milliseconds (from the injected clock). */
  readonly occurredAt: number;
  readonly accessSubjectHash: string | null;
  readonly deviceId: string | null;
  readonly rayId: string | null;
  readonly sourceIp: string | null;
  readonly requestId: string | null;
  readonly operationType: string;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly resultCode: string;
  readonly toolCategory: string | null;
  readonly permissionDecision: string | null;
  readonly redactedDetail: string | null;
  /** Present in the JSONL trail only (no audit_events column). */
  readonly committed?: boolean;
}

export interface AuditLogOptions {
  /** Path of the current JSONL file; rotated files are `.<n>` siblings. */
  readonly filePath: string;
  /** Database holding the audit_events table (same handle as callers' transactions). */
  readonly db: SqliteDatabase;
  /** Injected clock (the module never calls Date.now()). */
  readonly now: () => number;
  /** Rotation threshold in bytes. Default {@link DEFAULT_ROTATE_BYTES}. */
  readonly rotateBytes?: number;
  /** Rotated files retained. Default {@link DEFAULT_MAX_ROTATED_FILES}. */
  readonly maxRotatedFiles?: number;
  /** Age cap in days. Default {@link DEFAULT_RETENTION_DAYS}. */
  readonly retentionDays?: number;
}

export interface AuditLog {
  readonly filePath: string;
  /** Append one JSONL line + insert the audit_events row. */
  write(entry: AuditEntry): AuditRecord;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function rotatedPath(filePath: string, index: number): string {
  return `${filePath}.${index}`;
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Delete `path` if it exists; ignore missing files. */
function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createAuditLog(options: AuditLogOptions): AuditLog {
  const {
    filePath,
    db,
    now,
    rotateBytes = DEFAULT_ROTATE_BYTES,
    maxRotatedFiles = DEFAULT_MAX_ROTATED_FILES,
    retentionDays = DEFAULT_RETENTION_DAYS,
  } = options;

  const insertAuditEvent = db.prepare(
    `INSERT INTO audit_events
       (occurredAt, accessSubjectHash, deviceId, rayId, sourceIp, requestId, operationType,
        sessionId, projectId, resultCode, toolCategory, permissionDecision, redactedDetail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });

  // Sweep expired files BEFORE (re)creating the current file so an expired
  // current file is removed and recreated fresh, not kept by its new mtime.
  const cutoff = now() - retentionDays * DAY_MS;
  const candidates = [filePath];
  for (let i = 1; i <= maxRotatedFiles; i += 1) candidates.push(rotatedPath(filePath, i));
  for (const path of candidates) {
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkIfExists(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // Create-or-open with owner-only permissions and re-assert the mode on
  // existing files (umask cannot have stripped bits we did not grant).
  closeSync(openSync(filePath, "a", 0o600));
  chmodSync(filePath, 0o600);

  /** Shift `.1→.2 … .4→.5` (rename atomically replaces the old `.5`), then current→`.1`. */
  function rotate(): void {
    for (let i = maxRotatedFiles - 1; i >= 1; i -= 1) {
      const from = rotatedPath(filePath, i);
      const to = rotatedPath(filePath, i + 1);
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(filePath, rotatedPath(filePath, 1));
  }

  function rotateIfNeeded(): void {
    const size = fileSize(filePath);
    if (size !== null && size >= rotateBytes) rotate();
  }

  function write(entry: AuditEntry): AuditRecord {
    const occurredAt = now();
    const record: AuditRecord = {
      auditId: 0, // assigned from the DB insert below
      occurredAt,
      accessSubjectHash: entry.accessSubject !== undefined ? sha256Hex(entry.accessSubject) : null,
      deviceId: entry.deviceId ?? null,
      rayId: entry.rayId ?? null,
      sourceIp: entry.sourceIp ?? null,
      requestId: entry.requestId ?? null,
      operationType: entry.operationType,
      sessionId: entry.sessionId ?? null,
      projectId: entry.projectId ?? null,
      resultCode: entry.resultCode,
      toolCategory: entry.toolCategory ?? null,
      permissionDecision: entry.permissionDecision ?? null,
      redactedDetail:
        entry.detail === undefined || entry.detail === null ? null : redact(entry.detail),
      ...(entry.committed === undefined ? {} : { committed: entry.committed }),
    };

    rotateIfNeeded();
    const result = insertAuditEvent.run(
      record.occurredAt,
      record.accessSubjectHash,
      record.deviceId,
      record.rayId,
      record.sourceIp,
      record.requestId,
      record.operationType,
      record.sessionId,
      record.projectId,
      record.resultCode,
      record.toolCategory,
      record.permissionDecision,
      record.redactedDetail,
    );
    const auditId = Number(result.lastInsertRowid);
    const persisted: AuditRecord = { ...record, auditId };
    const line = JSON.stringify({
      ...persisted,
      occurredAtIso: new Date(occurredAt).toISOString(),
    });
    // mode applies whenever appendFileSync must CREATE the file (e.g. the
    // first append after a rotation renamed the current file away) — without
    // it the recreated file gets the umask default (typically 0644).
    appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
    return persisted;
  }

  return {
    filePath,
    write,
  };
}
