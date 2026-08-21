import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATION_001_SQL } from "./migrations/001_initial.js";

export type SqliteDatabase = Database.Database;

export interface MigrationRecord {
  readonly version: number;
  /** SQL body applied inside a transaction for the given version. */
  readonly sql: string;
}

/**
 * Ordered list of schema migrations. Index i corresponds to version i + 1.
 * New migrations must only ever be appended.
 */
export const MIGRATIONS: readonly MigrationRecord[] = [
  { version: 1, sql: MIGRATION_001_SQL },
];

export interface DatabaseOptions {
  /**
   * Ensure the parent directory exists (mode 0o700) before opening.
   * Defaults to true.
   */
  readonly createDir?: boolean;
}

/**
 * Open (or create) the Bridge SQLite database.
 *
 * - The database file (and its WAL/SHM sidecars) are created with
 *   owner-only permissions (0600).
 * - WAL journaling is enabled for concurrent readers during writes.
 * - Foreign keys are enforced; busy waits are bounded at 5s.
 */
export function openDatabase(path: string, options: DatabaseOptions = {}): SqliteDatabase {
  const { createDir = true } = options;
  if (createDir) {
    mkdirRecursive(dirname(path));
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  chmodOwnerOnly(path);
  chmodOwnerOnly(`${path}-wal`);
  chmodOwnerOnly(`${path}-shm`);
  return db;
}

function chmodOwnerOnly(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    // Sidecar files may not exist yet on a fresh database; the main file
    // is always expected to exist, so anything else is a real error.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function mkdirRecursive(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Apply all pending migrations. Idempotent: versions already recorded in
 * `schema_migrations` are skipped. Each migration runs inside a
 * transaction together with its version bookkeeping, so a crash can never
 * leave a schema change without its migration row (or vice versa).
 */
export function migrate(db: SqliteDatabase): void {
  // Bookkeeping table must predate the migrations it tracks.
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL)");
  for (const migration of MIGRATIONS) {
    const applied = db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(migration.version);
    if (applied !== undefined) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)").run(
        migration.version,
        Date.now(),
      );
    })();
  }
}

/**
 * Run `fn` inside a transaction. If `fn` throws, the transaction is
 * rolled back and the error propagates; no partial writes persist.
 */
export function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  return db.transaction(fn)();
}
