/**
 * Durable event journal (Task 10).
 *
 * Delivery guarantees (spec §8.5):
 * - Every event is persisted BEFORE it is sent; eventId allocation
 *   (sessions.lastEventId) and the pending_events insert happen in the same
 *   transaction, so a crash can never emit an event that was not journaled.
 * - ACKs never delete immediately: they schedule deletion at
 *   `now + retentionMs`, and an actual sweep (run on every append and at
 *   Bridge start) performs the delete. This keeps redelivery possible for a
 *   grace window after an ACK that was lost in flight.
 *
 * The API is synchronous by design: better-sqlite3 is synchronous, so fake
 * Promises would only obscure error semantics.
 */
import { transaction } from "../db/database.js";
import type { SqliteDatabase } from "../db/database.js";
import { PROTOCOL_VERSION, type EventType } from "../protocol/v1/types.js";
import type { AppendEventArgs, EventJournalPort, PersistedEvent } from "./event-journal-types.js";

export type { AppendEventArgs, PersistedEvent } from "./event-journal-types.js";

/** Event classification driving storage-pressure policy. */
export type EventCategory = "user_command" | "system";

export interface AppendOptions {
  readonly category: EventCategory;
  readonly sessionId: string;
  readonly eventType: EventType;
  readonly payload: unknown;
  /** Epoch milliseconds. */
  readonly now: number;
}

export interface EventJournalConfig {
  /** Retention delay (ms) applied when an event is ACKed / superseded. */
  readonly retentionMs: number;
  /** Byte budget for the total size of pending payloadJson rows. */
  readonly byteBudget: number;
}

/** Thrown when a user_command append would exceed the pending byte budget. */
export class StoragePressureError extends Error {
  constructor(pendingBytes: number, budget: number) {
    super(
      `STORAGE_PRESSURE: pending events occupy ${pendingBytes} bytes, at or above the ` +
        `${budget}-byte budget; user_command events are rejected until the consumer ACKs.`,
    );
    this.name = "StoragePressureError";
  }
}

/** Thrown when an ACK arrives for an eventId below the device watermark. */
export class BackwardAckError extends Error {
  constructor(deviceId: string, sessionId: string, eventId: bigint, watermark: number) {
    super(
      `Backward ACK: device ${deviceId} acknowledged ${sessionId} event ${eventId}, below the ` +
        `current delivery watermark ${watermark}.`,
    );
    this.name = "BackwardAckError";
  }
}

export interface EventJournal extends EventJournalPort {
  append(opts: AppendOptions): PersistedEvent;
  replayAfter(sessionId: string, eventId: bigint): PersistedEvent[];
  acknowledge(sessionId: string, deviceId: string, eventId: bigint, now: number): void;
  markCheckpointSuperseded(sessionId: string, deviceId: string, watermark: bigint, now: number): void;
  pendingBytes(): number;
  sweep(now: number): void;
}

interface PendingRow {
  readonly sessionId: string;
  readonly eventId: number;
  readonly eventType: string;
  readonly payloadJson: string;
  readonly protocolVersion: string;
  readonly createdAt: number;
}

interface DeliveryRow {
  readonly deviceId: string;
  readonly sessionId: string;
  readonly protocolVersion: string;
  readonly deliveryBase: number;
  readonly deliveryWatermark: number;
}

export function createEventJournal(db: SqliteDatabase, config: EventJournalConfig): EventJournal {
  const insertPending = db.prepare(
    `INSERT INTO pending_events (sessionId, eventId, eventType, payloadJson, protocolVersion, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectLastEventId = db.prepare("SELECT lastEventId FROM sessions WHERE sessionId = ?");
  const bumpLastEventId = db.prepare("UPDATE sessions SET lastEventId = ? WHERE sessionId = ?");
  const selectPendingAfter = db.prepare(
    `SELECT sessionId, eventId, eventType, payloadJson, protocolVersion, createdAt
     FROM pending_events WHERE sessionId = ? AND eventId > ? ORDER BY eventId ASC`,
  );
  const pendingBytesStmt = db.prepare("SELECT COALESCE(SUM(LENGTH(payloadJson)), 0) AS bytes FROM pending_events");
  const scheduleDeletion = db.prepare(
    "UPDATE pending_events SET deleteAfter = ? WHERE sessionId = ? AND eventId <= ? AND deleteAfter IS NULL",
  );
  const sweepStmt = db.prepare("DELETE FROM pending_events WHERE deleteAfter IS NOT NULL AND deleteAfter <= ?");
  const selectDelivery = db.prepare(
    "SELECT deviceId, sessionId, protocolVersion, deliveryBase, deliveryWatermark FROM device_delivery WHERE deviceId = ? AND sessionId = ?",
  );
  const insertDelivery = db.prepare(
    `INSERT INTO device_delivery (deviceId, sessionId, protocolVersion, deliveryBase, deliveryWatermark)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const advanceWatermark = db.prepare(
    "UPDATE device_delivery SET deliveryWatermark = MAX(deliveryWatermark, ?) WHERE deviceId = ? AND sessionId = ?",
  );

  function currentPendingBytes(): number {
    return (pendingBytesStmt.get() as { bytes: number }).bytes;
  }

  function toPersisted(row: PendingRow): PersistedEvent {
    return {
      sessionId: row.sessionId,
      eventId: BigInt(row.eventId),
      eventType: row.eventType as EventType,
      payloadJson: row.payloadJson,
      protocolVersion: row.protocolVersion as typeof PROTOCOL_VERSION,
      createdAt: row.createdAt,
    };
  }

  return {
    /**
     * Append on the journal's own transaction: allocates the eventId, bumps
     * sessions.lastEventId, inserts pending_events, and (for standalone
     * appends) runs the retention sweep first. Checks the pending byte
     * budget for user_command events BEFORE any allocation.
     */
    append({ category, sessionId, eventType, payload, now }): PersistedEvent {
      if (category === "user_command") {
        const projected = currentPendingBytes() + Buffer.byteLength(JSON.stringify(payload), "utf8");
        if (projected > config.byteBudget) {
          throw new StoragePressureError(projected, config.byteBudget);
        }
      }
      this.sweep(now);
      return transaction(db, () =>
        this.appendWithinTransaction({ db, sessionId, eventType, payload: payload as never, now }),
      );
    },

    /** Port implementation (Task 9 contract): the caller owns the transaction. */
    appendWithinTransaction({ db: txDb, sessionId, eventType, payload, now }: AppendEventArgs): PersistedEvent {
      const session = selectLastEventId.get(sessionId) as { lastEventId: number } | undefined;
      if (session === undefined) {
        throw new Error(`appendWithinTransaction: unknown session ${sessionId}`);
      }
      const eventId = session.lastEventId + 1;
      bumpLastEventId.run(eventId, sessionId);
      // Persisted payload is the full event envelope (spec §8.4) with the
      // eventId as a decimal STRING (JSON has no uint64).
      const payloadJson = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        eventId: String(eventId),
        sessionId,
        eventType,
        timestamp: new Date(now).toISOString(),
        payload,
      });
      insertPending.run(sessionId, eventId, eventType, payloadJson, PROTOCOL_VERSION, now);
      void txDb; // same connection; kept for contract clarity
      return {
        sessionId,
        eventId: BigInt(eventId),
        eventType,
        payloadJson,
        protocolVersion: PROTOCOL_VERSION,
        createdAt: now,
      };
    },

    replayAfter(sessionId: string, eventId: bigint): PersistedEvent[] {
      const rows = selectPendingAfter.all(sessionId, Number(eventId)) as PendingRow[];
      return rows.map(toPersisted);
    },

    acknowledge(sessionId, deviceId, eventId, now): void {
      const existing = selectDelivery.get(deviceId, sessionId) as DeliveryRow | undefined;
      if (existing === undefined) {
        insertDelivery.run(deviceId, sessionId, PROTOCOL_VERSION, 0, Number(eventId));
      } else if (Number(eventId) < existing.deliveryWatermark) {
        throw new BackwardAckError(deviceId, sessionId, eventId, existing.deliveryWatermark);
      } else {
        advanceWatermark.run(Number(eventId), deviceId, sessionId);
      }
      scheduleDeletion.run(now + config.retentionMs, sessionId, Number(eventId));
    },

    markCheckpointSuperseded(sessionId, deviceId, watermark, now): void {
      const existing = selectDelivery.get(deviceId, sessionId) as DeliveryRow | undefined;
      if (existing === undefined) {
        insertDelivery.run(deviceId, sessionId, PROTOCOL_VERSION, 0, Number(watermark));
      } else {
        advanceWatermark.run(Number(watermark), deviceId, sessionId);
      }
      scheduleDeletion.run(now + config.retentionMs, sessionId, Number(watermark));
    },

    pendingBytes(): number {
      return currentPendingBytes();
    },

    sweep(now): void {
      sweepStmt.run(now);
    },
  };
}

/**
 * Replace an oversized `tool.output.delta` payload with a truncation marker.
 * Pure helper: the stream adapter (Chunk 3) applies it before appending.
 * Non-oversized payloads (and by policy any non-tool-output event) pass
 * through unchanged.
 */
export function truncateLargeToolOutput(
  payload: unknown,
  limit: number,
  eventType?: EventType,
): { payload: unknown; truncated: boolean } {
  if (eventType !== undefined && eventType !== "tool.output.delta") {
    return { payload, truncated: false };
  }
  const byteLength = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (byteLength <= limit) return { payload, truncated: false };
  return {
    payload: { truncated: true, originalByteCount: byteLength, truncatedAt: "65KiB" },
    truncated: true,
  };
}
