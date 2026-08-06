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
 * reconciliation contract from the design spec §7.4.
 *
 *   * `complete` + `completed` — the UUID exists and a terminal success
 *     `result` record follows it in the same transcript.
 *   * `complete` + `failed` — the UUID exists and a terminal failure
 *     `result` record follows it.
 *   * `interrupted` — the UUID exists but no terminal `result` follows it.
 *   * `absent` — the UUID is not present as a complete `user` record.
 *   * `incompatible` — at least one COMPLETE line in the transcript is not
 *     valid JSON. Partial trailing lines never count as incompatible.
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
