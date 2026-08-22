/**
 * Project registry identity revalidation tests (spec §6.6, §10.5).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import {
  createProjectRegistry,
  DuplicateProjectError,
  ProjectIdentityError,
} from "../../src/projects/project-registry.js";

let db: SqliteDatabase;
let tempRoot: string;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "project-registry-test-"));
  db = openDatabase(join(tempRoot, "bridge.db"), { createDir: false });
  migrate(db);
});

afterAll(() => {
  db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeProjectDir(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir);
  return dir;
}

describe("authorize", () => {
  it("resolves realpath and records projectId, canonical path, st_dev, st_ino, and displayName", () => {
    const registry = createProjectRegistry(db);
    const dir = makeProjectDir("alpha");
    const record = registry.authorize(dir, "Alpha", { now: 1_000 });

    expect(record.projectId).toMatch(/^[0-9a-f-]{36}$/);
    const stats = statSync(dir);
    expect(record.canonicalRealpath).not.toBe(dir); // macOS /tmp -> /private/tmp resolution
    expect(record.deviceNumber).toBe(stats.dev);
    expect(record.inode).toBe(stats.ino);
    expect(record.displayName).toBe("Alpha");
    expect(record.createdAt).toBe(1_000);
    expect(record.authorizedAt).toBe(1_000);
  });

  it("rejects a symlink as the authorized root", () => {
    const registry = createProjectRegistry(db);
    const dir = makeProjectDir("beta");
    const link = join(tempRoot, "beta-link");
    symlinkSync(dir, link);
    expect(() => registry.authorize(link, "Beta", { now: 1_000 })).toThrow(ProjectIdentityError);
  });

  it("rejects a duplicate canonical realpath", () => {
    const registry = createProjectRegistry(db);
    const dir = makeProjectDir("gamma");
    registry.authorize(dir, "Gamma", { now: 1_000 });
    expect(() => registry.authorize(dir, "Gamma again", { now: 1_000 })).toThrow(
      DuplicateProjectError,
    );
  });
});

describe("revalidate", () => {
  it("accepts an unchanged project", () => {
    const registry = createProjectRegistry(db);
    const dir = makeProjectDir("delta");
    const record = registry.authorize(dir, "Delta", { now: 1_000 });
    expect(() => registry.revalidate(record.projectId)).not.toThrow();
  });

  it("rejects when the directory is missing", () => {
    const registry = createProjectRegistry(db);
    const dir = makeProjectDir("epsilon");
    const record = registry.authorize(dir, "Epsilon", { now: 1_000 });
    rmSync(dir, { recursive: true });
    expect(() => registry.revalidate(record.projectId)).toThrow(ProjectIdentityError);
  });

  it("rejects when the directory was replaced (new inode at the same path)", () => {
    const registry = createProjectRegistry(db);
    const dir = makeProjectDir("zeta");
    const record = registry.authorize(dir, "Zeta", { now: 1_000 });
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    expect(() => registry.revalidate(record.projectId)).toThrow(ProjectIdentityError);
  });

  it("rejects when the canonical path changed (moved)", () => {
    const registry = createProjectRegistry(db);
    const dir = makeProjectDir("eta");
    const record = registry.authorize(dir, "Eta", { now: 1_000 });
    renameSync(dir, join(tempRoot, "eta-moved"));
    expect(() => registry.revalidate(record.projectId)).toThrow(ProjectIdentityError);
  });

  it("rejects when the directory was replaced by a symlink (root substitution)", () => {
    const registry = createProjectRegistry(db);
    const dir = makeProjectDir("theta");
    const record = registry.authorize(dir, "Theta", { now: 1_000 });
    const decoy = makeProjectDir("theta-decoy");
    rmSync(dir, { recursive: true });
    symlinkSync(decoy, dir);
    expect(() => registry.revalidate(record.projectId)).toThrow(ProjectIdentityError);
  });

  it("accepts symlinks inside the project (not a security boundary)", () => {
    const registry = createProjectRegistry(db);
    const dir = makeProjectDir("iota");
    const inner = makeProjectDir("iota-target");
    symlinkSync(inner, join(dir, "inner-link"));
    const record = registry.authorize(dir, "Iota", { now: 1_000 });
    expect(() => registry.revalidate(record.projectId)).not.toThrow();
  });

  it("rejects an unknown projectId", () => {
    const registry = createProjectRegistry(db);
    expect(() => registry.revalidate(randomUUID())).toThrow(ProjectIdentityError);
  });
});

describe("list and remove", () => {
  it("lists authorized projects and omits removed ones", () => {
    const registry = createProjectRegistry(db);
    const dirA = makeProjectDir("kappa");
    const dirB = makeProjectDir("lambda");
    const a = registry.authorize(dirA, "Kappa", { now: 1_000 });
    const b = registry.authorize(dirB, "Lambda", { now: 1_000 });

    let ids = registry.list().map((p) => p.projectId);
    expect(ids).toContain(a.projectId);
    expect(ids).toContain(b.projectId);

    registry.remove(a.projectId);
    ids = registry.list().map((p) => p.projectId);
    expect(ids).not.toContain(a.projectId);
    expect(ids).toContain(b.projectId);

    // A removed project no longer revalidates.
    expect(() => registry.revalidate(a.projectId)).toThrow(ProjectIdentityError);
    // Removing the same project again is a no-op (idempotent).
    expect(() => registry.remove(a.projectId)).not.toThrow();
  });
});
