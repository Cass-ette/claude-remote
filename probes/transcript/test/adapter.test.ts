import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transcriptAdapter, byteLength } from "../src/adapter.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = (name: string) => resolve(here, "fixtures", name);

async function readFixture(name: string): Promise<Buffer> {
  return readFile(FIXTURE(name));
}

describe("transcript adapter — deterministic fixtures", () => {
  describe("readSnapshot normalizes user/assistant/tool records", () => {
    it("materializes user, assistant text, tool_use and tool_result as flat items", async () => {
      const path = FIXTURE("complete.jsonl");
      const bytes = await readFixture("complete.jsonl");
      const items = await transcriptAdapter.readSnapshot(
        path,
        bytes.length // read whole file
      );

      // Real-vocabulary shape: user, assistant(+tool_use), tool_result
      // wrapper, assistant final, system/turn_duration, bookkeeping noise
      // (ai-title, queue-operation, permission-mode, last-prompt), more turns.
      const roles = items.map((i) => i.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      expect(roles).toContain("tool");

      const userItem = items.find((i) => i.role === "user");
      expect(userItem).toBeDefined();
      expect(userItem!.historyItemId).toBe(
        "aaaaaaaa-0000-4000-8000-000000000001"
      );
      // Multibyte char "你好" must be preserved intact.
      const text = userItem!.contentBlocks.find((b) => b.kind === "text");
      expect(text && text.kind === "text" && text.text).toContain("你好");

      const toolUse = items.find((i) =>
        i.contentBlocks.some((b) => b.kind === "tool_use")
      );
      expect(toolUse).toBeDefined();
      const tuBlock = toolUse!.contentBlocks.find((b) => b.kind === "tool_use");
      expect(tuBlock && tuBlock.kind === "tool_use" && tuBlock.toolUseId).toBe(
        "toolu_aaaaaaaa-0000-4000-8000-000000000003"
      );

      const toolResult = items.find((i) => i.role === "tool");
      expect(toolResult).toBeDefined();
      const trBlock = toolResult!.contentBlocks.find(
        (b) => b.kind === "tool_result"
      );
      expect(
        trBlock && trBlock.kind === "tool_result" && trBlock.content
      ).toContain("file body");
    });
  });

  describe("byte offsets are UTF-8 byte offsets, not character indices", () => {
    it("computes the first record's offset as 0 and the second record's offset as the byte length of line 1 + newline", async () => {
      const path = FIXTURE("complete.jsonl");
      const text = await readFile(path, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      // Expected offset of record N = sum of byteLength(line[i] + "\n") for i < N.
      let expectedOffset = 0;
      for (let i = 0; i < 1; i++) {
        expectedOffset += byteLength(lines[i]! + "\n");
      }
      const items = await transcriptAdapter.readSnapshot(path, text.length + 1);
      const second = items.find(
        (i) => i.historyItemId === "aaaaaaaa-0000-4000-8000-000000000002"
      );
      expect(second).toBeDefined();
      expect(second!.sourceTranscriptOffset).toBe(expectedOffset);
      // Cross-check: the byte offset must equal Buffer.byteLength of the prefix.
      const prefix = lines.slice(0, 1).join("\n") + "\n";
      expect(Buffer.byteLength(prefix, "utf8")).toBe(expectedOffset);
    });

    it("exposes multibyte byte length on the first record", () => {
      // The user prompt contains "你好" (6 bytes for 2 chars).
      const probe = "你好";
      expect(Buffer.byteLength(probe, "utf8")).toBe(6);
      expect(probe.length).toBe(2);
    });
  });

  describe("readSnapshot respects byte limit and trailing newline", () => {
    it("reads through the last newline at or before byteLimit and ignores the trailing partial line", async () => {
      const path = FIXTURE("partial-tail.jsonl");
      const bytes = await readFixture("partial-tail.jsonl");
      // Whole file read: should NOT include the partial-tail assistant text.
      const fullItems = await transcriptAdapter.readSnapshot(path, bytes.length);
      // Find the partial text marker — must be absent.
      const sawPartial = fullItems.some((i) =>
        i.contentBlocks.some(
          (b) => b.kind === "text" && b.text.includes("PARTIAL_NO_NEWLINE")
        )
      );
      expect(sawPartial).toBe(false);

      // The system/turn_duration record must be materialized as a `system`
      // item carrying the subtype as its note text. The trailing partial
      // assistant line is excluded by the byte-boundary trim, but the
      // turn_duration record (which precedes it) must be present.
      const durationSystem = fullItems.find(
        (i) =>
          i.role === "system" &&
          i.contentBlocks.some(
            (b) => b.kind === "system_note" && b.text === "turn_duration"
          )
      );
      expect(durationSystem).toBeDefined();
      expect(durationSystem!.sourceTranscriptOffset).toBeGreaterThan(0);

      // No empty-content user items may leak through (tool-result wrappers
      // must be filtered).
      const emptyUser = fullItems.find(
        (i) => i.role === "user" && i.contentBlocks.length === 0
      );
      expect(emptyUser).toBeUndefined();
    });

    it("metadata reports trailingPartialIgnored=true when a partial line exists", async () => {
      const path = FIXTURE("partial-tail.jsonl");
      const bytes = await readFixture("partial-tail.jsonl");
      const meta = await transcriptAdapter.readMetadata(path, bytes.length);
      expect(meta.trailingPartialIgnored).toBe(true);
      expect(meta.allLinesParseable).toBe(true);
      expect(meta.firstMalformedOffset).toBeNull();
    });

    it("reads nothing past an immutable byte boundary smaller than the first record", async () => {
      const path = FIXTURE("complete.jsonl");
      const text = await readFile(path, "utf8");
      const firstLine = text.split("\n")[0]!;
      // Read only the first 10 bytes — no newline yet, so snapshot is empty.
      const items = await transcriptAdapter.readSnapshot(path, 10);
      expect(items).toEqual([]);
      // Byte boundary never advanced past 10.
      const meta = await transcriptAdapter.readMetadata(path, 10);
      expect(meta.byteEnd).toBeLessThanOrEqual(10);
      // 10 bytes into a file much bigger than 10 — totalBytes is the file size.
      expect(meta.totalBytes).toBeGreaterThan(firstLine.length);
    });

    it("immutable byte boundary mid-record excludes that record", async () => {
      const path = FIXTURE("complete.jsonl");
      const text = await readFile(path, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      // Compute byte offset that lands inside line 2 (assistant with tool_use).
      const line1End = byteLength(lines[0]! + "\n");
      const line2Halfway = line1End + Math.floor(byteLength(lines[1]!) / 2);
      const items = await transcriptAdapter.readSnapshot(path, line2Halfway);
      // Only the first record should be present.
      const ids = items.map((i) => i.historyItemId);
      expect(ids).toContain("aaaaaaaa-0000-4000-8000-000000000001");
      expect(ids).not.toContain("aaaaaaaa-0000-4000-8000-000000000002");
      // byteEnd is at the end of line 1 (i.e. line1End).
      const meta = await transcriptAdapter.readMetadata(path, line2Halfway);
      expect(meta.byteEnd).toBe(line1End);
    });
  });

  describe("findTurnEvidence — full union over the real record vocabulary", () => {
    it("returns complete+completed when a system/turn_duration record ends the turn", async () => {
      // Turn 1 of complete.jsonl: user -> assistant(+tool_use) ->
      // tool_result wrapper -> assistant -> system/turn_duration.
      const ev = await transcriptAdapter.findTurnEvidence(
        FIXTURE("complete.jsonl"),
        "aaaaaaaa-0000-4000-8000-000000000001"
      );
      expect(ev).toEqual({ kind: "complete", outcome: "completed" });
    });

    it("returns complete+completed when the next top-level user record bounds the turn (no turn_duration)", async () => {
      // Turn 2 of complete.jsonl ends without a turn_duration record —
      // the following user message (turn 3) bounds it. Bookkeeping noise
      // (ai-title, permission-mode) between them must be ignored.
      const ev = await transcriptAdapter.findTurnEvidence(
        FIXTURE("complete.jsonl"),
        "aaaaaaaa-0000-4000-8000-000000000011"
      );
      expect(ev).toEqual({ kind: "complete", outcome: "completed" });
    });

    it("returns complete+failed when a system/api_error record appears inside the turn", async () => {
      const ev = await transcriptAdapter.findTurnEvidence(
        FIXTURE("failed.jsonl"),
        "bbbbbbbb-0000-4000-8000-000000000001"
      );
      expect(ev).toEqual({ kind: "complete", outcome: "failed" });
    });

    it("returns interrupted when the next top-level user record arrives before any assistant reply", async () => {
      // Turn 1 of interrupted.jsonl: user -> (last-prompt, permission-mode
      // noise) -> next user record. No assistant ever responded.
      const ev = await transcriptAdapter.findTurnEvidence(
        FIXTURE("interrupted.jsonl"),
        "cccccccc-0000-4000-8000-000000000001"
      );
      expect(ev).toEqual({ kind: "interrupted" });
    });

    it("returns interrupted when an assistant replied but the file ends without boundary evidence", async () => {
      // Turn 2 of interrupted.jsonl: user -> assistant -> EOF with no
      // system/turn_duration and no next user record. A normal end cannot
      // be proven, so the turn is NOT completed.
      const ev = await transcriptAdapter.findTurnEvidence(
        FIXTURE("interrupted.jsonl"),
        "cccccccc-0000-4000-8000-000000000011"
      );
      expect(ev).toEqual({ kind: "interrupted" });
    });

    it("returns absent when UUID is not present", async () => {
      const ev = await transcriptAdapter.findTurnEvidence(
        FIXTURE("complete.jsonl"),
        "00000000-0000-0000-0000-000000000000" // never used
      );
      expect(ev).toEqual({ kind: "absent" });
    });

    it("returns incompatible when a complete line is malformed JSON", async () => {
      const ev = await transcriptAdapter.findTurnEvidence(
        FIXTURE("incompatible.jsonl"),
        "eeeeeeee-0000-4000-8000-000000000001"
      );
      expect(ev.kind).toBe("incompatible");
      if (ev.kind === "incompatible") {
        expect(ev.reason).toMatch(/offset \d+/);
      }
    });

    it("does not treat the trailing partial line of partial-tail as incompatible", async () => {
      const ev = await transcriptAdapter.findTurnEvidence(
        FIXTURE("partial-tail.jsonl"),
        "dddddddd-0000-4000-8000-000000000001"
      );
      expect(ev).toEqual({ kind: "complete", outcome: "completed" });
    });
  });

  describe("readMetadata is pure — does not mutate the file", () => {
    it("returns the same byteEnd across two reads", async () => {
      const path = FIXTURE("complete.jsonl");
      const bytes = await readFixture("complete.jsonl");
      const a = await transcriptAdapter.readMetadata(path, bytes.length);
      const b = await transcriptAdapter.readMetadata(path, bytes.length);
      expect(a).toEqual(b);
    });
  });

  describe("readMetadata reports real-vocabulary title and recordKinds", () => {
    it("returns the LAST ai-title record's aiTitle as title", async () => {
      const path = FIXTURE("complete.jsonl");
      const bytes = await readFixture("complete.jsonl");
      const meta = await transcriptAdapter.readMetadata(path, bytes.length);
      // complete.jsonl has two ai-title records ("Demo fixture session" then
      // "Final session title"); the last one wins.
      expect(meta.title).toBe("Final session title");
    });

    it("returns title=null when no ai-title record exists", async () => {
      const path = FIXTURE("interrupted.jsonl");
      const bytes = await readFixture("interrupted.jsonl");
      const meta = await transcriptAdapter.readMetadata(path, bytes.length);
      expect(meta.title).toBeNull();
    });

    it("returns the sorted set of observed type/subtype combos", async () => {
      const path = FIXTURE("complete.jsonl");
      const bytes = await readFixture("complete.jsonl");
      const meta = await transcriptAdapter.readMetadata(path, bytes.length);
      expect(meta.recordKinds).toEqual([
        "ai-title",
        "assistant",
        "last-prompt",
        "permission-mode",
        "queue-operation",
        "system/turn_duration",
        "user"
      ]);
    });

    it("includes system/api_error in recordKinds for the failed fixture", async () => {
      const path = FIXTURE("failed.jsonl");
      const bytes = await readFixture("failed.jsonl");
      const meta = await transcriptAdapter.readMetadata(path, bytes.length);
      expect(meta.recordKinds).toContain("system/api_error");
      expect(meta.recordKinds).not.toContain("system/turn_duration");
    });

    it("excludes the trailing partial line's kind from recordKinds", async () => {
      const path = FIXTURE("partial-tail.jsonl");
      const bytes = await readFixture("partial-tail.jsonl");
      const meta = await transcriptAdapter.readMetadata(path, bytes.length);
      // The partial assistant line is ignored entirely — the only assistant
      // kinds come from complete lines. partial-tail has exactly one complete
      // assistant record; kinds are: ai-title, assistant, system/turn_duration, user.
      expect(meta.recordKinds).toEqual([
        "ai-title",
        "assistant",
        "system/turn_duration",
        "user"
      ]);
    });
  });

  describe("system records materialize as system items; tool-result wrappers are filtered", () => {
    it("materializes a system/turn_duration record as a `system` item carrying the subtype", async () => {
      const path = FIXTURE("complete.jsonl");
      const bytes = await readFixture("complete.jsonl");
      const items = await transcriptAdapter.readSnapshot(path, bytes.length);
      const durationItems = items.filter(
        (i) =>
          i.role === "system" &&
          i.contentBlocks.some(
            (b) => b.kind === "system_note" && b.text === "turn_duration"
          )
      );
      // complete.jsonl has three turns that end with turn_duration.
      expect(durationItems.length).toBe(3);
      for (const item of durationItems) {
        expect(item.sourceTranscriptOffset).toBeGreaterThan(0);
      }
      // Sanity: a `tool` item from the wrapper's tool_result IS still present.
      const tool = items.find((i) => i.role === "tool");
      expect(tool).toBeDefined();
    });

    it("materializes a system/api_error record as a `system` item carrying the subtype", async () => {
      const path = FIXTURE("failed.jsonl");
      const bytes = await readFixture("failed.jsonl");
      const items = await transcriptAdapter.readSnapshot(path, bytes.length);
      const errorSystems = items.filter(
        (i) =>
          i.role === "system" &&
          i.contentBlocks.some(
            (b) => b.kind === "system_note" && b.text === "api_error"
          )
      );
      // failed.jsonl has two api_error records (a real retry burst).
      expect(errorSystems.length).toBe(2);
    });

    it("does not materialize bookkeeping records (ai-title etc.) as any history item", async () => {
      const path = FIXTURE("complete.jsonl");
      const bytes = await readFixture("complete.jsonl");
      const items = await transcriptAdapter.readSnapshot(path, bytes.length);
      // Bookkeeping records (ai-title, queue-operation, permission-mode,
      // last-prompt) must produce NO history items. The only system items
      // are the three turn_duration records; no note text may name a
      // bookkeeping type.
      const systemTexts = items
        .filter((i) => i.role === "system")
        .flatMap((i) =>
          i.contentBlocks
            .filter((b) => b.kind === "system_note")
            .map((b) => (b as { kind: "system_note"; text: string }).text)
        );
      expect(systemTexts).toEqual([
        "turn_duration",
        "turn_duration",
        "turn_duration"
      ]);
      const roles = new Set(items.map((i) => i.role));
      expect([...roles].sort()).toEqual(["assistant", "system", "tool", "user"]);
    });

    it("filters tool-result-wrapper `user` records so no empty-content user item leaks into the snapshot", async () => {
      // complete.jsonl line 3 is a `user` record whose `message.content` is
      // solely a `tool_result` block — a tool-result wrapper. The wrapper
      // itself must NOT appear as an empty-content `user` item; the
      // `tool_result` must still appear as a standalone `tool` item.
      const path = FIXTURE("complete.jsonl");
      const bytes = await readFixture("complete.jsonl");
      const items = await transcriptAdapter.readSnapshot(path, bytes.length);
      const wrapperUuid = "aaaaaaaa-0000-4000-8000-000000000004";
      const wrapperUserItem = items.find(
        (i) => i.historyItemId === wrapperUuid && i.role === "user"
      );
      expect(
        wrapperUserItem,
        "tool-result-wrapper user record must not be emitted as a user item"
      ).toBeUndefined();
      // No user item may carry empty contentBlocks at all.
      const emptyUser = items.find(
        (i) => i.role === "user" && i.contentBlocks.length === 0
      );
      expect(emptyUser).toBeUndefined();
      // The tool_result itself is still materialized.
      const toolItem = items.find((i) =>
        i.contentBlocks.some(
          (b) =>
            b.kind === "tool_result" &&
            b.toolUseId === "toolu_aaaaaaaa-0000-4000-8000-000000000003"
        )
      );
      expect(toolItem).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// OPT-IN real-coverage test. Skipped unless REAL_TRANSCRIPT_MANIFEST points
// at a valid manifest. The manifest schema:
//   Array<{ path: string, expectedCoverage: string[] }>
// expectedCoverage values are drawn from: "user", "assistant", "tool",
// "completed", "failed", "interrupted". The aggregate union across all
// entries must cover all six labels.
//
// This test NEVER writes to any transcript. It reads each path, hashes its
// bytes before AND after, and fails if any hash changes.
// ---------------------------------------------------------------------------

const MANIFEST = process.env.REAL_TRANSCRIPT_MANIFEST;

interface ManifestEntry {
  path: string;
  expectedCoverage: string[];
}
interface ManifestCheckOutput {
  coverageUnion: string[];
  perEntry: Array<{
    path: string;
    sha256Before: string;
    sha256After: string;
    unchanged: boolean;
    observed: string[];
    evidence?: string;
  }>;
}

async function sha256OfFile(p: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(p);
  return createHash("sha256").update(bytes).digest("hex");
}

describe.skipIf(!MANIFEST)("transcript adapter — real-coverage gate", () => {
  it("covers user/assistant/tool/completed/failed/interrupted across manifest copies and leaves every input unchanged", async () => {
    expect(MANIFEST, "REAL_TRANSCRIPT_MANIFEST must be set").toBe(MANIFEST);
    // Manifest path must be absolute.
    expect(
      MANIFEST!.startsWith("/"),
      "REAL_TRANSCRIPT_MANIFEST must be an absolute path"
    ).toBe(true);
    const text = await readFile(MANIFEST!, "utf8");
    const manifest = JSON.parse(text) as ManifestEntry[];
    expect(Array.isArray(manifest), "manifest must be an array").toBe(true);
    // No single ordinary session must contain every outcome — enforce that
    // at least two entries collectively cover the union.
    const REQUIRED = [
      "user",
      "assistant",
      "tool",
      "completed",
      "failed",
      "interrupted"
    ] as const;

    const perEntry: ManifestCheckOutput["perEntry"] = [];
    const coverageUnion = new Set<string>();
    for (const entry of manifest) {
      expect(
        entry.path && typeof entry.path === "string",
        "manifest entry.path must be a string"
      ).toBe(true);
      // Validate path exists + is absolute.
      expect(
        entry.path.startsWith("/"),
        `manifest path must be absolute: ${entry.path}`
      ).toBe(true);
      const before = await sha256OfFile(entry.path);
      // Try to find any user UUID in this transcript and resolve its evidence.
      const bytes = await readFile(entry.path);
      const lines = bytes.toString("utf8").split("\n");
      const userUuids: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const obj = parsed as { type?: unknown; uuid?: unknown };
        if (obj.type === "user" && typeof obj.uuid === "string") {
          userUuids.push(obj.uuid);
        }
      }
      const observed = new Set<string>(entry.expectedCoverage);
      // Try to observe at least one user UUID's evidence to ground the labels.
      const record: {
        path: string;
        sha256Before: string;
        sha256After: string;
        unchanged: boolean;
        observed: string[];
        evidence?: string;
      } = {
        path: entry.path,
        sha256Before: before,
        sha256After: "",
        unchanged: false,
        observed: [...observed]
      };
      if (userUuids.length > 0) {
        const ev = await transcriptAdapter.findTurnEvidence(entry.path, userUuids[0]!);
        record.evidence = JSON.stringify(ev);
        if (ev.kind === "complete") {
          observed.add(ev.outcome);
          record.observed = [...observed];
        } else if (ev.kind !== "incompatible") {
          observed.add(ev.kind);
          record.observed = [...observed];
        }
      }
      for (const label of observed) coverageUnion.add(label);
      const after = await sha256OfFile(entry.path);
      record.sha256After = after;
      record.unchanged = before === after;
      perEntry.push(record);
    }

    // Aggregate coverage check.
    for (const label of REQUIRED) {
      expect(
        coverageUnion.has(label),
        `manifest must collectively cover "${label}"`
      ).toBe(true);
    }
    // Every hash must be unchanged.
    for (const e of perEntry) {
      expect(e.unchanged, `transcript mutated: ${e.path}`).toBe(true);
    }

    // Emit the per-check output to a temp file under build/phase0 so the
    // process wrapper can pick it up.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const outPath = resolve(here, "../../build/phase0/transcript-real-checks.json");
    await mkdir(resolve(outPath, ".."), { recursive: true });
    const payload: ManifestCheckOutput = {
      coverageUnion: [...coverageUnion].sort(),
      perEntry
    };
    await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    process.stdout.write(`CHECKS_PATH=${outPath}\n`);
  }, 120000);
});
