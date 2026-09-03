/**
 * Session importer tests (Task 19, spec §6.6).
 *
 * The importer only reads the bound project's transcript directory,
 * requires valid UUID filenames, deduplicates by session ID, and persists
 * bindings atomically. Corrupted files surface as not importable without
 * interrupting the other scan results.
 */
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { createProjectRegistry, ProjectIdentityError } from "../../src/projects/project-registry.js";
import { createClaudeTranscriptAdapter, encodeProjectPath } from "../../src/history/claude-2.1.133-adapter.js";
import {
  createSessionImporter,
  InvalidSessionIdError,
  SessionProjectMismatchError,
  TranscriptUnimportableError,
} from "../../src/history/session-importer.js";
import { TranscriptNotFoundError } from "../../src/history/claude-2.1.133-adapter.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = (name: string) => join(here, "fixtures", name);

const UUID_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const UUID_B = "bbbbbbbb-0000-4000-8000-0000000000b2";
const UUID_C = "cccccccc-0000-4000-8000-0000000000c3";
const UUID_D = "dddddddd-0000-4000-8000-0000000000d4";

const T0 = 1_700_000_000_000;

let dir: string;
let db: SqliteDatabase;
let configDir: string;
let projectDir: string;
let transcriptDir: string;
let projectId: string;
let otherProjectId: string;

function placeTranscript(fixture: string, sessionId: string, mtimeMs?: number): string {
  const path = join(transcriptDir, `${sessionId}.jsonl`);
  copyFileSync(FIXTURE(fixture), path);
  if (mtimeMs !== undefined) {
    utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  }
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-importer-"));
  db = openDatabase(join(dir, "test.db"));
  migrate(db);
  configDir = join(dir, ".claude");
  projectDir = join(dir, "proj");
  mkdirSync(projectDir);
  const canonical = realpathSync(projectDir);
  transcriptDir = join(configDir, "projects", encodeProjectPath(canonical));
  mkdirSync(transcriptDir, { recursive: true });

  const registry = createProjectRegistry(db);
  projectId = registry.authorize(projectDir, "proj", { now: T0 }).projectId;
  const otherDir = join(dir, "proj2");
  mkdirSync(otherDir);
  otherProjectId = registry.authorize(otherDir, "proj2", { now: T0 }).projectId;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeImporter() {
  return createSessionImporter(db, {
    claudeConfigDir: configDir,
    registry: createProjectRegistry(db),
    adapterFor: (projectRoot: string) =>
      createClaudeTranscriptAdapter({ projectRoot, claudeConfigDir: configDir }),
  });
}

describe("scanImports", () => {
  it("returns importable candidates with title, lastModified, and size", async () => {
    placeTranscript("complete.jsonl", UUID_A, T0 + 1000);
    placeTranscript("interrupted.jsonl", UUID_B, T0 + 2000);
    const importer = makeImporter();
    const { candidates, skipped } = await importer.scanImports(projectId);
    expect(skipped).toBe(0);
    expect(candidates).toHaveLength(2);

    const a = candidates.find((c) => c.sessionId === UUID_A)!;
    expect(a.importable).toBe(true);
    expect(a.title).toBe("Final session title");
    expect(a.lastModified).toBe(T0 + 1000);
    expect(a.size).toBeGreaterThan(0);
    expect(a.transcriptPath).toBe(join(transcriptDir, `${UUID_A}.jsonl`));

    const b = candidates.find((c) => c.sessionId === UUID_B)!;
    expect(b.importable).toBe(true);
    expect(b.title).toBeNull(); // interrupted.jsonl has no ai-title record
  });

  it("sorts candidates by lastModified descending", async () => {
    placeTranscript("complete.jsonl", UUID_A, T0 + 1000);
    placeTranscript("partial-tail.jsonl", UUID_B, T0 + 9000);
    placeTranscript("interrupted.jsonl", UUID_C, T0 + 5000);
    const importer = makeImporter();
    const { candidates } = await importer.scanImports(projectId);
    expect(candidates.map((c) => c.sessionId)).toEqual([UUID_B, UUID_C, UUID_A]);
  });

  it("marks corrupted transcripts unimportable without interrupting other results", async () => {
    placeTranscript("incompatible.jsonl", UUID_A, T0 + 1000);
    placeTranscript("complete.jsonl", UUID_B, T0 + 2000);
    const importer = makeImporter();
    const { candidates } = await importer.scanImports(projectId);
    expect(candidates).toHaveLength(2);
    const a = candidates.find((c) => c.sessionId === UUID_A)!;
    expect(a.importable).toBe(false);
    expect(a.reason).toBeDefined();
    const b = candidates.find((c) => c.sessionId === UUID_B)!;
    expect(b.importable).toBe(true);
  });

  it("skips non-UUID filenames and non-jsonl files", async () => {
    placeTranscript("complete.jsonl", UUID_A, T0);
    writeFileSync(join(transcriptDir, "not-a-uuid.jsonl"), "{}\n");
    writeFileSync(join(transcriptDir, `${UUID_B}.txt`), "x");
    const importer = makeImporter();
    const { candidates, skipped } = await importer.scanImports(projectId);
    expect(candidates.map((c) => c.sessionId)).toEqual([UUID_A]);
    expect(skipped).toBe(2);
  });

  it("returns an empty list when the project has no transcript directory", async () => {
    const importer = makeImporter();
    const { candidates, skipped } = await importer.scanImports(otherProjectId);
    expect(candidates).toEqual([]);
    expect(skipped).toBe(0);
  });

  it("rejects an unknown projectId via project revalidation", async () => {
    const importer = makeImporter();
    await expect(importer.scanImports("no-such-project")).rejects.toBeInstanceOf(ProjectIdentityError);
  });
});

describe("importSession", () => {
  it("atomically inserts an inactive imported session with the transcript title", async () => {
    placeTranscript("complete.jsonl", UUID_A, T0 + 1000);
    const importer = makeImporter();
    const result = await importer.importSession({ projectId, sessionId: UUID_A, now: T0 + 5000 });
    expect(result).toMatchObject({ sessionId: UUID_A, projectId, created: true, displayName: "Final session title" });

    const row = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get(UUID_A) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.status).toBe("inactive");
    expect(row.source).toBe("imported");
    expect(row.displayName).toBe("Final session title");
    expect(row.lastActivityAt).toBe(T0 + 1000); // transcript mtime
    expect(row.createdAt).toBe(T0 + 5000);
  });

  it("falls back to the session ID for display when the transcript has no title", async () => {
    placeTranscript("interrupted.jsonl", UUID_B, T0);
    const importer = makeImporter();
    const result = await importer.importSession({ projectId, sessionId: UUID_B, now: T0 });
    expect(result.displayName).toBe(UUID_B);
  });

  it("deduplicates: an existing binding for the same project is a no-op returning it", async () => {
    placeTranscript("complete.jsonl", UUID_A, T0 + 1000);
    const importer = makeImporter();
    const first = await importer.importSession({ projectId, sessionId: UUID_A, now: T0 });
    // A re-import (e.g. user re-scans) must return the existing binding
    // without rewriting the row.
    const second = await importer.importSession({ projectId, sessionId: UUID_A, now: T0 + 999_999 });
    expect(second.created).toBe(false);
    expect(second.displayName).toBe(first.displayName);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE sessionId = ?").get(UUID_A) as { n: number }
    ).n;
    expect(count).toBe(1);
    // createdAt must not have been rewritten by the dedup call.
    const row = db.prepare("SELECT createdAt FROM sessions WHERE sessionId = ?").get(UUID_A) as {
      createdAt: number;
    };
    expect(row.createdAt).toBe(T0);
  });

  it("rejects binding an existing session to a different project", async () => {
    placeTranscript("complete.jsonl", UUID_A, T0 + 1000);
    const importer = makeImporter();
    await importer.importSession({ projectId, sessionId: UUID_A, now: T0 });
    await expect(
      importer.importSession({ projectId: otherProjectId, sessionId: UUID_A, now: T0 }),
    ).rejects.toBeInstanceOf(SessionProjectMismatchError);
  });

  it("rejects a transcript that does not exist in the project's transcript directory", async () => {
    const importer = makeImporter();
    await expect(
      importer.importSession({ projectId, sessionId: UUID_A, now: T0 }),
    ).rejects.toBeInstanceOf(TranscriptNotFoundError);
  });

  it("rejects an invalid session UUID", async () => {
    const importer = makeImporter();
    await expect(
      importer.importSession({ projectId, sessionId: "not-a-uuid", now: T0 }),
    ).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it("rejects a corrupted transcript", async () => {
    placeTranscript("incompatible.jsonl", UUID_A, T0);
    const importer = makeImporter();
    await expect(
      importer.importSession({ projectId, sessionId: UUID_A, now: T0 }),
    ).rejects.toBeInstanceOf(TranscriptUnimportableError);
    // No session row may leak from the failed import.
    expect(db.prepare("SELECT 1 FROM sessions WHERE sessionId = ?").get(UUID_A)).toBeUndefined();
  });

  it("imports a trailing-partial transcript (partial tail is not corruption)", async () => {
    placeTranscript("partial-tail.jsonl", UUID_D, T0);
    const importer = makeImporter();
    const result = await importer.importSession({ projectId, sessionId: UUID_D, now: T0 });
    expect(result.created).toBe(true);
    expect(result.displayName).toBe("Partial tail session");
  });

  it("rejects an unknown projectId via project revalidation", async () => {
    const importer = makeImporter();
    await expect(
      importer.importSession({ projectId: "no-such-project", sessionId: UUID_A, now: T0 }),
    ).rejects.toBeInstanceOf(ProjectIdentityError);
  });
});
