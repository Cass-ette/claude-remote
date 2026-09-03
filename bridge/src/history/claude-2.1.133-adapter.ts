/**
 * Production read-only History Adapter for Claude Code 2.1.133 stored
 * transcripts (spec §6.7).
 *
 * This is a port of the Phase 0 gate-passed probe adapter
 * (probes/transcript/src/adapter.ts, verified at commit f343f7e against
 * real stored transcripts). The turn-evidence classification is kept
 * byte-identical to the gate-passed logic; only production hardening was
 * added:
 *
 *   * every read validates that the transcript path stays inside the bound
 *     project's transcript directory (`<claudeConfigDir>/projects/<encoded>/`)
 *     — a path escaping it is rejected before any file access;
 *   * missing files surface as {@link TranscriptNotFoundError};
 *   * byteLimit <= 0 / NaN surfaces as {@link InvalidByteLimitError};
 *   * byteLimit above the file size is clamped to the file size.
 *
 * Invariants inherited from the probe:
 *   * NEVER writes, repairs, or truncates a transcript.
 *   * reads only bytes `[0, byteLimit)` and trims to the last complete `\n`.
 *   * trailing partial lines are ignored, never reported incompatible.
 *   * `incompatible` is reported ONLY when a complete line fails JSON.parse.
 *   * all offsets are UTF-8 byte offsets.
 *
 * Real-contract knowledge (from the Phase 0 gate):
 *   * stored transcripts have NO `result` records — turn termination is
 *     evidenced by `system/turn_duration` (or the next top-level user
 *     record); failure by `system/api_error` inside the turn;
 *   * sidechain records (`isSidechain === true`) only occur in subagents/
 *     files and are ignored for boundary resolution;
 *   * `ai-title` records carry `aiTitle` (last one wins).
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Bumped when parsing/normalization behavior changes, breaking revisions. */
export const ADAPTER_VERSION = "claude-transcript-adapter/2.1.133";

// ---------------------------------------------------------------------------
// Types (ported from probes/transcript/src/types.ts)
// ---------------------------------------------------------------------------

export type HistoryRole = "user" | "assistant" | "tool" | "system";

export interface HistoryItem {
  readonly historyItemId: string;
  readonly role: HistoryRole;
  readonly contentBlocks: ReadonlyArray<ContentBlock>;
  readonly createdAt: string;
  readonly sourceTranscriptOffset: number;
}

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; toolUseId: string; toolName: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string }
  | { kind: "system_note"; text: string };

/**
 * Per-turn evidence for a user-message UUID (§6.7 / §7.4), classified
 * against the REAL stored-transcript vocabulary. See the module docstring
 * for the real turn signals.
 */
export type TurnEvidence =
  | { kind: "complete"; outcome: "completed" | "failed" }
  | { kind: "interrupted" }
  | { kind: "absent" }
  | { kind: "incompatible"; reason: string };

export interface TranscriptMetadata {
  /** UTF-8 byte offset that the read stopped at (exclusive). */
  readonly byteEnd: number;
  /** Total size of the file in bytes at read time. */
  readonly totalBytes: number;
  readonly trailingPartialIgnored: boolean;
  readonly allLinesParseable: boolean;
  readonly firstMalformedOffset: number | null;
  /** LAST `ai-title` record's `aiTitle` within the read window, or null. */
  readonly title: string | null;
  /** Sorted `"<type>"` / `"<type>/<subtype>"` kinds seen in the window. */
  readonly recordKinds: readonly string[];
}

/** Result of a byte-boundaried snapshot read. */
export interface SnapshotRead {
  /** Materialized history items from complete records only. */
  readonly items: readonly HistoryItem[];
  /** The trimmed bytes actually read (complete records only) — feeds historyRevision. */
  readonly bytes: Buffer;
  /** UTF-8 byte offset the read stopped at (== bytes.length). */
  readonly byteEnd: number;
}

// ---------------------------------------------------------------------------
// Production typed errors
// ---------------------------------------------------------------------------

/** Transcript path escapes the bound project's transcript directory. */
export class TranscriptPathOutsideProjectError extends Error {
  readonly code = "TRANSCRIPT_PATH_OUTSIDE_PROJECT";
  constructor(readonly transcriptPath: string, readonly transcriptDir: string) {
    super(
      `transcript ${transcriptPath} is not under the bound project's transcript directory ${transcriptDir}`,
    );
    this.name = "TranscriptPathOutsideProjectError";
  }
}

/** Transcript file does not exist (or is not a regular file). */
export class TranscriptNotFoundError extends Error {
  readonly code = "TRANSCRIPT_NOT_FOUND";
  constructor(readonly transcriptPath: string) {
    super(`transcript not found: ${transcriptPath}`);
    this.name = "TranscriptNotFoundError";
  }
}

/** byteLimit was not a positive integer. */
export class InvalidByteLimitError extends Error {
  readonly code = "INVALID_BYTE_LIMIT";
  constructor(readonly byteLimit: number) {
    super(`byteLimit must be a positive finite integer; got ${byteLimit}`);
    this.name = "InvalidByteLimitError";
  }
}

// ---------------------------------------------------------------------------
// Project ↔ transcript-directory mapping. Verified against every real
// project dir on this machine (24 cwd→dir pairs, zero mismatches): Claude
// Code encodes EVERY character outside [a-zA-Z0-9-] as "-", not just "/" —
// e.g. "apt- refactor" → "apt--refactor", "devmac++" → "devmac--",
// "BlueLotus_XSSReceiver" → "BlueLotus-XSSReceiver".
// ---------------------------------------------------------------------------

/** Encode a canonical project path to its Claude transcript directory name. */
export function encodeProjectPath(projectRoot: string): string {
  return projectRoot.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** Transcript directory holding a project's `<session-uuid>.jsonl` files. */
export function transcriptDirForProject(claudeConfigDir: string, projectRoot: string): string {
  return resolve(claudeConfigDir, "projects", encodeProjectPath(projectRoot));
}

/** Transcript file path for one session of a project. */
export function transcriptPathForSession(
  claudeConfigDir: string,
  projectRoot: string,
  sessionId: string,
): string {
  return join(transcriptDirForProject(claudeConfigDir, projectRoot), `${sessionId}.jsonl`);
}

/**
 * historyRevision (spec §6.7): SHA-256 over the adapter version, the
 * canonical transcript path, the byte boundary, and the complete bytes
 * actually read. Field separator `\n` cannot occur at the end of a
 * preceding field's contribution ambiguously because the boundary is
 * encoded as a decimal string followed by `\n` before the raw bytes.
 */
export function computeHistoryRevision(
  adapterVersion: string,
  transcriptPath: string,
  readByteLimit: number,
  bytesRead: Buffer,
): string {
  const h = createHash("sha256");
  h.update(adapterVersion, "utf8");
  h.update("\n");
  h.update(transcriptPath, "utf8");
  h.update("\n");
  h.update(String(readByteLimit), "utf8");
  h.update("\n");
  h.update(bytesRead);
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ClaudeTranscriptAdapter {
  readonly adapterVersion: string;
  readMetadata(transcriptPath: string, byteLimit: number): Promise<TranscriptMetadata>;
  readSnapshot(transcriptPath: string, byteLimit: number): Promise<SnapshotRead>;
  findTurnEvidence(transcriptPath: string, userUuid: string): Promise<TurnEvidence>;
}

export interface ClaudeTranscriptAdapterOptions {
  /** Canonical (realpath-resolved) root of the bound project. */
  readonly projectRoot: string;
  /** Claude config directory (`~/.claude` or CLAUDE_CONFIG_DIR). */
  readonly claudeConfigDir: string;
}

export function createClaudeTranscriptAdapter(
  options: ClaudeTranscriptAdapterOptions,
): ClaudeTranscriptAdapter {
  if (!isAbsolute(options.projectRoot)) {
    throw new Error(`projectRoot must be absolute; got ${options.projectRoot}`);
  }
  const transcriptDir = resolve(transcriptDirForProject(options.claudeConfigDir, options.projectRoot));

  return {
    adapterVersion: ADAPTER_VERSION,

    async readMetadata(transcriptPath, byteLimit): Promise<TranscriptMetadata> {
      const { bytes, totalBytes, trailingPartialIgnored, byteEnd } = await readTrimmed(
        transcriptPath,
        byteLimit,
      );
      const lines = splitIntoLines(bytes);
      const firstMalformedOffset = findFirstMalformed(lines);
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
        recordKinds: [...kinds].sort(),
      };
    },

    async readSnapshot(transcriptPath, byteLimit): Promise<SnapshotRead> {
      const { bytes, byteEnd } = await readTrimmed(transcriptPath, byteLimit);
      const lines = splitIntoLines(bytes);
      const items: HistoryItem[] = [];
      for (const line of lines) {
        const parsed = tryParse(line);
        if (!parsed) continue;
        items.push(...toHistoryItems(parsed));
      }
      return { items, bytes, byteEnd };
    },

    async findTurnEvidence(transcriptPath, userUuid): Promise<TurnEvidence> {
      // Evidence resolution reads the complete file: a user message can only
      // be reconciled once the full transcript is available.
      const { bytes } = await readTrimmed(transcriptPath, Number.MAX_SAFE_INTEGER);
      const lines = splitIntoLines(bytes);
      const malformed = findFirstMalformed(lines);
      if (malformed !== null) {
        return { kind: "incompatible", reason: `malformed JSON at byte offset ${malformed}` };
      }
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
      let sawAssistant = false;
      let sawApiError = false;
      let endedNormally = false;
      for (let j = userFoundAt + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (!line.complete) continue;
        const parsed = tryParse(line);
        if (!parsed) continue;
        const obj = parsed.json as { type?: unknown; subtype?: unknown; isSidechain?: unknown };
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
        } else if (obj.type === "user" && !isToolResultWrapper(parsed.json)) {
          endedNormally = true;
          break;
        }
      }
      if (sawApiError) return { kind: "complete", outcome: "failed" };
      if (sawAssistant && endedNormally) return { kind: "complete", outcome: "completed" };
      return { kind: "interrupted" };
    },
  };

  // -------------------------------------------------------------------------
  // Shared read plumbing
  // -------------------------------------------------------------------------

  function validateByteLimit(byteLimit: number): void {
    if (!Number.isFinite(byteLimit) || byteLimit <= 0 || !Number.isInteger(byteLimit)) {
      throw new InvalidByteLimitError(byteLimit);
    }
  }

  /**
   * Containment check: the resolved transcript path must be strictly inside
   * the bound project's transcript directory. Checked lexically on resolved
   * paths, and — when both exist — on OS-realpath forms so symlinked
   * locations (e.g. macOS /var → /private/var) cannot smuggle a path in or
   * out.
   */
  function assertInsideProject(transcriptPath: string): void {
    const resolved = resolve(transcriptPath);
    if (resolved === transcriptDir || !resolved.startsWith(transcriptDir + sep)) {
      throw new TranscriptPathOutsideProjectError(resolved, transcriptDir);
    }
    let realDir: string;
    try {
      realDir = realpathSync.native(transcriptDir);
    } catch {
      // Directory itself missing: no transcript can exist under it; the
      // subsequent stat will surface TranscriptNotFoundError.
      return;
    }
    let realPath: string;
    try {
      realPath = realpathSync.native(resolved);
    } catch {
      // Missing file: surfaced as TranscriptNotFoundError by the caller.
      return;
    }
    if (realPath === realDir || !realPath.startsWith(realDir + sep)) {
      throw new TranscriptPathOutsideProjectError(realPath, realDir);
    }
  }

  async function readTrimmed(
    path: string,
    byteLimit: number,
  ): Promise<{
    bytes: Buffer;
    totalBytes: number;
    trailingPartialIgnored: boolean;
    byteEnd: number;
  }> {
    validateByteLimit(byteLimit);
    assertInsideProject(path);
    let statRes;
    try {
      statRes = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TranscriptNotFoundError(path);
      }
      throw error;
    }
    if (!statRes.isFile()) {
      throw new TranscriptNotFoundError(path);
    }
    const totalBytes = statRes.size;
    const cap = byteLimit >= totalBytes ? totalBytes : byteLimit;
    if (cap === 0) {
      return { bytes: Buffer.alloc(0), totalBytes, trailingPartialIgnored: false, byteEnd: 0 };
    }
    const buf = await readFileRange(path, 0, cap);
    const trimmed = trimToLastNewline(buf, cap);
    return {
      bytes: trimmed.buffer,
      totalBytes,
      trailingPartialIgnored: trimmed.trailingPartialIgnored,
      byteEnd: trimmed.buffer.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Ported parsing helpers (byte-identical to the probe)
// ---------------------------------------------------------------------------

interface ParsedLine {
  byteOffset: number;
  byteLength: number;
  raw: string;
  complete: boolean;
}

function splitIntoLines(bytes: Buffer): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      const raw = bytes.subarray(lineStart, i).toString("utf8");
      const byteLength = i - lineStart + 1;
      lines.push({ byteOffset: lineStart, byteLength, raw, complete: true });
      lineStart = i + 1;
    }
  }
  if (lineStart < bytes.length) {
    const raw = bytes.subarray(lineStart).toString("utf8");
    lines.push({
      byteOffset: lineStart,
      byteLength: bytes.length - lineStart,
      raw,
      complete: false,
    });
  }
  return lines;
}

function trimToLastNewline(
  bytes: Buffer,
  byteLimit: number,
): { buffer: Buffer; trailingPartialIgnored: boolean; partialBytes: number } {
  const cap = Math.min(byteLimit, bytes.length);
  if (cap === 0) {
    return { buffer: Buffer.alloc(0), trailingPartialIgnored: false, partialBytes: 0 };
  }
  let lastNewline = -1;
  for (let i = cap - 1; i >= 0; i--) {
    if (bytes[i] === 0x0a) {
      lastNewline = i;
      break;
    }
  }
  if (lastNewline === cap - 1) {
    return { buffer: bytes.subarray(0, cap), trailingPartialIgnored: false, partialBytes: 0 };
  }
  if (lastNewline === -1) {
    return {
      buffer: Buffer.alloc(0),
      trailingPartialIgnored: cap > 0,
      partialBytes: cap,
    };
  }
  return {
    buffer: bytes.subarray(0, lastNewline + 1),
    trailingPartialIgnored: true,
    partialBytes: cap - (lastNewline + 1),
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

function toHistoryItems(rec: ParsedRecord): HistoryItem[] {
  const obj = rec.json as { type?: unknown };
  const items: HistoryItem[] = [];
  const baseOffset = rec.line.byteOffset;
  const createdAt = asString((rec.json as { timestamp?: unknown }).timestamp) ?? "";
  if (obj.type === "user") {
    const uuid = asString((rec.json as { uuid?: unknown }).uuid);
    const msg = (rec.json as { message?: unknown }).message as { content?: unknown } | undefined;
    const blocks = normalizeContent(msg?.content);
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
        sourceTranscriptOffset: baseOffset,
      });
    }
    for (const tr of blocks.toolResults) {
      items.push({
        historyItemId: tr.toolUseId,
        role: "tool",
        contentBlocks: [{ kind: "tool_result", toolUseId: tr.toolUseId, content: tr.content }],
        createdAt,
        sourceTranscriptOffset: baseOffset,
      });
    }
  } else if (obj.type === "assistant") {
    const uuid = asString((rec.json as { uuid?: unknown }).uuid);
    const msg = (rec.json as { message?: unknown }).message as { content?: unknown } | undefined;
    const blocks = normalizeContent(msg?.content);
    items.push({
      historyItemId: uuid ?? `offset-${baseOffset}`,
      role: "assistant",
      contentBlocks: blocks.userBlocks,
      createdAt,
      sourceTranscriptOffset: baseOffset,
    });
    for (const tu of blocks.toolUses) {
      items.push({
        historyItemId: tu.toolUseId,
        role: "assistant",
        contentBlocks: [
          { kind: "tool_use", toolUseId: tu.toolUseId, toolName: tu.toolName, input: tu.input },
        ],
        createdAt,
        sourceTranscriptOffset: baseOffset,
      });
    }
  } else if (obj.type === "system") {
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
        sourceTranscriptOffset: baseOffset,
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
                    : "",
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

function isToolResultWrapper(json: unknown): boolean {
  const msg = (json as { message?: unknown }).message as { content?: unknown } | undefined;
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

function recordKindOf(json: unknown): string {
  const obj = json as { type?: unknown; subtype?: unknown };
  const type = asString(obj.type) ?? "unknown";
  const subtype = asString(obj.subtype);
  return subtype ? `${type}/${subtype}` : type;
}

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

async function readFileRange(path: string, start: number, end: number): Promise<Buffer> {
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
