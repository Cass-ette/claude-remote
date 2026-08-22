/**
 * Shared types for the event journal (Task 10 implements the real journal).
 *
 * Task 9 (command ledger) only needs the *contract*: the ability to append a
 * pending event while sharing a transaction with other writes (commands row
 * update, sessions.lastEventId increment). The port below is intentionally
 * minimal; it must be called while an explicit transaction is open on `db`.
 */
import type { SqliteDatabase } from "../db/database.js";
import type { EventPayload, EventType, PROTOCOL_VERSION } from "../protocol/v1/types.js";

/** Minimal persisted-event shape for Task 9; Task 10 may extend it. */
export interface PersistedEvent {
  readonly sessionId: string;
  readonly eventId: bigint;
  readonly eventType: EventType;
  readonly payloadJson: string;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly createdAt: number;
}

export interface AppendEventArgs {
  readonly db: SqliteDatabase;
  readonly sessionId: string;
  readonly eventType: EventType;
  readonly payload: EventPayload;
  readonly now: number;
}

/**
 * Appends an event to `pending_events`, allocating a monotonically increasing
 * `eventId` per session and bumping `sessions.lastEventId`.
 *
 * Contract:
 * - MUST be called inside an open transaction on `db` (the caller owns the
 *   transaction so the append composes atomically with other writes).
 * - MUST insert the `pending_events` row and update `sessions.lastEventId`
 *   on the same connection, so a rollback of the surrounding transaction
 *   undoes both.
 */
export interface EventJournalPort {
  appendWithinTransaction(args: AppendEventArgs): PersistedEvent;
}
