/**
 * Two-phase resync snapshot service (spec §6.7).
 *
 * `session.snapshot.begin` creates an immutable `prepared` checkpoint:
 *
 *  1. the stale sweep runs first;
 *  2. the per-session resync mutex is taken — while held, event-ID
 *     allocation, command/session/permission state changes pause and newly
 *     received Claude stdout is only buffered (see `withResyncMutex`;
 *     Task 24 routes the journal append through it);
 *  3. the transcript's current byte length is recorded and only complete
 *     records up to the last newline within it are read;
 *  4. snapshot items + the snapshot row (deliveryBase = the device's
 *     current delivery watermark, deliveryWatermark = sessions.lastEventId,
 *     session status, non-terminal commands, pending permission) are
 *     materialized in ONE SQLite transaction, and the device's ACK guard
 *     (`device_delivery.pendingCheckpoint` + the `deliveryBase` ceiling) is
 *     armed — begin itself never advances delivery or marks/deletes events;
 *  5. the mutex is released; buffered events then get event IDs above the
 *     watermark.
 *
 * `page` serves only from the materialized items; cursors are opaque random
 * tokens bound to (snapshotId, position) in memory — a retry of the same
 * token replays the same page, and tokens do not survive a Bridge restart
 * (an unknown cursor is 410, the correct recovery: Android re-begins).
 *
 * `commit` atomically validates prepared status + device ownership + all
 * three commit fields, flips the snapshot to `committed`, persists the
 * idempotency key / result / timestamp, advances `device_delivery`
 * (watermark AND checkpoint watermark, guard off unless another prepared
 * snapshot remains) and schedules `eventId <= watermark` events for
 * delayed deletion (checkpoint supersession). Duplicate commits with the
 * original key replay the persisted result with no further state change.
 *
 * Uncommitted checkpoints expire after a fixed TTL (§6.7: 10 minutes).
 * The sweep runs on begin, commit, and Bridge start; expired snapshots
 * never advance delivery and never delete events. After a successful
 * commit, `reconcileIndeterminateCommands` (session supervisor, §7.6
 * step 6) is invoked by the Task 24 wiring using the history adapter.
 */
import { randomUUID } from "node:crypto";
import { transaction } from "../db/database.js";
import type { SqliteDatabase } from "../db/database.js";
import type { EventJournal } from "../events/event-journal.js";
import { PROTOCOL_VERSION } from "../protocol/v1/types.js";
import {
  computeHistoryRevision,
  transcriptPathForSession,
  type ClaudeTranscriptAdapter,
  type HistoryItem,
} from "../history/claude-2.1.133-adapter.js";
import {
  CheckpointConflictError,
  SnapshotExpiredError,
  SnapshotForbiddenError,
} from "./snapshot-errors.js";

/** Fixed prepared-snapshot TTL (spec §6.7: ten minutes). */
export const SNAPSHOT_TTL_MS = 600_000;

export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`unknown session ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

export class InvalidPageSizeError extends Error {
  constructor(readonly pageSize: number) {
    super(`pageSize must be a positive integer; got ${pageSize}`);
    this.name = "InvalidPageSizeError";
  }
}

/** Pending permission snapshot captured into the checkpoint (§6.7 step 4). */
export interface PendingPermissionSnapshot {
  readonly payloadJson: string;
  /** Epoch ms when the permission auto-denies; remainingMs = expiresAt - now. */
  readonly expiresAt: number;
}

export interface SnapshotCommandState {
  readonly requestId: string;
  readonly commandType: string;
  readonly status: string;
}

export interface BeginArgs {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly pageSize: number;
  readonly now: number;
}

export interface BeginResult {
  readonly snapshotId: string;
  readonly historyRevision: string;
  readonly items: readonly HistoryItem[];
  readonly nextCursor: string | null;
  readonly deliveryBase: number;
  readonly deliveryWatermark: number;
  readonly sessionStatus: string;
  readonly commands: readonly SnapshotCommandState[];
  readonly pendingPermission: { payloadJson: string; remainingMs: number } | null;
  readonly expiresAt: number;
}

export interface PageArgs {
  readonly cursor: string;
  readonly now: number;
}

export interface PageResult {
  readonly items: readonly HistoryItem[];
  readonly nextCursor: string | null;
}

export interface CommitArgs {
  readonly snapshotId: string;
  readonly historyRevision: string;
  readonly deliveryWatermark: number;
  readonly idempotencyKey: string;
  readonly deviceId: string;
  readonly now: number;
}

/** Shape persisted as `commitResultJson` and replayed on duplicate commits. */
export interface CommitResult {
  readonly status: "committed";
  readonly snapshotId: string;
  readonly historyRevision: string;
  readonly deliveryWatermark: number;
  readonly deliveryBase: number;
  readonly committedAt: number;
}

export interface SnapshotServiceOptions {
  readonly db: SqliteDatabase;
  readonly journal: Pick<EventJournal, "markCheckpointSuperseded">;
  readonly claudeConfigDir: string;
  readonly adapterFor: (projectRoot: string) => ClaudeTranscriptAdapter;
  readonly getPendingPermission?: (sessionId: string) => PendingPermissionSnapshot | null;
  readonly snapshotTtlMs?: number;
}

export interface SnapshotService {
  begin(args: BeginArgs): Promise<BeginResult>;
  page(args: PageArgs): Promise<PageResult>;
  commit(args: CommitArgs): Promise<CommitResult>;
  /**
   * Flip `prepared` rows whose `expiresAt <= now` to `expired`. Invoked on
   * begin, commit, and Bridge start. Synchronous (pure SQLite).
   */
  expireStale(now: number): void;
  /**
   * Run `fn` under the per-session resync mutex (§6.7 step 1). The snapshot
   * service holds it across begin's materialization; Task 24 routes the
   * journal append (event-ID allocation) for the session through this hook
   * so buffered events land with IDs above the watermark after release.
   */
  withResyncMutex<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
}

interface SessionJoinRow {
  sessionId: string;
  sessionStatus: string;
  lastEventId: number;
  projectId: string;
  canonicalRealpath: string;
}

interface SnapshotRow {
  snapshotId: string;
  sessionId: string;
  deviceId: string;
  status: "prepared" | "committed" | "expired";
  historyRevision: string;
  adapterVersion: string;
  transcriptPath: string;
  readByteLimit: number;
  deliveryBase: number;
  deliveryWatermark: number;
  sessionStatus: string;
  pendingPermissionJson: string | null;
  commitIdempotencyKey: string | null;
  commitResultJson: string | null;
  committedAt: number | null;
  createdAt: number;
  expiresAt: number;
}

interface CursorBinding {
  snapshotId: string;
  pageSize: number;
  startOrdinal: number;
}

export function createSnapshotService(options: SnapshotServiceOptions): SnapshotService {
  const { db, journal } = options;
  const ttlMs = options.snapshotTtlMs ?? SNAPSHOT_TTL_MS;

  const getSessionJoin = db.prepare(
    `SELECT s.sessionId, s.status AS sessionStatus, s.lastEventId, s.projectId, p.canonicalRealpath
     FROM sessions s JOIN projects p ON p.projectId = s.projectId WHERE s.sessionId = ?`,
  );
  const getSnapshot = db.prepare("SELECT * FROM history_snapshots WHERE snapshotId = ?");
  const insertSnapshot = db.prepare(
    `INSERT INTO history_snapshots
       (snapshotId, sessionId, deviceId, status, historyRevision, adapterVersion, transcriptPath,
        readByteLimit, deliveryBase, deliveryWatermark, sessionStatus, pendingPermissionJson,
        createdAt, expiresAt)
     VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO history_snapshot_items (snapshotId, ordinal, historyItemId, historyRevision, payloadJson)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const getItemsPage = db.prepare(
    "SELECT payloadJson FROM history_snapshot_items WHERE snapshotId = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?",
  );
  const countItems = db.prepare("SELECT COUNT(*) AS n FROM history_snapshot_items WHERE snapshotId = ?");
  const nonTerminalCommands = db.prepare(
    `SELECT requestId, commandType, status FROM commands
     WHERE sessionId = ? AND status IN ('accepted','dispatching','dispatched','indeterminate')
     ORDER BY createdAt, requestId`,
  );
  const getDelivery = db.prepare(
    "SELECT deliveryBase, deliveryWatermark, pendingCheckpoint FROM device_delivery WHERE deviceId = ? AND sessionId = ?",
  );
  const armGuardOnBegin = db.prepare(
    `INSERT INTO device_delivery (deviceId, sessionId, protocolVersion, deliveryBase, deliveryWatermark, deliveryCheckpointWatermark, pendingCheckpoint)
     VALUES (?, ?, ?, ?, ?, 0, 1)
     ON CONFLICT (deviceId, sessionId) DO UPDATE SET deliveryBase = excluded.deliveryBase, pendingCheckpoint = 1`,
  );
  const expireStmt = db.prepare(
    "UPDATE history_snapshots SET status = 'expired' WHERE status = 'prepared' AND expiresAt <= ?",
  );
  const markSnapshot = db.prepare("UPDATE history_snapshots SET status = ? WHERE snapshotId = ?");
  // The ACK guard stays armed only while at least one prepared snapshot
  // remains for the device/session; recompute it after any status sweep.
  const recomputeGuard = db.prepare(
    `UPDATE device_delivery SET pendingCheckpoint =
       CASE WHEN EXISTS (
         SELECT 1 FROM history_snapshots h
         WHERE h.deviceId = device_delivery.deviceId
           AND h.sessionId = device_delivery.sessionId
           AND h.status = 'prepared'
       ) THEN 1 ELSE 0 END
     WHERE pendingCheckpoint = 1`,
  );
  const commitSnapshotStmt = db.prepare(
    `UPDATE history_snapshots
     SET status = 'committed', commitIdempotencyKey = ?, commitResultJson = ?, committedAt = ?
     WHERE snapshotId = ?`,
  );
  const ensureDeliveryRow = db.prepare(
    `INSERT INTO device_delivery (deviceId, sessionId, protocolVersion, deliveryBase, deliveryWatermark, deliveryCheckpointWatermark, pendingCheckpoint)
     VALUES (?, ?, ?, 0, 0, 0, 0)
     ON CONFLICT (deviceId, sessionId) DO NOTHING`,
  );
  const advanceDeliveryStmt = db.prepare(
    `UPDATE device_delivery
     SET deliveryWatermark = MAX(deliveryWatermark, ?),
         deliveryCheckpointWatermark = ?,
         pendingCheckpoint =
           CASE WHEN EXISTS (
             SELECT 1 FROM history_snapshots h
             WHERE h.deviceId = device_delivery.deviceId
               AND h.sessionId = device_delivery.sessionId
               AND h.status = 'prepared'
           ) THEN 1 ELSE 0 END
     WHERE deviceId = ? AND sessionId = ?`,
  );

  // Opaque cursor → (snapshotId, pageSize, position). In-memory by design:
  // cursors do not need to survive a Bridge restart — an unknown cursor is
  // 410 SNAPSHOT_EXPIRED, whose recovery is a fresh begin (§6.7). Tokens of
  // a snapshot that was committed without full pagination are pruned lazily
  // on next use and by the map's per-process lifetime otherwise.
  const cursors = new Map<string, CursorBinding>();

  // Per-session async resync mutex implemented by promise chaining.
  const mutexTails = new Map<string, Promise<void>>();

  function withResyncMutex<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = mutexTails.get(sessionId) ?? Promise.resolve();
    const result = prev.then(() => fn());
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    mutexTails.set(sessionId, tail);
    void tail.finally(() => {
      if (mutexTails.get(sessionId) === tail) mutexTails.delete(sessionId);
    });
    return result;
  }

  function loadSnapshotOrThrow(snapshotId: string): SnapshotRow {
    const row = getSnapshot.get(snapshotId) as SnapshotRow | undefined;
    if (row === undefined) {
      throw new SnapshotExpiredError(`unknown snapshot ${snapshotId}`);
    }
    return row;
  }

  const service: SnapshotService = {
    withResyncMutex,

    async begin({ sessionId, deviceId, pageSize, now }): Promise<BeginResult> {
      if (!Number.isInteger(pageSize) || pageSize <= 0) {
        throw new InvalidPageSizeError(pageSize);
      }
      // §6.7 step order: stale sweep first, then the mutex.
      service.expireStale(now);

      return withResyncMutex(sessionId, async () => {
        const session = getSessionJoin.get(sessionId) as SessionJoinRow | undefined;
        if (session === undefined) {
          throw new UnknownSessionError(sessionId);
        }
        const adapter = options.adapterFor(session.canonicalRealpath);
        const transcriptPath = transcriptPathForSession(
          options.claudeConfigDir,
          session.canonicalRealpath,
          sessionId,
        );
        // Record the transcript's CURRENT byte length, then read only the
        // complete records within it (the adapter trims to the last \n).
        const meta = await adapter.readMetadata(transcriptPath, Number.MAX_SAFE_INTEGER);
        const read = await adapter.readSnapshot(transcriptPath, meta.totalBytes);
        const historyRevision = computeHistoryRevision(
          adapter.adapterVersion,
          transcriptPath,
          meta.totalBytes,
          read.bytes,
        );

        return transaction(db, () => {
          // Session state is re-read INSIDE the transaction so the captured
          // watermark/status are consistent with the materialization write.
          const live = getSessionJoin.get(sessionId) as SessionJoinRow | undefined;
          if (live === undefined) {
            throw new UnknownSessionError(sessionId);
          }

          const snapshotId = randomUUID();
          const expiresAt = now + ttlMs;
          const delivery = getDelivery.get(deviceId, sessionId) as
            | { deliveryBase: number; deliveryWatermark: number; pendingCheckpoint: number }
            | undefined;
          const deliveryBase = delivery?.deliveryWatermark ?? 0;
          const deliveryWatermark = live.lastEventId;

          const pending = options.getPendingPermission?.(sessionId) ?? null;
          insertSnapshot.run(
            snapshotId,
            sessionId,
            deviceId,
            historyRevision,
            adapter.adapterVersion,
            transcriptPath,
            meta.totalBytes,
            deliveryBase,
            deliveryWatermark,
            live.sessionStatus,
            pending?.payloadJson ?? null,
            now,
            expiresAt,
          );
          for (const [ordinal, item] of read.items.entries()) {
            insertItem.run(snapshotId, ordinal, item.historyItemId, historyRevision, JSON.stringify(item));
          }

          // §6.7 (5): arm the ACK guard — deliveryBase becomes this device's
          // ceiling while a prepared snapshot exists. Delivery itself is NOT
          // advanced and no events are marked or deleted.
          armGuardOnBegin.run(deviceId, sessionId, PROTOCOL_VERSION, deliveryBase, deliveryBase);

          const commands = nonTerminalCommands.all(sessionId) as SnapshotCommandState[];

          const total = read.items.length;
          const firstPage = read.items.slice(0, pageSize);
          let nextCursor: string | null = null;
          if (total > pageSize) {
            const token = randomUUID();
            cursors.set(token, { snapshotId, pageSize, startOrdinal: pageSize });
            nextCursor = token;
          }

          return {
            snapshotId,
            historyRevision,
            items: firstPage,
            nextCursor,
            deliveryBase,
            deliveryWatermark,
            sessionStatus: live.sessionStatus,
            commands,
            pendingPermission:
              pending === null
                ? null
                : {
                    payloadJson: pending.payloadJson,
                    remainingMs: Math.max(0, pending.expiresAt - now),
                  },
            expiresAt,
          };
        });
      });
    },

    async page({ cursor, now }): Promise<PageResult> {
      const binding = cursors.get(cursor);
      if (binding === undefined) {
        throw new SnapshotExpiredError("unknown cursor");
      }
      // Defensive expiry check: the sweep may not have run for this row
      // yet, but §6.7 fixes expiry at creation + TTL regardless of sweep
      // timing.
      const row = getSnapshot.get(binding.snapshotId) as SnapshotRow | undefined;
      if (row === undefined || row.status !== "prepared" || row.expiresAt <= now) {
        if (row !== undefined && row.status === "prepared") {
          markSnapshot.run("expired", row.snapshotId);
          recomputeGuard.run();
        }
        cursors.delete(cursor);
        throw new SnapshotExpiredError(`snapshot ${binding.snapshotId} is no longer prepared`);
      }
      // Serve ONLY from materialized items; the live transcript is never
      // re-read here. Retrying the same token replays the same page.
      const total = (countItems.get(binding.snapshotId) as { n: number }).n;
      const rows = getItemsPage.all(
        binding.snapshotId,
        binding.startOrdinal,
        binding.pageSize,
      ) as Array<{ payloadJson: string }>;
      const items = rows.map((r) => JSON.parse(r.payloadJson) as HistoryItem);
      const consumed = binding.startOrdinal + rows.length;
      let nextCursor: string | null = null;
      if (consumed < total) {
        const token = randomUUID();
        cursors.set(token, { snapshotId: binding.snapshotId, pageSize: binding.pageSize, startOrdinal: consumed });
        nextCursor = token;
      }
      cursors.delete(cursor);
      return { items, nextCursor };
    },

    async commit({ snapshotId, historyRevision, deliveryWatermark, idempotencyKey, deviceId, now }): Promise<CommitResult> {
      return transaction(db, () => {
        // Sweep first (§6.7): a row whose TTL has elapsed must surface as
        // expired regardless of the commit's own wall clock.
        expireStmt.run(now);
        recomputeGuard.run();
        const row = loadSnapshotOrThrow(snapshotId);

        // Ownership is validated before any status/field handling: a
        // foreign device must learn nothing about the snapshot, not even
        // via the duplicate-commit replay path.
        if (row.deviceId !== deviceId) {
          throw new SnapshotForbiddenError(snapshotId, row.deviceId, deviceId);
        }

        if (row.status === "expired") {
          throw new SnapshotExpiredError(`snapshot ${snapshotId} expired at ${row.expiresAt}`);
        }
        if (row.status === "committed") {
          // Duplicate recognition reads the persisted commitIdempotencyKey.
          if (row.commitIdempotencyKey !== idempotencyKey) {
            throw new CheckpointConflictError(
              `snapshot ${snapshotId} is already committed under a different idempotency key`,
            );
          }
          if (row.historyRevision === historyRevision && row.deliveryWatermark === deliveryWatermark) {
            return JSON.parse(row.commitResultJson!) as CommitResult;
          }
          throw new CheckpointConflictError(
            `snapshot ${snapshotId} was committed with the same idempotency key but different fields`,
          );
        }

        // prepared: all three fields must match the row.
        if (row.historyRevision !== historyRevision || row.deliveryWatermark !== deliveryWatermark) {
          throw new CheckpointConflictError(
            `commit fields do not match snapshot ${snapshotId}: ` +
              `historyRevision ${historyRevision} vs ${row.historyRevision}, ` +
              `deliveryWatermark ${deliveryWatermark} vs ${row.deliveryWatermark}`,
          );
        }

        const result: CommitResult = {
          status: "committed",
          snapshotId,
          historyRevision,
          deliveryWatermark,
          deliveryBase: row.deliveryBase,
          committedAt: now,
        };
        // Same transaction: flip status + persist key/result/timestamp…
        commitSnapshotStmt.run(idempotencyKey, JSON.stringify(result), now, snapshotId);
        ensureDeliveryRow.run(deviceId, row.sessionId, PROTOCOL_VERSION);
        // …advance delivery (watermark + checkpoint watermark; the guard
        // turns off unless another prepared snapshot remains)…
        advanceDeliveryStmt.run(deliveryWatermark, deliveryWatermark, deviceId, row.sessionId);
        // …and mark eventId <= watermark events superseded (delayed
        // deletion via the journal's retention window).
        journal.markCheckpointSuperseded(row.sessionId, deviceId, BigInt(deliveryWatermark), now);
        return result;
      });
    },

    expireStale(now): void {
      transaction(db, () => {
        expireStmt.run(now);
        // Expired snapshots never advance delivery and never delete events;
        // the only delivery-side effect is releasing the ACK guard when no
        // prepared snapshot remains for the device.
        recomputeGuard.run();
      });
    },
  };

  return service;
}

// Re-export the typed protocol errors for the wiring layer's convenience.
export { CheckpointConflictError, SnapshotExpiredError, SnapshotForbiddenError };
