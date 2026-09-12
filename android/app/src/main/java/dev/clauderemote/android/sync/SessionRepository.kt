package dev.clauderemote.android.sync

import androidx.room.withTransaction
import dev.clauderemote.android.data.local.AppDatabase
import dev.clauderemote.android.data.local.PendingLiveEventEntity
import dev.clauderemote.android.network.AckPositionSource
import dev.clauderemote.android.protocol.v1.ProtocolEvent
import dev.clauderemote.android.protocol.v1.ProtocolJson
import java.time.Instant

/**
 * The session projection pipeline (spec §6.1, §6.7, §8.4, §8.5).
 *
 * - [handleEvent] is the live §8.4 consumer: while a §6.7 snapshot cycle is
 *   in flight (or its commit is still pending) the event is buffered
 *   verbatim into `pending_live_events`; otherwise it is folded into the
 *   projection by [EventReducer] inside ONE Room transaction and the
 *   advanced position is ACKed through the coordinator's GUARDED path;
 * - [lastAckedEventIds] implements [AckPositionSource] for the
 * ConnectionCoordinator's §11.1 resume-from markers: the position comes
 * from `sessions.lastAckEventId`, which the snapshot COMMIT path sets to
 * the checkpointed deliveryWatermark — so post-checkpoint reconnects ACK
 * the advanced (checkpointed) position, never a stale local cursor (the
 * bridge advances its watermark on commit and rejects backward ACKs).
 */
class SessionRepository(
    private val db: AppDatabase,
    private val coordinator: SnapshotCoordinator,
    private val reducer: EventReducer = EventReducer(),
    private val now: () -> Instant = Instant::now,
) : AckPositionSource {

    private val daos by lazy {
        ProjectionDaos(
            sessions = db.sessionDao(),
            messages = db.messageDao(),
            commands = db.commandEventDao(),
            pendingEvents = db.pendingLiveEventDao(),
        )
    }

    /**
     * §11.1 resume-from markers. Blocking Room read — call from a worker
     * dispatcher (the connection coordinator does).
     */
    override fun lastAckedEventIds(): Map<String, Long> =
        db.sessionDao().getAll()
            .mapNotNull { session -> session.lastAckEventId?.let { session.sessionId to it } }
            .toMap()

    /**
     * Consumes one live event. Buffer-or-apply and the projection write
     * run in a single Room transaction, so the decision can never race a
     * concurrently written `checkpoint_commit_pending` row.
     */
    suspend fun handleEvent(event: ProtocolEvent) {
        val outcome = db.withTransaction { applyOrBufferLocked(event) }
        // Only an APPLIED event advances consumption — duplicates were
        // already acked, buffered ones are still supersede-able by a
        // future checkpoint.
        if (outcome == EventReducer.Outcome.APPLIED) {
            coordinator.acknowledge(event.sessionId, event.eventId.value)
        }
    }

    /** MUST run inside one Room transaction (the caller's). */
    private fun applyOrBufferLocked(event: ProtocolEvent): EventReducer.Outcome? {
        if (coordinator.isResyncing(event.sessionId) || isCommitPendingFor(event.sessionId)) {
            db.pendingLiveEventDao().bufferPendingEvent(
                PendingLiveEventEntity(
                    sessionId = event.sessionId,
                    eventId = event.eventId.value,
                    envelopeJson = ProtocolJson.json.encodeToString(ProtocolEvent.serializer(), event),
                    receivedAt = now(),
                ),
            )
            return null
        }
        return reducer.apply(daos, event)
    }

    private fun isCommitPendingFor(sessionId: String): Boolean {
        val pending = db.checkpointDao().getPendingCheckpoint() ?: return false
        return pending.sessionId == sessionId
    }
}
