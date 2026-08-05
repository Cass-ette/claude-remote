// Transcript discovery and stabilization for the Claude Code compatibility
// gate.
//
// After `system/init`, the candidate CLI writes a `<sessionId>.jsonl` file
// under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/...`. The gate counts
// complete JSONL `user` records whose UUID matches a known request UUID both
// before and after a resume/retry, to assert that replayed messages are
// de-duplicated rather than double-counted.
//
// This module is deliberately defensive:
//
//   * it searches recursively but rejects ambiguous matches (more than one
//     file matching the sessionId);
//   * it waits for the file to end in `\n` AND for its size to be unchanged
//     across three 200 ms observations before reading;
//   * it counts only fully-parsed user records with a UUID field, ignoring
//     assistant/result/system lines and partial/malformed lines.
//
// It NEVER prints transcript content or auth env vars.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TranscriptUserRecord {
  uuid: string;
  line: string;
}

export interface StabilizedTranscript {
  path: string;
  size: number;
  userRecords: TranscriptUserRecord[];
  userRecordsWithUuid: string[];
}

export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? homedir() + "/.claude";
}

export function projectsDir(): string {
  return join(configDir(), "projects");
}

async function* walk(dir: string): AsyncIterable<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry.name);
    const full = join(dir, name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

/**
 * Find the unique transcript file matching `sessionId`. Returns `null` if no
 * match is found, or throws if more than one file matches (ambiguous).
 */
export async function findTranscript(sessionId: string): Promise<string | null> {
  const matches: string[] = [];
  const target = `${sessionId}.jsonl`;
  for await (const p of walk(projectsDir())) {
    // Match on the basename only — the candidate writes one file per session
    // at projects/<encoded-cwd>/<sessionId>.jsonl.
    if (p.endsWith(target)) {
      matches.push(p);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `ambiguous transcript match for session ${sessionId}: ${matches.join(", ")}`
    );
  }
  return matches[0] ?? null;
}

/**
 * Wait for `path` to stabilize: file must end in `\n`, and its size must be
 * unchanged for three consecutive 200 ms observations. Resolves with the
 * final size, or rejects after `timeoutMs` (default 10s).
 */
export async function waitForStable(
  path: string,
  opts: { intervalMs?: number; samples?: number; timeoutMs?: number } = {}
): Promise<number> {
  const intervalMs = opts.intervalMs ?? 200;
  const samples = opts.samples ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const deadline = Date.now() + timeoutMs;

  let lastSize = -1;
  let stableCount = 0;
  while (Date.now() < deadline) {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(path);
    } catch {
      // File may not exist yet. Reset and keep waiting.
      stableCount = 0;
      lastSize = -1;
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    if (st.size === lastSize && st.size > 0) {
      stableCount++;
    } else {
      stableCount = 0;
      lastSize = st.size;
    }
    if (stableCount >= samples - 1) {
      // Verify the file ends in a newline before declaring victory.
      const fh = await readFile(path);
      if (fh.length > 0 && fh[fh.length - 1] === 0x0a) {
        return st.size;
      }
      // Not newline-terminated yet; reset and keep polling.
      stableCount = 0;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`transcript ${path} did not stabilize within ${timeoutMs}ms`);
}

/**
 * Read a stabilized transcript and return all complete `user` records. Lines
 * that are not valid JSON or that lack `type === "user"` are ignored. Only
 * records carrying a non-empty `uuid` are returned in `userRecordsWithUuid`.
 */
export async function readUserRecords(path: string): Promise<TranscriptUserRecord[]> {
  const text = await readFile(path, "utf8");
  const records: TranscriptUserRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const obj = parsed as { type?: string; uuid?: unknown };
    if (obj.type !== "user") continue;
    if (typeof obj.uuid !== "string" || !obj.uuid) continue;
    records.push({ uuid: obj.uuid, line: trimmed });
  }
  return records;
}

/**
 * Count how many complete `user` records in the transcript carry the given
 * `requestUuid`. The compatibility gate uses this to assert that replaying a
 * user message does NOT create a duplicate record (the count must remain 1).
 */
export async function countByUuid(path: string, requestUuid: string): Promise<number> {
  const records = await readUserRecords(path);
  return records.filter((r) => r.uuid === requestUuid).length;
}

/**
 * Convenience: find, stabilize, and snapshot in one call.
 */
export async function stabilizeAndRead(
  sessionId: string,
  opts: { intervalMs?: number; samples?: number; timeoutMs?: number } = {}
): Promise<StabilizedTranscript> {
  const path = await findTranscript(sessionId);
  if (!path) {
    throw new Error(`no transcript found for session ${sessionId}`);
  }
  const size = await waitForStable(path, opts);
  const userRecords = await readUserRecords(path);
  return {
    path,
    size,
    userRecords,
    userRecordsWithUuid: userRecords.map((r) => r.uuid)
  };
}
