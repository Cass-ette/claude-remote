/**
 * Project registry with filesystem identity revalidation (spec §6.6, §10.5).
 *
 * Project authorization on the Mac records, alongside the display name:
 * the canonical realpath (OS realpath via fs.realpath.native), the
 * filesystem device number, and the inode. Before every startup or resume,
 * the stored canonical path is re-resolved and the device number and inode
 * are re-checked. Startup is refused when the path has changed, the
 * directory was replaced, or the authorized root itself is a symlink.
 * Symlinks *inside* a project are not treated as a security boundary.
 *
 * NOTE: records returned by this registry contain `canonicalRealpath` for
 * Bridge-internal use (session supervisor, session importer). The protocol
 * layer must never send raw paths to clients; the client-safe subset is
 * { projectId, displayName }.
 *
 * All timestamps are injected by callers; the registry never reads the clock.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import type { SqliteDatabase } from "../db/database.js";

/** Authorization or revalidation failed: symlink root, moved/replaced/missing dir, identity mismatch. */
export class ProjectIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectIdentityError";
  }
}

/** A project with the same canonical realpath is already authorized. */
export class DuplicateProjectError extends Error {
  constructor(readonly canonicalRealpath: string) {
    super(`a project is already authorized at ${canonicalRealpath}`);
    this.name = "DuplicateProjectError";
  }
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly canonicalRealpath: string;
  readonly deviceNumber: number;
  readonly inode: number;
  readonly displayName: string;
  readonly createdAt: number;
  readonly authorizedAt: number;
}

export interface AuthorizeOptions {
  readonly now: number;
}

export interface ProjectRegistry {
  /**
   * Authorize a project directory. Rejects when the user-supplied path is
   * itself a symlink (the authorized root must be a real directory) or when
   * the canonical path is already authorized.
   */
  authorize(path: string, displayName: string, options: AuthorizeOptions): ProjectRecord;

  /**
   * Re-check a project's filesystem identity: re-resolve the stored
   * canonical path and compare device number and inode. Throws
   * ProjectIdentityError on any mismatch, on a missing/replaced directory,
   * or on an unknown projectId. Returns the record on success.
   */
  revalidate(projectId: string): ProjectRecord;

  /** All currently authorized projects. */
  list(): ProjectRecord[];

  /** Remove (de-authorize) a project. Idempotent. */
  remove(projectId: string): void;

  get(projectId: string): ProjectRecord | undefined;
}

interface ProjectRow {
  projectId: string;
  canonicalRealpath: string;
  deviceNumber: number;
  inode: number;
  displayName: string;
  createdAt: number;
  authorizedAt: number;
}

function rowToRecord(row: ProjectRow): ProjectRecord {
  return { ...row };
}

export function createProjectRegistry(db: SqliteDatabase): ProjectRegistry {
  const insertStmt = db.prepare(
    `INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const getById = db.prepare("SELECT * FROM projects WHERE projectId = ?");
  const getByRealpath = db.prepare("SELECT * FROM projects WHERE canonicalRealpath = ?");
  const listStmt = db.prepare("SELECT * FROM projects ORDER BY createdAt, projectId");
  const deleteStmt = db.prepare("DELETE FROM projects WHERE projectId = ?");

  function load(projectId: string): ProjectRow {
    const row = getById.get(projectId) as ProjectRow | undefined;
    if (row === undefined) throw new ProjectIdentityError(`unknown projectId ${projectId}`);
    return row;
  }

  return {
    authorize(path, displayName, options) {
      // The authorized root itself must not be a symlink (§10.5). Check with
      // lstat BEFORE realpath resolution, which would silently follow it.
      let lstat;
      try {
        lstat = lstatSync(path);
      } catch (error) {
        throw new ProjectIdentityError(
          `cannot stat ${path}: ${(error as Error).message}`,
        );
      }
      if (lstat.isSymbolicLink()) {
        throw new ProjectIdentityError(
          `authorized root ${path} is a symlink; the project root must be a real directory`,
        );
      }
      if (!lstat.isDirectory()) {
        throw new ProjectIdentityError(`authorized root ${path} is not a directory`);
      }

      // fs.realpathSync.native uses the OS realpath(3) — the same resolution
      // revalidation later relies on.
      const canonical = resolveCanonicalSync(path);
      const stats = statSync(canonical);
      const projectId = randomUUID();
      try {
        insertStmt.run(
          projectId,
          canonical,
          stats.dev,
          stats.ino,
          displayName,
          options.now,
          options.now,
        );
      } catch (error) {
        const message = (error as Error).message ?? "";
        if (message.includes("UNIQUE constraint failed")) {
          throw new DuplicateProjectError(canonical);
        }
        throw error;
      }
      return rowToRecord(getById.get(projectId) as ProjectRow);
    },

    revalidate(projectId) {
      const row = load(projectId);
      const current = resolveCanonicalSync(row.canonicalRealpath);
      // A renamed/relinked directory resolves to a different canonical path.
      if (current !== row.canonicalRealpath) {
        throw new ProjectIdentityError(
          `project ${projectId} moved: canonical path changed from ${row.canonicalRealpath} to ${current}`,
        );
      }
      const stats = statSync(current);
      if (stats.dev !== row.deviceNumber || stats.ino !== row.inode) {
        throw new ProjectIdentityError(
          `project ${projectId} identity mismatch at ${current}: ` +
            `expected dev=${row.deviceNumber} ino=${row.inode}, ` +
            `found dev=${stats.dev} ino=${stats.ino}`,
        );
      }
      return rowToRecord(row);
    },

    list() {
      return (listStmt.all() as ProjectRow[]).map(rowToRecord);
    },

    remove(projectId) {
      deleteStmt.run(projectId);
    },

    get(projectId) {
      const row = getById.get(projectId) as ProjectRow | undefined;
      return row === undefined ? undefined : rowToRecord(row);
    },
  };
}

// Synchronous wrapper over fs.realpath.native: unlike fs.realpathSync (pure
// JS), realpathSync.native uses the OS realpath(3).
function resolveCanonicalSync(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    throw new ProjectIdentityError(
      `cannot resolve realpath of ${path}: ${(error as Error).message}`,
    );
  }
}
