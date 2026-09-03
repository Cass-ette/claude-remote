// Pure read-only History Adapter for Claude transcripts.
//
// This module NEVER writes to, repairs, or truncates a transcript file. Every
// operation is a read that materializes history items, computes evidence for a
// given user-message UUID, or returns metadata about byte boundaries.
//
// All offsets and byte boundaries are UTF-8 byte offsets, not character
// indices — Claude transcripts are UTF-8 encoded and may contain multibyte
// characters. Callers compute expected offsets with `Buffer.byteLength`.

/** Role of a transcript record. */
export type HistoryRole = "user" | "assistant" | "tool" | "system";

/**
 * A single normalized history item produced from a Claude transcript record.
 *
 * `sourceTranscriptOffset` is the UTF-8 byte offset of the FIRST byte of the
 * record (i.e. the start of its line, inclusive of the trailing newline that
 * terminates the previous record). It is stable for an immutable snapshot: a
 * later snapshot taken at the same byte limit will produce items with the same
 * offsets.
 */
export interface HistoryItem {
  historyItemId: string;
  role: HistoryRole;
  contentBlocks: ReadonlyArray<ContentBlock>;
  createdAt: string;
  sourceTranscriptOffset: number;
}

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; toolUseId: string; toolName: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string }
  | { kind: "system_note"; text: string };

/**
 * Per-turn evidence, keyed by a user-message UUID. Implements the
 * reconciliation contract from the design spec §7.4, against the REAL stored
 * transcript vocabulary (Claude Code 2.1.133 `.jsonl` session files contain
 * NO `result` records — those exist only in `--output-format stream-json`
 * stdout).
 *
 * Real turn signals, verified against 20+ real stored transcripts:
 *   * a turn that ran normally ends with a `system` record with
 *     `subtype:"turn_duration"` (its `parentUuid` points at the turn's last
 *     `assistant` record);
 *   * an API failure surfaces as a `system` record with `subtype:"api_error"`
 *     between the user message and the turn's boundary;
 *   * a NEW top-level `user` record (not a tool-result wrapper) bounds the
 *     previous turn even when no `turn_duration` was written.
 *
 *   * `complete` + `completed` — the UUID exists, at least one top-level
 *     `assistant` record follows it, and the turn ends normally (a
 *     `system/turn_duration` record or the next top-level user record).
 *   * `complete` + `failed` — the UUID exists and a `system/api_error`
 *     record appears between it and the turn's boundary.
 *   * `interrupted` — the UUID exists but NO top-level `assistant` record
 *     follows it (the next top-level record is another user record, or the
 *     file ends), or an assistant responded but the file ends with no
 *     boundary evidence (`turn_duration` or next user) proving a normal end.
 *   * `absent` — the UUID is not present as a complete `user` record.
 *   * `incompatible` — at least one COMPLETE line in the transcript is not
 *     valid JSON. Partial trailing lines never count as incompatible.
 *
 * Records with `isSidechain === true` are ignored entirely when resolving
 * boundaries. Bookkeeping records (`queue-operation`, `last-prompt`,
 * `permission-mode`, `attachment`, `file-history-snapshot`, `ai-title`,
 * `agent-name`, `pr-link`) are ignored for evidence.
 */
export type TurnEvidence =
  | { kind: "complete"; outcome: "completed" | "failed" }
  | { kind: "interrupted" }
  | { kind: "absent" }
  | { kind: "incompatible"; reason: string };

/** Stable metadata about an immutable byte-boundaried read of a transcript. */
export interface TranscriptMetadata {
  /** UTF-8 byte offset that the read stopped at (exclusive). */
  readonly byteEnd: number;
  /** Total size of the file in bytes at read time. */
  readonly totalBytes: number;
  /** True iff a trailing partial (no-newline-terminated) line was ignored. */
  readonly trailingPartialIgnored: boolean;
  /** True iff every complete line parsed as valid JSON. */
  readonly allLinesParseable: boolean;
  /** First malformed line offset, when `allLinesParseable === false`. */
  readonly firstMalformedOffset: number | null;
  /**
   * Session title from the LAST `ai-title` record within the read window
   * (field name `aiTitle`, verified against real transcripts), or `null`
   * when no `ai-title` record is present. Claude Code rewrites the title as
   * a session evolves, so the last one is the current title.
   */
  readonly title: string | null;
  /**
   * Sorted set of observed record kinds within the read window. Each kind is
   * `"<type>"` or `"<type>/<subtype>"` (e.g. `"user"`, `"system/turn_duration"`).
   * Sorted lexicographically for deterministic comparison.
   */
  readonly recordKinds: readonly string[];
}

/**
 * Pure read-only adapter. Implementations must NOT write, repair, or
 * truncate transcripts.
 */
export interface TranscriptAdapter {
  /** Read metadata about the whole file without materializing items. */
  readMetadata(path: string, byteLimit: number): Promise<TranscriptMetadata>;
  /** Read complete records up to and including the last newline at or before `byteLimit`. */
  readSnapshot(path: string, byteLimit: number): Promise<HistoryItem[]>;
  /** Resolve the evidence state for one user-message UUID. */
  findTurnEvidence(path: string, userUuid: string): Promise<TurnEvidence>;
}
