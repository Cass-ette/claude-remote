package dev.clauderemote.android.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import java.time.Instant

/**
 * Atomic projection/ACK DAOs (spec §6.1, §6.7, §8.5). Multi-step invariants
 * are wrapped in @Transaction methods so a crash mid-operation can never
 * leave a half-applied projection or a half-advanced ACK cursor.
 */

@Dao
interface SessionDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(session: SessionEntity)

    @Query("SELECT * FROM sessions WHERE sessionId = :sessionId")
    fun getBySessionId(sessionId: String): SessionEntity?

    @Query("SELECT * FROM sessions ORDER BY updatedAt DESC")
    fun getAll(): List<SessionEntity>

    /**
     * Plain events.ack cursor write: strictly monotonic (§8.5). Returns the
     * number of rows advanced (1 or 0); equal, backward, or unknown-session
     * candidates change nothing.
     */
    @Query(
        "UPDATE sessions SET lastAckEventId = :candidate, updatedAt = :now " +
            "WHERE sessionId = :sessionId " +
            "AND (lastAckEventId IS NULL OR lastAckEventId < :candidate)"
    )
    fun ackIfAfterRows(sessionId: String, candidate: Long, now: Instant): Int

    /**
     * Boolean form of [ackIfAfterRows]: true only when the candidate
     * advanced the cursor.
     */
    fun ackIfAfter(sessionId: String, candidate: Long, now: Instant): Boolean =
        ackIfAfterRows(sessionId, candidate, now) == 1

    /**
     * ACK ceiling while a checkpoint commit is pending (§6.7). Lives on this
     * DAO (rather than CheckpointDao) so the ceiling read and the cursor
     * write run inside ONE transaction: a concurrent setPendingCheckpoint
     * cannot slip between the guard and the write.
     */
    @Query("SELECT deliveryBase FROM checkpoint_commit_pending LIMIT 1")
    fun pendingAckCeiling(): Long?

    /**
     * Guarded events.ack used in normal operation. While
     * checkpoint_commit_pending exists, the cursor may not advance past
     * deliveryBase — NOT deliveryWatermark; the bridge answers such acks
     * with 409 CHECKPOINT_COMMIT_REQUIRED and the client must retry the
     * snapshot commit instead. With no pending checkpoint this is a plain
     * [ackIfAfter].
     */
    @Transaction
    fun ackGuarded(sessionId: String, candidate: Long, now: Instant): Boolean {
        val ceiling = pendingAckCeiling()
        if (ceiling != null && candidate > ceiling) {
            return false
        }
        return ackIfAfter(sessionId, candidate, now)
    }
}

@Dao
interface MessageDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertMessage(message: MessageEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertAll(messages: List<MessageEntity>)

    @Query("SELECT * FROM messages WHERE historyItemId = :historyItemId")
    fun getByHistoryItemId(historyItemId: String): MessageEntity?

    @Query("SELECT * FROM messages WHERE sessionId = :sessionId ORDER BY position ASC")
    fun getForSession(sessionId: String): List<MessageEntity>

    @Query("SELECT COUNT(*) FROM messages WHERE sessionId = :sessionId")
    fun countForSession(sessionId: String): Int

    /** Highest projected position in the session; null when empty (EventReducer). */
    @Query("SELECT MAX(position) FROM messages WHERE sessionId = :sessionId")
    fun maxPosition(sessionId: String): Long?

    /** Correlation read for the command badge source (§7.4 requestId link). */
    @Query("SELECT * FROM messages WHERE sessionId = :sessionId AND requestId = :requestId LIMIT 1")
    fun getByRequestId(sessionId: String, requestId: String): MessageEntity?

    @Query("DELETE FROM messages WHERE historyItemId = :historyItemId")
    fun deleteByHistoryItemId(historyItemId: String)

    @Query("DELETE FROM messages WHERE sessionId = :sessionId")
    fun deleteForSession(sessionId: String)

    /**
     * Atomically swap the session's history projection to [items], the write
     * half of the §6.7 snapshot-commit Room transaction. Dedup across
     * snapshot items and live events is inherent: every row lands on its
     * stable historyItemId PK. [items] rows are re-stamped with
     * [historyRevision] so the projection always records its source
     * revision, even if callers assembled items loosely.
     */
    @Transaction
    fun replaceHistoryRevision(
        sessionId: String,
        historyRevision: String,
        items: List<MessageEntity>,
    ) {
        deleteForSession(sessionId)
        upsertAll(items.map { it.copy(sessionId = sessionId, historyRevision = historyRevision) })
    }
}

@Dao
interface CommandEventDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(event: CommandEventEntity)

    @Query("SELECT * FROM command_events WHERE requestId = :requestId")
    fun getByRequestId(requestId: String): CommandEventEntity?

    @Query("SELECT * FROM command_events WHERE sessionId = :sessionId ORDER BY updatedAt ASC")
    fun getForSession(sessionId: String): List<CommandEventEntity>

    /**
     * Apply a command.status.changed event: requestId is the correlation
     * key, so exactly the matching row (if any) transitions. Returns the
     * affected-row count — 1 means correlated, 0 means the requestId is
     * unknown to this projection (e.g. a command issued by another device).
     */
    @Query(
        "UPDATE command_events SET status = :status, resultJson = :resultJson, updatedAt = :now " +
            "WHERE requestId = :requestId"
    )
    fun updateCommandStatusByRequestId(
        requestId: String,
        status: String,
        resultJson: String?,
        now: Instant,
    ): Int
}

@Dao
interface CheckpointDao {

    /** Written in the same transaction as the revision replace (§6.7). */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun setPendingCheckpoint(pending: CheckpointCommitPendingEntity)

    @Query("SELECT * FROM checkpoint_commit_pending LIMIT 1")
    fun getPendingCheckpoint(): CheckpointCommitPendingEntity?

    /**
     * Cleared only after session.snapshot.commit succeeds — and only the row
     * of the cycle that committed: a clear naming a different snapshotId
     * (e.g. a row another session's cycle wrote meanwhile) must leave that
     * row, and its ACK ceiling, intact.
     */
    @Query("DELETE FROM checkpoint_commit_pending WHERE snapshotId = :snapshotId")
    fun clearPendingCheckpoint(snapshotId: String)
}

@Dao
interface PendingLiveEventDao {

    /** Buffer a live event observed while snapshot paging is in flight. */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun bufferPendingEvent(event: PendingLiveEventEntity)

    @Query(
        "SELECT * FROM pending_live_events " +
            "WHERE sessionId = :sessionId AND eventId > :afterEventId " +
            "ORDER BY eventId ASC"
    )
    fun getBufferedEvents(sessionId: String, afterEventId: Long): List<PendingLiveEventEntity>

    @Query(
        "DELETE FROM pending_live_events " +
            "WHERE sessionId = :sessionId AND eventId > :afterEventId"
    )
    fun deleteBufferedEvents(sessionId: String, afterEventId: Long): Int

    /**
     * Post-commit cleanup (§6.7): only the rows the committed checkpoint
     * SUPERSEDES (eventId <= deliveryWatermark) are deleted. Rows above the
     * watermark that could not be applied yet (a mid-window arrival behind a
     * gap) are still un-ACKed and must survive for §8.5 redelivery — never
     * clear the whole session buffer here.
     */
    @Query(
        "DELETE FROM pending_live_events " +
            "WHERE sessionId = :sessionId AND eventId <= :watermark"
    )
    fun deleteBufferedEventsUpTo(sessionId: String, watermark: Long): Int

    @Query("SELECT COUNT(*) FROM pending_live_events WHERE sessionId = :sessionId")
    fun countForSession(sessionId: String): Int

    @Query("DELETE FROM pending_live_events WHERE sessionId = :sessionId")
    fun clearForSession(sessionId: String)

    /**
     * Drain the session's buffered live events in eventId order, consuming
     * them atomically (§6.7 post-commit application). Re-deliveries of the
     * same event are already deduped by the composite PK.
     */
    @Transaction
    fun takeBufferedEvents(
        sessionId: String,
        afterEventId: Long,
    ): List<PendingLiveEventEntity> {
        val events = getBufferedEvents(sessionId, afterEventId)
        if (events.isNotEmpty()) {
            deleteBufferedEvents(sessionId, afterEventId)
        }
        return events
    }
}

@Dao
interface DeviceSessionDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun put(deviceSession: DeviceSessionEntity)

    @Query("SELECT * FROM device_session LIMIT 1")
    fun get(): DeviceSessionEntity?

    @Query("DELETE FROM device_session")
    fun clear()
}

@Dao
interface ConnectionStateDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun put(state: ConnectionStateEntity)

    @Query("SELECT * FROM connection_state LIMIT 1")
    fun get(): ConnectionStateEntity?

    @Query("DELETE FROM connection_state")
    fun clear()
}
