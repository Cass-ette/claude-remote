// Pure read-only adapter implementation.
//
// Invariants:
//   * NEVER writes, repairs, or truncates a transcript.
//   * `readSnapshot(path, byteLimit)` only reads bytes `[0, byteLimit)` and
//     further trims to the last `\n` at or before `byteLimit`.
//   * Trailing partial line (no terminating newline) is ignored, never
//     reported as incompatible.
//   * `incompatible` is reported ONLY when a complete line fails JSON.parse.
//   * All offsets are UTF-8 byte offsets.

import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import type {
  ContentBlock,
  HistoryItem,
  HistoryRole,
  TranscriptAdapter,
  TranscriptMetadata,
  TurnEvidence
} from "./types.js";

interface ParsedLine {
  /** Byte offset of the first byte of this line (inclusive). */
  byteOffset: number;
  /** Byte length of this line INCLUDING the terminating `\n`. */
  byteLength: number;
  /** Raw line string WITHOUT the terminating newline. */
  raw: string;
  /** True iff the line was terminated by `\n` (i.e. is a complete record). */
  complete: boolean;
}

function splitIntoLines(bytes: Buffer): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      // newline at i; line covers [lineStart, i] inclusive
      const raw = bytes.subarray(lineStart, i).toString("utf8");
      const byteLength = i - lineStart + 1;
      lines.push({ byteOffset: lineStart, byteLength, raw, complete: true });
      lineStart = i + 1;
    }
  }
  if (lineStart < bytes.length) {
    // trailing partial line, no newline
    const raw = bytes.subarray(lineStart).toString("utf8");
    lines.push({
      byteOffset: lineStart,
      byteLength: bytes.length - lineStart,
      raw,
      complete: false
    });
  }
  return lines;
}

/** Truncate `bytes` to the last newline at or before `byteLimit`. */
function trimToLastNewline(bytes: Buffer, byteLimit: number): {
  buffer: Buffer;
  trailingPartialIgnored: boolean;
  partialBytes: number;
} {
  const cap = Math.min(byteLimit, bytes.length);
  if (cap === 0) {
    return { buffer: Buffer.alloc(0), trailingPartialIgnored: false, partialBytes: 0 };
  }
  // Find the LAST `\n` at index < cap. If bytes[cap-1] is `\n`, that counts
  // as "ends exactly at the limit" — no partial to trim.
  let lastNewline = -1;
  for (let i = cap - 1; i >= 0; i--) {
    if (bytes[i] === 0x0a) {
      lastNewline = i;
      break;
    }
  }
  if (lastNewline === cap - 1) {
    // The cap is itself a newline; everything in [0, cap) is complete.
    return {
      buffer: bytes.subarray(0, cap),
      trailingPartialIgnored: false,
      partialBytes: 0
    };
  }
  if (lastNewline === -1) {
    // No newline found at all in [0, cap); nothing complete to read.
    return {
      buffer: Buffer.alloc(0),
      trailingPartialIgnored: cap > 0,
      partialBytes: cap
    };
  }
  // Trim to [0, lastNewline + 1); the trailing [lastNewline+1, cap) is partial.
  return {
    buffer: bytes.subarray(0, lastNewline + 1),
    trailingPartialIgnored: true,
    partialBytes: cap - (lastNewline + 1)
  };
}

interface ParsedRecord {
  line: ParsedLine;
  json: unknown;
}

function tryParse(line: ParsedLine): ParsedRecord | null {
  if (!line.complete) return null;
  if (line.raw.trim().length === 0) return null;
  try {
    return { line, json: JSON.parse(line.raw) };
  } catch {
    return null;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Map a parsed JSON record to a {@link HistoryItem}, or return `null` if the
 * record is not a recognized history-bearing record (user / assistant).
 *
 * `tool_use` and `tool_result` are normalized but also contribute their own
 * items when they appear inside a `user`/`assistant` message; we surface them
 * as standalone items keyed by their tool_use_id so that snapshot consumers
 * get a flat, deduplicatable list.
 */
function toHistoryItems(rec: ParsedRecord): HistoryItem[] {
  const obj = rec.json as { type?: unknown };
  const items: HistoryItem[] = [];
  const baseOffset = rec.line.byteOffset;
  const createdAt = asString((rec.json as { timestamp?: unknown }).timestamp) ?? "";
  if (obj.type === "user") {
    const uuid = asString((rec.json as { uuid?: unknown }).uuid);
    const msg = (rec.json as { message?: unknown }).message as
      | { content?: unknown }
      | undefined;
    const blocks = normalizeContent(msg?.content);
    // A `user` record whose content is solely `tool_result` blocks is a
    // tool-result wrapper (part of an in-flight assistant turn). Such records
    // carry no user-authored text or tool_use, and `normalizeContent` already
    // surfaces each `tool_result` as a standalone `tool` item below, so the
    // wrapper itself contributes no `user` item. Skip it to avoid leaking an
    // empty-content `user` item into the snapshot.
    const isWrapper =
      blocks.toolResults.length > 0 &&
      blocks.userBlocks.length === 0 &&
      blocks.toolUses.length === 0;
    if (!isWrapper) {
      items.push({
        historyItemId: uuid ?? `offset-${baseOffset}`,
        role: "user",
        contentBlocks: blocks.userBlocks,
        createdAt,
        sourceTranscriptOffset: baseOffset
      });
    }
    for (const tr of blocks.toolResults) {
      items.push({
        historyItemId: tr.toolUseId,
        role: "tool",
        contentBlocks: [
          { kind: "tool_result", toolUseId: tr.toolUseId, content: tr.content }
        ],
        createdAt,
        sourceTranscriptOffset: baseOffset
      });
    }
  } else if (obj.type === "assistant") {
    const uuid = asString((rec.json as { uuid?: unknown }).uuid);
    const msg = (rec.json as { message?: unknown }).message as
      | { content?: unknown }
      | undefined;
    const blocks = normalizeContent(msg?.content);
    items.push({
      historyItemId: uuid ?? `offset-${baseOffset}`,
      role: "assistant",
      contentBlocks: blocks.userBlocks,
      createdAt,
      sourceTranscriptOffset: baseOffset
    });
    for (const tu of blocks.toolUses) {
      items.push({
        historyItemId: tu.toolUseId,
        role: "assistant",
        contentBlocks: [
          {
            kind: "tool_use",
            toolUseId: tu.toolUseId,
            toolName: tu.toolName,
            input: tu.input
          }
        ],
        createdAt,
        sourceTranscriptOffset: baseOffset
      });
    }
  } else if (obj.type === "system") {
    // Real stored transcripts carry turn/system lifecycle as `system` records
    // with a `subtype` (turn_duration, api_error, compact_boundary, ...).
    // The subtype IS the signal, so it leads the note text; `content` (a
    // human-readable string on some subtypes, e.g. compact_boundary) is the
    // fallback when no subtype is present.
    const text =
      asString((rec.json as { subtype?: unknown }).subtype) ??
      asString((rec.json as { content?: unknown }).content) ??
      "";
    if (text) {
      items.push({
        historyItemId: `offset-${baseOffset}`,
        role: "system",
        contentBlocks: [{ kind: "system_note", text }],
        createdAt,
        sourceTranscriptOffset: baseOffset
      });
    }
  }
  return items;
}

interface NormalizedContent {
  userBlocks: ContentBlock[];
  toolUses: Array<{ toolUseId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolUseId: string; content: string }>;
}

function normalizeContent(content: unknown): NormalizedContent {
  const userBlocks: ContentBlock[] = [];
  const toolUses: NormalizedContent["toolUses"] = [];
  const toolResults: NormalizedContent["toolResults"] = [];
  if (!Array.isArray(content)) {
    if (typeof content === "string") {
      userBlocks.push({ kind: "text", text: content });
    }
    return { userBlocks, toolUses, toolResults };
  }
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as { type?: unknown };
    if (b.type === "text") {
      const text = asString((raw as { text?: unknown }).text) ?? "";
      userBlocks.push({ kind: "text", text });
    } else if (b.type === "tool_use") {
      const id = asString((raw as { id?: unknown }).id);
      const name = asString((raw as { name?: unknown }).name) ?? "";
      const input = (raw as { input?: unknown }).input;
      if (id) {
        toolUses.push({ toolUseId: id, toolName: name, input });
      }
    } else if (b.type === "tool_result") {
      const id = asString((raw as { tool_use_id?: unknown }).tool_use_id);
      const contentVal = (raw as { content?: unknown }).content;
      const text =
        typeof contentVal === "string"
          ? contentVal
          : Array.isArray(contentVal)
            ? contentVal
                .map((c) =>
                  c && typeof c === "object" && "text" in c
                    ? String((c as { text?: unknown }).text ?? "")
                    : ""
                )
                .join("")
            : "";
      if (id) {
        toolResults.push({ toolUseId: id, content: text });
      }
    }
  }
  return { userBlocks, toolUses, toolResults };
}

/**
 * A `user` record is a "tool_result wrapper" (part of an in-flight assistant
 * turn) iff its `message.content` is an array consisting solely of
 * `tool_result` blocks. Such records do not start a new turn and must not be
 * treated as the start of a new user message for evidence purposes.
 */
function isToolResultWrapper(json: unknown): boolean {
  const msg = (json as { message?: unknown }).message as
    | { content?: unknown }
    | undefined;
  if (!Array.isArray(msg?.content)) return false;
  for (const b of msg!.content as unknown[]) {
    if (
      !b ||
      typeof b !== "object" ||
      (b as { type?: unknown }).type !== "tool_result"
    ) {
      return false;
    }
  }
  return (msg!.content as unknown[]).length > 0;
}

/**
 * Canonical kind name for a parsed record: `"<type>"`, or `"<type>/<subtype>"`
 * when a string `subtype` is present (e.g. `system/turn_duration`).
 */
function recordKindOf(json: unknown): string {
  const obj = json as { type?: unknown; subtype?: unknown };
  const type = asString(obj.type) ?? "unknown";
  const subtype = asString(obj.subtype);
  return subtype ? `${type}/${subtype}` : type;
}

/**
 * Find the byte offset of the FIRST complete malformed line in `lines`, or
 * `null` if every complete line parses. Partial trailing lines do not count.
 */
function findFirstMalformed(lines: readonly ParsedLine[]): number | null {
  for (const line of lines) {
    if (!line.complete) continue;
    if (line.raw.trim().length === 0) continue;
    try {
      JSON.parse(line.raw);
    } catch {
      return line.byteOffset;
    }
  }
  return null;
}

/**
 * Read up to `byteLimit` bytes from `path` (or the whole file if byteLimit is
 * Infinity), trim to the last complete newline, and return the raw trimmed
 * buffer plus with metadata. NEVER reads beyond `byteLimit`.
 */
async function readTrimmed(
  path: string,
  byteLimit: number
): Promise<{
  bytes: Buffer;
  totalBytes: number;
  trailingPartialIgnored: boolean;
  byteEnd: number;
}> {
  const statRes = await stat(path);
  const totalBytes = statRes.size;
  // Read only what we need. If byteLimit >= totalBytes, read the whole file.
  const cap = byteLimit >= totalBytes ? totalBytes : Math.max(0, byteLimit);
  if (cap === 0) {
    return { bytes: Buffer.alloc(0), totalBytes, trailingPartialIgnored: false, byteEnd: 0 };
  }
  // Read cap bytes. We deliberately read exactly `cap` bytes (no over-read),
  // so we never touch bytes beyond `byteLimit`.
  const buf = await readFileRange(path, 0, cap);
  const trimmed = trimToLastNewline(buf, cap);
  return {
    bytes: trimmed.buffer,
    totalBytes,
    trailingPartialIgnored: trimmed.trailingPartialIgnored,
    byteEnd: trimmed.buffer.length
  };
}

async function readFileRange(path: string, start: number, end: number): Promise<Buffer> {
  // We use a manual handle so we never read past `end`.
  const { open } = await import("node:fs/promises");
  const fh = await open(path, "r");
  try {
    const len = Math.max(0, end - start);
    const buf = Buffer.alloc(len);
    if (len === 0) return buf;
    await fh.read(buf, 0, len, start);
    return buf;
  } finally {
    await fh.close();
  }
}

export const transcriptAdapter: TranscriptAdapter = {
  async readMetadata(path, byteLimit): Promise<TranscriptMetadata> {
    const { bytes, totalBytes, trailingPartialIgnored, byteEnd } = await readTrimmed(
      path,
      byteLimit
    );
    const lines = splitIntoLines(bytes);
    const firstMalformedOffset = findFirstMalformed(lines);
    // Title comes from the LAST `ai-title` record within the read window
    // (real field name is `aiTitle`, verified against real transcripts).
    let title: string | null = null;
    const kinds = new Set<string>();
    for (const line of lines) {
      const parsed = tryParse(line);
      if (!parsed) continue;
      kinds.add(recordKindOf(parsed.json));
      const obj = parsed.json as { type?: unknown; aiTitle?: unknown };
      if (obj.type === "ai-title") {
        const t = asString(obj.aiTitle);
        if (t !== undefined) title = t;
      }
    }
    return {
      byteEnd,
      totalBytes,
      trailingPartialIgnored,
      allLinesParseable: firstMalformedOffset === null,
      firstMalformedOffset,
      title,
      recordKinds: [...kinds].sort()
    };
  },

  async readSnapshot(path, byteLimit): Promise<HistoryItem[]> {
    const { bytes } = await readTrimmed(path, byteLimit);
    const lines = splitIntoLines(bytes);
    const items: HistoryItem[] = [];
    for (const line of lines) {
      const parsed = tryParse(line);
      if (!parsed) continue;
      items.push(...toHistoryItems(parsed));
    }
    return items;
  },

  async findTurnEvidence(path, userUuid): Promise<TurnEvidence> {
    // Read the whole file for evidence resolution. The byte-limit boundary
    // matters for snapshot materialization; evidence resolution looks at the
    // complete file because a user message can only be reconciled once the
    // full transcript is available.
    const { bytes } = await readTrimmed(path, Number.MAX_SAFE_INTEGER);
    const lines = splitIntoLines(bytes);
    // 1. Incompatible check: scan every complete line for malformed JSON.
    const malformed = findFirstMalformed(lines);
    if (malformed !== null) {
      return {
        kind: "incompatible",
        reason: `malformed JSON at byte offset ${malformed}`
      };
    }
    // 2. Find the position of the target user UUID.
    let userFoundAt = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.complete) continue;
      const parsed = tryParse(line);
      if (!parsed) continue;
      const obj = parsed.json as { type?: unknown; uuid?: unknown };
      if (obj.type === "user" && asString(obj.uuid) === userUuid) {
        userFoundAt = i;
        break;
      }
    }
    if (userFoundAt === -1) {
      return { kind: "absent" };
    }
    // 3. Walk forward from the user record resolving REAL turn signals.
    //    Stored transcripts have no `result` records; a turn's health is
    //    evidenced by:
    //      * `assistant` records        — the model responded
    //      * `system/turn_duration`     — the turn ended normally (its
    //                                     parentUuid is the turn's last
    //                                     assistant record); TERMINATES the
    //                                     turn scan
    //      * `system/api_error`         — an API failure inside the turn
    //      * next top-level `user`      — a new user message bounds the
    //        (non-wrapper) record         previous turn; TERMINATES the scan
    //    Records with `isSidechain === true` are ignored entirely, and
    //    bookkeeping records (queue-operation, last-prompt, permission-mode,
    //    attachment, file-history-snapshot, ai-title, agent-name, pr-link)
    //    are transparent — they never bound a turn nor count as responses.
    let sawAssistant = false;
    let sawApiError = false;
    let endedNormally = false;
    for (let j = userFoundAt + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (!line.complete) continue;
      const parsed = tryParse(line);
      if (!parsed) continue;
      const obj = parsed.json as {
        type?: unknown;
        subtype?: unknown;
        isSidechain?: unknown;
      };
      if (obj.isSidechain === true) continue;
      if (obj.type === "assistant") {
        sawAssistant = true;
      } else if (obj.type === "system") {
        const subtype = asString(obj.subtype);
        if (subtype === "turn_duration") {
          endedNormally = true;
          break;
        }
        if (subtype === "api_error") {
          sawApiError = true;
        }
        // Other system subtypes (away_summary, stop_hook_summary,
        // compact_boundary, ...) are transparent for boundaries.
      } else if (obj.type === "user" && !isToolResultWrapper(parsed.json)) {
        // A genuine new user turn bounds the previous turn.
        endedNormally = true;
        break;
      }
    }
    // Precedence: an API error inside the turn wins; otherwise the turn is
    // completed only when the model responded AND a boundary evidences a
    // normal end. An assistant record followed by end-of-file with NO
    // boundary evidence cannot be proven to have completed normally, so it
    // falls back to `interrupted`.
    if (sawApiError) {
      return { kind: "complete", outcome: "failed" };
    }
    if (sawAssistant && endedNormally) {
      return { kind: "complete", outcome: "completed" };
    }
    return { kind: "interrupted" };
  }
};

/** Exported for tests that want to compute expected offsets. */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Exported for tests that want to reuse the line splitter. */
export function _splitIntoLinesForTest(bytes: Buffer): ParsedLine[] {
  return splitIntoLines(bytes);
}

export type { HistoryRole };
