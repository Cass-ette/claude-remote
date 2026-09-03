/**
 * Session importer (spec §6.6).
 *
 * Import happens only when the user runs "scan old sessions" against an
 * already-authorized project:
 *
 *  1. the project realpath/device/inode is re-validated via the project
 *     registry;
 *  2. the importer read-only scans THAT project's Claude transcript
 *     directory (`<claudeConfigDir>/projects/<encoded>/`); it never walks
 *     other projects' directories;
 *  3. filenames must be valid UUIDs; duplicate session IDs merge into the
 *     existing binding;
 *  4. corrupted files surface as not-importable candidates without
 *     interrupting the other results;
 *  5. on confirmation, the session is permanently bound to the project ID
 *     (the `sessions` row insert is the binding and is atomic).
 *
 * The importer is NOT wired into any route here; route wiring is Task 24.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "../db/database.js";
import { transaction } from "../db/database.js";
import type { ProjectRegistry } from "../projects/project-registry.js";
import {
  transcriptDirForProject,
  transcriptPathForSession,
  TranscriptNotFoundError,
  type ClaudeTranscriptAdapter,
} from "./claude-2.1.133-adapter.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** sessionId is not a canonical UUID (transcript filenames are UUIDs). */
export class InvalidSessionIdError extends Error {
  readonly code = "INVALID_SESSION_ID";
  constructor(readonly sessionId: string) {
    super(`sessionId ${sessionId} is not a valid UUID`);
    this.name = "InvalidSessionIdError";
  }
}

/** Transcript exists but is corrupted (a complete line failed JSON.parse). */
export class TranscriptUnimportableError extends Error {
  readonly code = "TRANSCRIPT_UNIMPORTABLE";
  constructor(
    readonly sessionId: string,
    readonly firstMalformedOffset: number | null,
  ) {
    super(
      `transcript for session ${sessionId} is corrupted ` +
        `(first malformed offset: ${firstMalformedOffset ?? "unknown"}); it cannot be imported`,
    );
    this.name = "TranscriptUnimportableError";
  }
}

/** Session already bound to a different project (§7.3: no arbitrary pairing). */
export class SessionProjectMismatchError extends Error {
  readonly code = "SESSION_PROJECT_MISMATCH";
  constructor(
    readonly sessionId: string,
    readonly boundProjectId: string,
    readonly requestedProjectId: string,
  ) {
    super(
      `session ${sessionId} is already bound to project ${boundProjectId}; ` +
        `cannot bind it to ${requestedProjectId}`,
    );
    this.name = "SessionProjectMismatchError";
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** One transcript file found by a scan. */
export interface CandidateSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
  /** LAST `ai-title` record's title, or null when the transcript has none. */
  readonly title: string | null;
  /** Transcript mtime (epoch ms). */
  readonly lastModified: number;
  /** Transcript size in bytes. */
  readonly size: number;
  /** False when the transcript is corrupted (§6.6 step 4). */
  readonly importable: boolean;
  /** Human-readable reason when `importable === false`. */
  readonly reason?: string;
}

export interface ScanResult {
  /** Candidates sorted by lastModified descending. */
  readonly candidates: readonly CandidateSession[];
  /** Number of non-session files skipped (non-UUID names, non-jsonl). */
  readonly skipped: number;
}

export interface ImportSessionArgs {
  readonly projectId: string;
  readonly sessionId: string;
  readonly now: number;
}

export interface ImportResult {
  readonly sessionId: string;
  readonly projectId: string;
  /** False when the session was already bound to this project (dedup no-op). */
  readonly created: boolean;
  readonly displayName: string;
}

export interface SessionImporter {
  scanImports(projectId: string): Promise<ScanResult>;
  importSession(args: ImportSessionArgs): Promise<ImportResult>;
}

export interface SessionImporterOptions {
  readonly claudeConfigDir: string;
  readonly registry: ProjectRegistry;
  /** Adapter factory bound to a project's canonical root. */
  readonly adapterFor: (projectRoot: string) => ClaudeTranscriptAdapter;
}

/** Case-insensitive canonical UUID (Claude Code writes lowercase). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function createSessionImporter(db: SqliteDatabase, options: SessionImporterOptions): SessionImporter {
  const getSession = db.prepare(
    "SELECT sessionId, projectId, displayName FROM sessions WHERE sessionId = ?",
  );
  const insertSession = db.prepare(
    `INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
     VALUES (?, ?, ?, 'inactive', 'imported', ?, ?)`,
  );

  return {
    async scanImports(projectId): Promise<ScanResult> {
      // §6.6 step 1: revalidate realpath/device/inode before reading anything.
      const record = options.registry.revalidate(projectId);
      const dir = transcriptDirForProject(options.claudeConfigDir, record.canonicalRealpath);

      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // No transcript directory yet: the project simply has no sessions.
        return { candidates: [], skipped: 0 };
      }

      const adapter = options.adapterFor(record.canonicalRealpath);
      const candidates: CandidateSession[] = [];
      let skipped = 0;

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          skipped++;
          continue;
        }
        const sessionId = entry.name.slice(0, -".jsonl".length);
        if (!isSessionUuid(sessionId)) {
          skipped++;
          continue;
        }
        const transcriptPath = join(dir, `${sessionId}.jsonl`);
        try {
          const stats = statSync(transcriptPath);
          const meta = await adapter.readMetadata(transcriptPath, Number.MAX_SAFE_INTEGER);
          candidates.push({
            sessionId,
            transcriptPath,
            title: meta.title,
            lastModified: Math.round(stats.mtimeMs),
            size: stats.size,
            importable: meta.allLinesParseable,
            ...(meta.allLinesParseable
              ? {}
              : {
                  reason: `malformed JSON at byte offset ${meta.firstMalformedOffset ?? "unknown"}`,
                }),
          });
        } catch (error) {
          // §6.6 step 4: one bad file (deleted mid-scan, unreadable, or
          // unparseable) never interrupts the other results.
          candidates.push({
            sessionId,
            transcriptPath,
            title: null,
            lastModified: 0,
            size: 0,
            importable: false,
            reason: `unreadable transcript: ${(error as Error).message}`,
          });
        }
      }

      candidates.sort((a, b) => b.lastModified - a.lastModified);
      return { candidates, skipped };
    },

    async importSession({ projectId, sessionId, now }): Promise<ImportResult> {
      if (!isSessionUuid(sessionId)) {
        throw new InvalidSessionIdError(sessionId);
      }
      const record = options.registry.revalidate(projectId);

      // Binding guard FIRST (§7.3: no arbitrary session/project pairing):
      // an existing binding answers without touching the filesystem — a
      // duplicate is a no-op, a cross-project request is a conflict, even
      // when a transcript copy also exists under the other project.
      const preexisting = getSession.get(sessionId) as
        | { sessionId: string; projectId: string; displayName: string }
        | undefined;
      if (preexisting !== undefined) {
        if (preexisting.projectId !== projectId) {
          throw new SessionProjectMismatchError(sessionId, preexisting.projectId, projectId);
        }
        return {
          sessionId: preexisting.sessionId,
          projectId: preexisting.projectId,
          created: false,
          displayName: preexisting.displayName,
        };
      }

      // New binding: the transcript MUST exist inside THIS project's
      // transcript directory and be parseable (§6.6 step 5).
      const transcriptPath = transcriptPathForSession(
        options.claudeConfigDir,
        record.canonicalRealpath,
        sessionId,
      );
      const adapter = options.adapterFor(record.canonicalRealpath);
      const meta = await adapter.readMetadata(transcriptPath, Number.MAX_SAFE_INTEGER);
      if (!meta.allLinesParseable) {
        throw new TranscriptUnimportableError(sessionId, meta.firstMalformedOffset);
      }
      const stats = statSync(transcriptPath);

      // Atomic binding (§6.6 step 5): re-check + insert in one transaction
      // (a concurrent import may have won the race; the PRIMARY KEY plus
      // this re-check keep the binding unique and consistent).
      return transaction(db, () => {
        const existing = getSession.get(sessionId) as
          | { sessionId: string; projectId: string; displayName: string }
          | undefined;
        if (existing !== undefined) {
          if (existing.projectId !== projectId) {
            throw new SessionProjectMismatchError(sessionId, existing.projectId, projectId);
          }
          return {
            sessionId: existing.sessionId,
            projectId: existing.projectId,
            created: false,
            displayName: existing.displayName,
          };
        }
        const displayName = meta.title ?? sessionId;
        insertSession.run(sessionId, projectId, displayName, Math.round(stats.mtimeMs), now);
        return { sessionId, projectId, created: true, displayName };
      });
    },
  };
}

export { TranscriptNotFoundError };
