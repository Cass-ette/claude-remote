/**
 * Production history adapter tests (Task 19, spec §6.7).
 *
 * The adapter is a port of the Phase 0 gate-passed probe adapter
 * (probes/transcript/src/adapter.ts, commit f343f7e) with production
 * additions: transcript-path containment under the bound project's
 * transcript directory, typed missing-file errors, and byteLimit
 * validation. Fixtures are the probe's real-vocabulary transcripts.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADAPTER_VERSION,
  InvalidByteLimitError,
  TranscriptNotFoundError,
  TranscriptPathOutsideProjectError,
  computeHistoryRevision,
  createClaudeTranscriptAdapter,
  encodeProjectPath,
  transcriptDirForProject,
  transcriptPathForSession,
} from "../../src/history/claude-2.1.133-adapter.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = (name: string) => join(here, "fixtures", name);

const PROJECT_ROOT = "/fake/project/demo";
const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000099";
const SESSION_B = "bbbbbbbb-0000-4000-8000-000000000099";
const SESSION_C = "cccccccc-0000-4000-8000-000000000099";
const SESSION_D = "dddddddd-0000-4000-8000-000000000099";
const SESSION_E = "eeeeeeee-0000-4000-8000-000000000099";

let dir: string;
let configDir: string;
let transcriptDir: string;
let adapter: ReturnType<typeof createClaudeTranscriptAdapter>;

function placeFixture(fixture: string, sessionId: string): string {
  const path = join(transcriptDir, `${sessionId}.jsonl`);
  copyFileSync(FIXTURE(fixture), path);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "history-adapter-"));
  configDir = join(dir, ".claude");
  transcriptDir = transcriptDirForProject(configDir, PROJECT_ROOT);
  mkdirSync(transcriptDir, { recursive: true });
  adapter = createClaudeTranscriptAdapter({ projectRoot: PROJECT_ROOT, claudeConfigDir: configDir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("path helpers", () => {
  it("encodes every non-[a-zA-Z0-9-] char as - (verified against 24 real ~/.claude/projects dir names)", () => {
    expect(encodeProjectPath("/Users/chenzilve/Projects/animation")).toBe(
      "-Users-chenzilve-Projects-animation",
    );
    expect(encodeProjectPath("/Users/chenzilve/Projects/apt- refactor")).toBe(
      "-Users-chenzilve-Projects-apt--refactor",
    );
    expect(encodeProjectPath("/Users/chenzilve/Projects/devmac++")).toBe(
      "-Users-chenzilve-Projects-devmac--",
    );
    expect(encodeProjectPath("/Users/chenzilve/Projects/BlueLotus_XSSReceiver")).toBe(
      "-Users-chenzilve-Projects-BlueLotus-XSSReceiver",
    );
    expect(encodeProjectPath("/private/var/folders/c9/nh__f38j111_x")).toBe(
      "-private-var-folders-c9-nh--f38j111-x",
    );
    expect(encodeProjectPath("/private/tmp/claude-gate-diag")).toBe(
      "-private-tmp-claude-gate-diag",
    );
    expect(encodeProjectPath("/")).toBe("-");
  });

  it("derives the transcript dir and per-session path", () => {
    expect(transcriptDirForProject("/cfg", "/Users/x/p")).toBe("/cfg/projects/-Users-x-p");
    expect(transcriptPathForSession("/cfg", "/Users/x/p", SESSION_A)).toBe(
      `/cfg/projects/-Users-x-p/${SESSION_A}.jsonl`,
    );
  });
});

describe("readMetadata", () => {
  it("reports byte boundaries, last-wins ai-title, and record kinds for a complete file", async () => {
    const path = placeFixture("complete.jsonl", SESSION_A);
    const meta = await adapter.readMetadata(path, Number.MAX_SAFE_INTEGER);
    expect(meta.totalBytes).toBeGreaterThan(0);
    expect(meta.totalBytes).toBe(meta.byteEnd); // fixture ends with \n
    expect(meta.trailingPartialIgnored).toBe(false);
    expect(meta.allLinesParseable).toBe(true);
    expect(meta.firstMalformedOffset).toBeNull();
    expect(meta.title).toBe("Final session title"); // LAST ai-title wins
    expect(meta.recordKinds).toContain("user");
    expect(meta.recordKinds).toContain("assistant");
    expect(meta.recordKinds).toContain("system/turn_duration");
    expect(meta.recordKinds).toContain("ai-title");
  });

  it("marks a trailing partial line as ignored without counting it malformed", async () => {
    const path = placeFixture("partial-tail.jsonl", SESSION_D);
    const meta = await adapter.readMetadata(path, Number.MAX_SAFE_INTEGER);
    expect(meta.trailingPartialIgnored).toBe(true);
    expect(meta.byteEnd).toBeLessThan(meta.totalBytes);
    expect(meta.allLinesParseable).toBe(true);
    expect(meta.title).toBe("Partial tail session");
  });

  it("clamps byteLimit above the file size", async () => {
    const path = placeFixture("complete.jsonl", SESSION_A);
    const meta = await adapter.readMetadata(path, Number.MAX_SAFE_INTEGER);
    const clamped = await adapter.readMetadata(path, meta.totalBytes + 10_000);
    expect(clamped.byteEnd).toBe(meta.byteEnd);
    expect(clamped.title).toBe(meta.title);
  });
});

describe("readSnapshot", () => {
  it("materializes user/assistant/tool items with real-vocabulary normalization", async () => {
    const path = placeFixture("complete.jsonl", SESSION_A);
    const { items, byteEnd } = await adapter.readSnapshot(path, Number.MAX_SAFE_INTEGER);
    expect(byteEnd).toBe((await adapter.readMetadata(path, Number.MAX_SAFE_INTEGER)).totalBytes);

    const userItem = items.find((i) => i.historyItemId === "aaaaaaaa-0000-4000-8000-000000000001");
    expect(userItem).toBeDefined();
    expect(userItem?.role).toBe("user");
    const text = userItem?.contentBlocks.find((b) => b.kind === "text");
    expect(text && text.kind === "text" ? text.text : "").toContain("你好");

    const toolUse = items.find((i) =>
      i.historyItemId === "toolu_aaaaaaaa-0000-4000-8000-000000000003",
    );
    expect(toolUse?.role).toBe("assistant");

    const toolResult = items.find((i) => i.role === "tool");
    const trBlock = toolResult?.contentBlocks.find((b) => b.kind === "tool_result");
    expect(trBlock && trBlock.kind === "tool_result" ? trBlock.content : "").toContain("file body");
  });

  it("ends at the last complete newline at or before byteLimit and never reads past it", async () => {
    const path = placeFixture("partial-tail.jsonl", SESSION_D);
    const full = await adapter.readSnapshot(path, Number.MAX_SAFE_INTEGER);
    const stat = await adapter.readMetadata(path, Number.MAX_SAFE_INTEGER);

    // Cut in the middle of the LAST line (the partial-tail assistant record):
    // the read must stop at the last complete newline strictly before the cut.
    const cut = stat.totalBytes - 3;
    const partial = await adapter.readSnapshot(path, cut);
    expect(partial.byteEnd).toBe(stat.byteEnd); // trimmed back to the same boundary
    expect(partial.bytes.length).toBe(stat.byteEnd);
    expect(partial.items.length).toBe(full.items.length);
    expect(
      partial.items.some((i) =>
        i.contentBlocks.some((b) => b.kind === "text" && b.text.includes("PARTIAL_NO_NEWLINE")),
      ),
    ).toBe(false);
    // Every materialized record starts before the byte boundary.
    for (const item of partial.items) {
      expect(item.sourceTranscriptOffset).toBeLessThan(partial.byteEnd);
    }
  });

  it("cuts mid-record when byteLimit falls inside a complete record", async () => {
    const path = placeFixture("complete.jsonl", SESSION_A);
    const full = await adapter.readSnapshot(path, Number.MAX_SAFE_INTEGER);
    // Find the second user item and cut just before its record completes.
    const secondUser = full.items.find((i) => i.historyItemId === "aaaaaaaa-0000-4000-8000-000000000011");
    expect(secondUser).toBeDefined();
    const cut = secondUser!.sourceTranscriptOffset + 10; // inside that line
    const cutRead = await adapter.readSnapshot(path, cut);
    expect(cutRead.byteEnd).toBeLessThanOrEqual(cut);
    // The cut record itself must not be materialized.
    expect(cutRead.items.find((i) => i.historyItemId === secondUser!.historyItemId)).toBeUndefined();
    // But the first turn survives intact.
    expect(cutRead.items.find((i) => i.historyItemId === "aaaaaaaa-0000-4000-8000-000000000001")).toBeDefined();
  });
});

describe("findTurnEvidence — gate-passed classification, byte-identical", () => {
  it("classifies a normally-terminated turn as complete/completed via system/turn_duration", async () => {
    const path = placeFixture("complete.jsonl", SESSION_A);
    await expect(
      adapter.findTurnEvidence(path, "aaaaaaaa-0000-4000-8000-000000000001"),
    ).resolves.toEqual({ kind: "complete", outcome: "completed" });
  });

  it("classifies a turn bounded by the next top-level user record as complete/completed", async () => {
    const path = placeFixture("complete.jsonl", SESSION_A);
    await expect(
      adapter.findTurnEvidence(path, "aaaaaaaa-0000-4000-8000-000000000011"),
    ).resolves.toEqual({ kind: "complete", outcome: "completed" });
  });

  it("classifies a turn with system/api_error as complete/failed", async () => {
    const path = placeFixture("failed.jsonl", SESSION_B);
    await expect(
      adapter.findTurnEvidence(path, "bbbbbbbb-0000-4000-8000-000000000001"),
    ).resolves.toEqual({ kind: "complete", outcome: "failed" });
  });

  it("classifies a turn with a follow-up user message and no assistant response as interrupted", async () => {
    const path = placeFixture("interrupted.jsonl", SESSION_C);
    await expect(
      adapter.findTurnEvidence(path, "cccccccc-0000-4000-8000-000000000001"),
    ).resolves.toEqual({ kind: "interrupted" });
  });

  it("classifies an assistant response with no boundary evidence as interrupted", async () => {
    const path = placeFixture("interrupted.jsonl", SESSION_C);
    await expect(
      adapter.findTurnEvidence(path, "cccccccc-0000-4000-8000-000000000011"),
    ).resolves.toEqual({ kind: "interrupted" });
  });

  it("returns absent for an unknown UUID", async () => {
    const path = placeFixture("complete.jsonl", SESSION_A);
    await expect(
      adapter.findTurnEvidence(path, "00000000-0000-4000-8000-0000000000ff"),
    ).resolves.toEqual({ kind: "absent" });
  });

  it("returns incompatible when a complete line fails JSON.parse", async () => {
    const path = placeFixture("incompatible.jsonl", SESSION_E);
    const evidence = await adapter.findTurnEvidence(
      path,
      "eeeeeeee-0000-4000-8000-000000000001",
    );
    expect(evidence.kind).toBe("incompatible");
    if (evidence.kind === "incompatible") {
      expect(evidence.reason).toMatch(/malformed JSON at byte offset/);
    }
  });

  it("ignores sidechain records when resolving boundaries", async () => {
    // Inline transcript: user turn whose only assistant response is on a
    // sidechain, followed by turn_duration. Sidechain records must not count
    // as responses, so the turn classifies as interrupted.
    const sessionId = "12345678-0000-4000-8000-000000000001";
    const path = join(transcriptDir, `${sessionId}.jsonl`);
    const records = [
      { type: "user", uuid: "u-1", message: { role: "user", content: [{ type: "text", text: "hi" }] }, timestamp: "2026-08-01T10:00:00.000Z" },
      { type: "assistant", uuid: "a-1", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "sidechain reply" }] }, timestamp: "2026-08-01T10:00:01.000Z" },
      { type: "system", subtype: "turn_duration", uuid: "s-1", timestamp: "2026-08-01T10:00:02.000Z" },
    ];
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await expect(adapter.findTurnEvidence(path, "u-1")).resolves.toEqual({ kind: "interrupted" });
  });
});

describe("production error paths", () => {
  it("rejects a transcript path outside the bound project's transcript directory", async () => {
    const otherDir = join(configDir, "projects", "-another-project");
    mkdirSync(otherDir, { recursive: true });
    const outside = join(otherDir, `${SESSION_A}.jsonl`);
    copyFileSync(FIXTURE("complete.jsonl"), outside);
    await expect(adapter.readMetadata(outside, 100)).rejects.toBeInstanceOf(
      TranscriptPathOutsideProjectError,
    );
    await expect(adapter.readSnapshot(outside, 100)).rejects.toMatchObject({
      code: "TRANSCRIPT_PATH_OUTSIDE_PROJECT",
    });
    await expect(adapter.findTurnEvidence(outside, "u")).rejects.toMatchObject({
      code: "TRANSCRIPT_PATH_OUTSIDE_PROJECT",
    });
  });

  it("rejects an arbitrary absolute path that merely collides lexically", async () => {
    // A path under a DIFFERENT real temp directory must be rejected even
    // though it is a real, readable file.
    const elsewhere = join(dir, "elsewhere.jsonl");
    copyFileSync(FIXTURE("complete.jsonl"), elsewhere);
    await expect(adapter.readSnapshot(elsewhere, 100)).rejects.toBeInstanceOf(
      TranscriptPathOutsideProjectError,
    );
  });

  it("throws a typed error for a missing transcript file", async () => {
    const missing = join(transcriptDir, `${SESSION_A}.jsonl`);
    await expect(adapter.readMetadata(missing, 100)).rejects.toMatchObject({
      name: "TranscriptNotFoundError",
      code: "TRANSCRIPT_NOT_FOUND",
    });
    await expect(adapter.readSnapshot(missing, 100)).rejects.toBeInstanceOf(TranscriptNotFoundError);
    await expect(adapter.findTurnEvidence(missing, "u")).rejects.toBeInstanceOf(TranscriptNotFoundError);
  });

  it("throws a typed error for byteLimit <= 0", async () => {
    const path = placeFixture("complete.jsonl", SESSION_A);
    await expect(adapter.readMetadata(path, 0)).rejects.toBeInstanceOf(InvalidByteLimitError);
    await expect(adapter.readSnapshot(path, -5)).rejects.toMatchObject({
      code: "INVALID_BYTE_LIMIT",
    });
    await expect(adapter.readSnapshot(path, Number.NaN)).rejects.toBeInstanceOf(InvalidByteLimitError);
  });
});

describe("computeHistoryRevision (spec §6.7)", () => {
  it("is the SHA-256 of adapter version + canonical transcript path + byte limit + bytes actually read", async () => {
    const path = placeFixture("partial-tail.jsonl", SESSION_D);
    const read = await adapter.readSnapshot(path, Number.MAX_SAFE_INTEGER);
    const revision = computeHistoryRevision(
      ADAPTER_VERSION,
      path,
      read.byteEnd,
      read.bytes,
    );
    // Deterministic across calls.
    expect(computeHistoryRevision(ADAPTER_VERSION, path, read.byteEnd, read.bytes)).toBe(revision);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    // Changing the byte boundary (fewer bytes read) changes the revision.
    const shorter = await adapter.readSnapshot(path, read.byteEnd - 40);
    expect(computeHistoryRevision(ADAPTER_VERSION, path, shorter.byteEnd, shorter.bytes)).not.toBe(
      revision,
    );
    // Changing the adapter version changes the revision.
    expect(computeHistoryRevision("other-version", path, read.byteEnd, read.bytes)).not.toBe(revision);
    // Changing the path changes the revision.
    const otherPath = join(transcriptDir, "dddddddd-0000-4000-8000-000000000098.jsonl");
    copyFileSync(path, otherPath);
    expect(computeHistoryRevision(ADAPTER_VERSION, otherPath, read.byteEnd, read.bytes)).not.toBe(
      revision,
    );
  });
});
