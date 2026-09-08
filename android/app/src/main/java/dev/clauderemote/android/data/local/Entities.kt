package dev.clauderemote.android.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import java.time.Instant

/**
 * Room entities for the on-device projection (spec §6.1, §6.7).
 *
 * Room is the persistence owner of already-rendered history on this install;
 * the Claude transcript remains the authoritative rebuild source across
 * installs, imports and resyncs. Multi-step invariants (revision replace,
 * guarded ACK, checkpoint commit) live in [Daos] @Transaction methods so they
 * are atomic with respect to the bridge protocol.
 */

/** One row per known bridge session; carries the per-session ACK cursor (§8.5). */
@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey val sessionId: String,
    val projectId: String,
    val displayName: String,
    /** Session lifecycle state as reported by the bridge (e.g. running/stopped). */
    val status: String,
    /**
     * Last continuously consumed AND acknowledged eventId. Null until the
     * first events.ack succeeds; only ever written by the monotonic DAO
     * ([SessionDao.ackIfAfter] / [SessionDao.ackGuarded]).
     */
    val lastAckEventId: Long?,
    val updatedAt: Instant,
)

/**
 * Projected conversation row. The primary key is the STABLE source ID shared
 * by snapshot items and live events (the transcript message UUID, or a
 * file-offset + content-hash synthesis when missing), so re-delivery of the
 * same message upserts rather than duplicates (§6.7).
 */
@Entity(
    tableName = "messages",
    indices = [Index("sessionId"), Index("requestId")],
)
data class MessageEntity(
    @PrimaryKey val historyItemId: String,
    val sessionId: String,
    /** History revision whose projection last wrote this row. */
    val historyRevision: String,
    /** user | assistant | tool | system. */
    val role: String,
    /** Serialized content blocks (App history schema); opaque at this layer. */
    val contentJson: String,
    /** JSON array of source IDs merged into this row (message UUID, tool use ID). */
    val sourceIdsJson: String,
    /** Rendered-message state, e.g. streaming | complete | failed. */
    val status: String,
    /** Correlation to the message.send request that produced this row, if any. */
    val requestId: String?,
    /** Stable ordering within the session (snapshot position or event order). */
    val position: Long,
    /** Wire RFC3339 timestamp, stored verbatim. */
    val createdAt: String,
    val updatedAt: Instant,
)

/**
 * Projection row for an outbound command, keyed by requestId — the
 * conversation-side correlation key of command.status.changed events.
 */
@Entity(
    tableName = "command_events",
    indices = [Index("sessionId")],
)
data class CommandEventEntity(
    @PrimaryKey val requestId: String,
    /** Null for global commands (session.list, session.create, ...). */
    val sessionId: String?,
    val idempotencyKey: String,
    /** Wire commandType discriminator, e.g. "message.send". */
    val commandType: String,
    /** Wire commandStatus (accepted/dispatching/dispatched/.../failed). */
    val status: String,
    /** Serialized terminal result payload, present once completed. */
    val resultJson: String?,
    val updatedAt: Instant,
)

/**
 * LIVE events (eventId > deliveryWatermark) buffered while snapshot paging is
 * in flight (§6.7). They are NOT applied to the projection until
 * session.snapshot.commit succeeds; the re-deliverable envelope is kept
 * verbatim. Composite PK dedupes bridge redeliveries of the same event.
 */
@Entity(tableName = "pending_live_events", primaryKeys = ["sessionId", "eventId"])
data class PendingLiveEventEntity(
    val sessionId: String,
    val eventId: Long,
    /** Raw protocol event envelope JSON, applied in eventId order post-commit. */
    val envelopeJson: String,
    val receivedAt: Instant,
)

/**
 * Single-row marker for a prepared-but-uncommitted resync checkpoint (§6.7).
 * Its presence pins the ACK ceiling to [deliveryBase] (NOT
 * [deliveryWatermark]) until session.snapshot.commit succeeds and the row is
 * cleared; after a crash the stored [idempotencyKey] must be reused to retry
 * the same commit instead of sending a plain events.ack.
 */
@Entity(tableName = "checkpoint_commit_pending")
data class CheckpointCommitPendingEntity(
    @PrimaryKey val id: Int = SINGLE_ROW,
    val sessionId: String,
    val snapshotId: String,
    val historyRevision: String,
    val deliveryBase: Long,
    val deliveryWatermark: Long,
    val idempotencyKey: String,
    val createdAt: Instant,
) {
    companion object {
        const val SINGLE_ROW = 1
    }
}

/**
 * Single-row record of the current bridge device session. The token itself is
 * stored encrypted (Android Keystore-backed); Room keeps only a reference to
 * the encrypted blob plus its expiry.
 */
@Entity(tableName = "device_session")
data class DeviceSessionEntity(
    @PrimaryKey val id: Int = SINGLE_ROW,
    /** Reference to the encrypted token blob in keystore-backed storage. */
    val tokenBlobRef: String,
    val expiresAt: Instant,
) {
    companion object {
        const val SINGLE_ROW = 1
    }
}

/** Single-row snapshot of connection state for the UI (spec §6.1). */
@Entity(tableName = "connection_state")
data class ConnectionStateEntity(
    @PrimaryKey val id: Int = SINGLE_ROW,
    val bridgeHost: String,
    /** JSON object of sessionId -> last seen eventId while connected. */
    val lastEventIdBySessionJson: String,
    val updatedAt: Instant,
) {
    companion object {
        const val SINGLE_ROW = 1
    }
}
