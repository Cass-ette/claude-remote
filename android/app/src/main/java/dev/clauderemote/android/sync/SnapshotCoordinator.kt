package dev.clauderemote.android.sync

import androidx.room.withTransaction
import dev.clauderemote.android.data.local.AppDatabase
import dev.clauderemote.android.data.local.CheckpointCommitPendingEntity
import dev.clauderemote.android.data.local.CommandEventEntity
import dev.clauderemote.android.data.local.MessageEntity
import dev.clauderemote.android.data.local.SessionEntity
import dev.clauderemote.android.network.BridgeCommandApi
import dev.clauderemote.android.network.SnapshotExpiredError
import dev.clauderemote.android.protocol.v1.EventId
import dev.clauderemote.android.protocol.v1.EventType
import dev.clauderemote.android.protocol.v1.PROTOCOL_VERSION
import dev.clauderemote.android.protocol.v1.ProtocolEvent
import dev.clauderemote.android.protocol.v1.ProtocolResponse
import dev.clauderemote.android.protocol.v1.SessionRefPayload
import dev.clauderemote.android.protocol.v1.SessionSnapshotBeginCommand
import dev.clauderemote.android.protocol.v1.SessionSnapshotCommitCommand
import dev.clauderemote.android.protocol.v1.SessionSnapshotCommitPayload
import dev.clauderemote.android.protocol.v1.SessionSnapshotPageCommand
import dev.clauderemote.android.protocol.v1.SessionSnapshotPagePayload
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * §6.7 two-phase resync coordinator (Android side).
 *
 * `session.snapshot.begin` → page → ONE Room transaction {revision replace,
 * session status, non-terminal commands, pending permission,
 * checkpoint_commit_pending, cursor = deliveryWatermark} →
 * `session.snapshot.commit` with the pre-generated idempotency key →
 * clear pending → apply buffered events above the watermark in order.
 *
 * Crash safety: the pending row is written in the SAME transaction as the
 * projection, so a crash at any point leaves exactly one durable truth:
 * either the old projection (no row — plain events resume), or the new
 * projection plus the row (startup must retry the SAME commit key, never a
 * plain ACK). A 410 SNAPSHOT_EXPIRED keeps the row — its deliveryBase stays
 * the ACK ceiling — and the next cycle's transaction replaces it.
 */
class SnapshotCoordinator(
    private val db: AppDatabase,
    private val api: SnapshotApi,
    private val ackSender: AckSender,
    private val gate: ResyncGate = ResyncGate(),
    private val reducer: EventReducer = EventReducer(),
    private val newIdempotencyKey: () -> String = { UUID.randomUUID().toString() },
    private val now: () -> Instant = Instant::now,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    /**
     * Runs the full §6.7 recovery for one session (the 4410 path). On a
     * 410 commit the cycle restarts from a fresh begin — the pending row
     * pins the ACK ceiling at the OLD deliveryBase until the new cycle's
     * transaction replaces it — bounded by [MAX_SNAPSHOT_CYCLES].
     */
    suspend fun onResyncRequired(sessionId: String) {
        gate.begin(sessionId)
        try {
            var attempt = 0
            while (true) {
                attempt += 1
                val begin = api.begin(sessionId)
                val items = ArrayList(begin.items)
                var cursor = begin.nextCursor
                while (cursor != null) {
                    val page = api.page(sessionId, cursor)
                    items.addAll(page.items)
                    cursor = page.nextCursor
                }
                val idempotencyKey = newIdempotencyKey()
                db.withTransaction { writeCheckpointProjection(sessionId, begin, items, idempotencyKey) }
                try {
                    api.commit(
                        sessionId = sessionId,
                        snapshotId = begin.snapshotId,
                        historyRevision = begin.historyRevision,
                        deliveryWatermark = begin.deliveryWatermark,
                        idempotencyKey = idempotencyKey,
                    )
                } catch (e: SnapshotExpiredError) {
                    // 410: the projection is stale but the pending row (and
                    // its deliveryBase ceiling) survives; a fresh begin
                    // rebuilds and its transaction REPLACES the row.
                    if (attempt >= MAX_SNAPSHOT_CYCLES) throw e
                    continue
                }
                withContext(io) { db.checkpointDao().clearPendingCheckpoint() }
                applyBuffered(sessionId, begin.deliveryWatermark)
                return
            }
        } finally {
            gate.end(sessionId)
        }
    }

    /**
     * Startup recovery: a pending row means the app died between the Room
     * transaction and a confirmed commit. Retry the SAME idempotency key
     * (the bridge replays the persisted result on a duplicate commit); if
     * the prepared snapshot expired meanwhile, rebuild via
     * [onResyncRequired]. Returns false only when nothing was pending.
     */
    suspend fun recoverPendingCheckpoints(): Boolean {
        val pending = withContext(io) { db.checkpointDao().getPendingCheckpoint() } ?: return false
        gate.begin(pending.sessionId)
        try {
            try {
                api.commit(
                    sessionId = pending.sessionId,
                    snapshotId = pending.snapshotId,
                    historyRevision = pending.historyRevision,
                    deliveryWatermark = pending.deliveryWatermark,
                    idempotencyKey = pending.idempotencyKey,
                )
            } catch (e: SnapshotExpiredError) {
                onResyncRequired(pending.sessionId)
                return true
            }
            withContext(io) { db.checkpointDao().clearPendingCheckpoint() }
            applyBuffered(pending.sessionId, pending.deliveryWatermark)
            return true
        } finally {
            gate.end(pending.sessionId)
        }
    }

    /**
     * True while a §6.7 cycle holds the session: the repository buffers
     * live events instead of applying them.
     */
    fun isResyncing(sessionId: String): Boolean = gate.isResyncing(sessionId)

    /**
     * The guarded events.ack path. While a checkpoint commit is pending for
     * the session, a plain ACK may not advance past the pending row's
     * deliveryBase (§6.7 step 5 — the bridge answers 409
     * CHECKPOINT_COMMIT_REQUIRED); such acks are refused locally and never
     * sent. After a successful commit the cursor already equals the
     * checkpointed deliveryWatermark, so post-checkpoint reconnects resume
     * from the advanced position, never the stale one.
     */
    suspend fun acknowledge(sessionId: String, candidate: Long): Boolean {
        val pending = withContext(io) { db.checkpointDao().getPendingCheckpoint() }
        if (pending != null && pending.sessionId == sessionId && candidate > pending.deliveryBase) {
            return false
        }
        ackSender.send(sessionId, candidate)
        return true
    }

    // -------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------

    /** MUST run inside one Room transaction (the caller's). */
    private fun writeCheckpointProjection(
        sessionId: String,
        begin: SnapshotBeginResult,
        items: List<SnapshotHistoryItem>,
        idempotencyKey: String,
    ) {
        val nowInstant = now()
        val daos = daos()

        daos.messages.replaceHistoryRevision(
            sessionId = sessionId,
            historyRevision = begin.historyRevision,
            items = items.mapIndexed { index, item ->
                MessageEntity(
                    historyItemId = item.historyItemId,
                    sessionId = sessionId,
                    historyRevision = begin.historyRevision,
                    role = item.role,
                    contentJson = item.contentBlocks.toString(),
                    sourceIdsJson = JsonPrimitive(item.historyItemId).let { listOf(it).toString() },
                    status = EventReducer.STATUS_COMPLETE,
                    requestId = null,
                    position = index.toLong(),
                    createdAt = item.createdAt,
                    updatedAt = nowInstant,
                )
            },
        )

        // Local projection position = deliveryWatermark (§6.7): the buffered
        // events above it become the new contiguous head. Monotonic — an
        // older local cursor (events not yet acked) never regresses.
        val session = daos.sessions.getBySessionId(sessionId)
            ?: SessionEntity(
                sessionId = sessionId,
                projectId = "",
                displayName = "",
                status = begin.sessionStatus,
                lastAckEventId = null,
                updatedAt = nowInstant,
            )
        daos.sessions.upsert(
            session.copy(
                status = begin.sessionStatus,
                lastAckEventId = maxOf(session.lastAckEventId ?: 0L, begin.deliveryWatermark),
                updatedAt = nowInstant,
            ),
        )

        for (command in begin.commands) {
            val existing = daos.commands.getByRequestId(command.requestId)
            daos.commands.upsert(
                CommandEventEntity(
                    requestId = command.requestId,
                    sessionId = sessionId,
                    idempotencyKey = existing?.idempotencyKey ?: "",
                    commandType = command.commandType,
                    status = command.status,
                    resultJson = existing?.resultJson,
                    updatedAt = nowInstant,
                ),
            )
        }

        begin.pendingPermission?.let { pending ->
            // Re-emit the captured permission.requested payload through the
            // reducer so the pending permission row uses the same projection
            // shape as the live event path.
            val payload = runCatching {
                Json.parseToJsonElement(pending.payloadJson)
            }.getOrNull()
            if (payload != null) {
                reducer.applyProjection(
                    daos,
                    ProtocolEvent(
                        protocolVersion = PROTOCOL_VERSION,
                        eventId = EventId(begin.deliveryWatermark),
                        sessionId = sessionId,
                        eventType = EventType.PERMISSION_REQUESTED,
                        timestamp = nowInstant.toString(),
                        payload = payload,
                    ),
                )
            }
        }

        db.checkpointDao().setPendingCheckpoint(
            CheckpointCommitPendingEntity(
                sessionId = sessionId,
                snapshotId = begin.snapshotId,
                historyRevision = begin.historyRevision,
                deliveryBase = begin.deliveryBase,
                deliveryWatermark = begin.deliveryWatermark,
                idempotencyKey = idempotencyKey,
                createdAt = nowInstant,
            ),
        )
    }

    /**
     * Post-commit: apply the buffered live events above the watermark in
     * eventId order, then drop the leftovers (everything at/below the
     * watermark is superseded by the committed snapshot; anything the drain
     * could not apply is still un-ACKed and will be redelivered — §8.5
     * at-least-once covers the deletion).
     */
    private suspend fun applyBuffered(sessionId: String, watermark: Long) {
        val buffered = withContext(io) {
            db.pendingLiveEventDao().takeBufferedEvents(sessionId, afterEventId = watermark)
        }
        val daos = daos()
        for (row in buffered) {
            val event = reducer.decodeEnvelope(row.envelopeJson) ?: continue
            db.withTransaction { reducer.apply(daos, event) }
        }
        withContext(io) { db.pendingLiveEventDao().clearForSession(sessionId) }
        val cursor = withContext(io) { db.sessionDao().getBySessionId(sessionId)?.lastAckEventId } ?: return
        if (cursor > watermark) {
            acknowledge(sessionId, cursor)
        }
    }

    private fun daos() = ProjectionDaos(
        sessions = db.sessionDao(),
        messages = db.messageDao(),
        commands = db.commandEventDao(),
        pendingEvents = db.pendingLiveEventDao(),
    )

    companion object {
        /** Guards against a pathological begin/expire loop (clock skew etc.). */
        const val MAX_SNAPSHOT_CYCLES = 3
    }
}

/**
 * Per-session re-entrant flag marking an in-flight §6.7 cycle. While held,
 * the SessionRepository buffers live events instead of applying them.
 */
class ResyncGate {
    private val depths = mutableMapOf<String, Int>()

    @Synchronized
    fun begin(sessionId: String) {
        depths[sessionId] = (depths[sessionId] ?: 0) + 1
    }

    @Synchronized
    fun end(sessionId: String) {
        val depth = (depths[sessionId] ?: 1) - 1
        if (depth <= 0) depths.remove(sessionId) else depths[sessionId] = depth
    }

    @Synchronized
    fun isResyncing(sessionId: String): Boolean = sessionId in depths
}

/** Network seam for the (single) events.ack the pipeline sends. */
fun interface AckSender {
    suspend fun send(sessionId: String, lastEventId: Long)
}

// ---------------------------------------------------------------------------
// Snapshot API contract (bridge/src/commands/command-dispatcher.ts)
// ---------------------------------------------------------------------------

/** One materialized history item of a §6.7 snapshot (HistoryItem on the wire). */
data class SnapshotHistoryItem(
    val historyItemId: String,
    val role: String,
    val contentBlocks: JsonElement,
    val createdAt: String,
    val sourceTranscriptOffset: Long,
)

/** Non-terminal command state captured into the checkpoint. */
data class SnapshotCommandState(val requestId: String, val commandType: String, val status: String)

/** Pending permission captured into the checkpoint (payload verbatim). */
data class PendingPermissionSnapshot(val payloadJson: String, val remainingMs: Long)

data class SnapshotBeginResult(
    val snapshotId: String,
    val historyRevision: String,
    val items: List<SnapshotHistoryItem>,
    val nextCursor: String?,
    val deliveryBase: Long,
    val deliveryWatermark: Long,
    val sessionStatus: String,
    val commands: List<SnapshotCommandState>,
    val pendingPermission: PendingPermissionSnapshot?,
    val expiresAt: Long,
)

data class SnapshotPageResult(val items: List<SnapshotHistoryItem>, val nextCursor: String?)

data class SnapshotCommitResult(
    val status: String,
    val snapshotId: String,
    val historyRevision: String,
    val deliveryWatermark: Long,
    val deliveryBase: Long,
    val committedAt: Long,
)

/** Injectable begin/page/commit seam; production adapter: [BridgeSnapshotApi]. */
interface SnapshotApi {
    suspend fun begin(sessionId: String): SnapshotBeginResult

    suspend fun page(sessionId: String, cursor: String): SnapshotPageResult

    suspend fun commit(
        sessionId: String,
        snapshotId: String,
        historyRevision: String,
        deliveryWatermark: Long,
        idempotencyKey: String,
    ): SnapshotCommitResult
}

/**
 * [SnapshotApi] over the §8.2 command endpoint. Field names and decimal
 * string encodings mirror the bridge dispatcher exactly:
 * begin → {snapshotId, historyRevision, items, nextCursor, deliveryBase,
 * deliveryWatermark, sessionStatus, commands, pendingPermission, expiresAt};
 * page → {items, nextCursor}; commit → {status, snapshotId, historyRevision,
 * deliveryWatermark, deliveryBase, committedAt}. Structured §8.3 errors
 * (410 SNAPSHOT_EXPIRED etc.) surface as the typed network exceptions.
 */
class BridgeSnapshotApi(
    val commands: BridgeCommandApi,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val nowMillis: () -> Long = System::currentTimeMillis,
) : SnapshotApi {

    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun begin(sessionId: String): SnapshotBeginResult {
        val response = commands.postCommand(
            SessionSnapshotBeginCommand(
                requestId = newId(),
                idempotencyKey = newId(),
                sessionId = sessionId,
                sentAt = sentAt(),
                payload = SessionRefPayload(sessionId = sessionId),
            ),
        )
        val wire = wireResult<WireBeginResult>(response)
        return SnapshotBeginResult(
            snapshotId = wire.snapshotId,
            historyRevision = wire.historyRevision,
            items = wire.items.map { it.toHistoryItem() },
            nextCursor = wire.nextCursor,
            deliveryBase = EventId.parse(wire.deliveryBase).value,
            deliveryWatermark = EventId.parse(wire.deliveryWatermark).value,
            sessionStatus = wire.sessionStatus,
            commands = wire.commands.map { SnapshotCommandState(it.requestId, it.commandType, it.status) },
            pendingPermission = wire.pendingPermission?.let {
                PendingPermissionSnapshot(payloadJson = it.payloadJson, remainingMs = it.remainingMs)
            },
            expiresAt = wire.expiresAt,
        )
    }

    override suspend fun page(sessionId: String, cursor: String): SnapshotPageResult {
        val response = commands.postCommand(
            SessionSnapshotPageCommand(
                requestId = newId(),
                idempotencyKey = newId(),
                sessionId = sessionId,
                sentAt = sentAt(),
                payload = SessionSnapshotPagePayload(sessionId = sessionId, cursor = cursor),
            ),
        )
        val wire = wireResult<WirePageResult>(response)
        return SnapshotPageResult(items = wire.items.map { it.toHistoryItem() }, nextCursor = wire.nextCursor)
    }

    override suspend fun commit(
        sessionId: String,
        snapshotId: String,
        historyRevision: String,
        deliveryWatermark: Long,
        idempotencyKey: String,
    ): SnapshotCommitResult {
        val response = commands.postCommand(
            SessionSnapshotCommitCommand(
                requestId = newId(),
                idempotencyKey = newId(),
                sessionId = sessionId,
                sentAt = sentAt(),
                payload = SessionSnapshotCommitPayload(
                    sessionId = sessionId,
                    snapshotId = snapshotId,
                    historyRevision = historyRevision,
                    deliveryWatermark = deliveryWatermark,
                    idempotencyKey = idempotencyKey,
                ),
            ),
        )
        val wire = wireResult<WireCommitResult>(response)
        if (wire.snapshotId != snapshotId || wire.historyRevision != historyRevision ||
            EventId.parse(wire.deliveryWatermark).value != deliveryWatermark
        ) {
            throw IllegalStateException("snapshot commit result does not match the request for $snapshotId")
        }
        return SnapshotCommitResult(
            status = wire.status,
            snapshotId = wire.snapshotId,
            historyRevision = wire.historyRevision,
            deliveryWatermark = EventId.parse(wire.deliveryWatermark).value,
            deliveryBase = EventId.parse(wire.deliveryBase).value,
            committedAt = wire.committedAt,
        )
    }

    private fun sentAt(): String = Instant.ofEpochMilli(nowMillis()).toString()

    private inline fun <reified T> wireResult(response: ProtocolResponse): T {
        val result = response.result
            ?: throw IllegalStateException("snapshot response carried no result envelope")
        return json.decodeFromJsonElement(result)
    }
}

// Wire DTOs: decimal-string uint64 fields ride the wire as strings.

@Serializable
private data class WireHistoryItem(
    val historyItemId: String,
    val role: String,
    val contentBlocks: JsonElement = JsonNull,
    val createdAt: String = "",
    val sourceTranscriptOffset: Long = 0,
) {
    fun toHistoryItem() = SnapshotHistoryItem(
        historyItemId = historyItemId,
        role = role,
        contentBlocks = contentBlocks,
        createdAt = createdAt,
        sourceTranscriptOffset = sourceTranscriptOffset,
    )
}

@Serializable
private data class WireCommandState(val requestId: String, val commandType: String, val status: String)

@Serializable
private data class WirePendingPermission(val payloadJson: String, val remainingMs: Long)

@Serializable
private data class WireBeginResult(
    val snapshotId: String,
    val historyRevision: String,
    val items: List<WireHistoryItem> = emptyList(),
    val nextCursor: String? = null,
    val deliveryBase: String,
    val deliveryWatermark: String,
    val sessionStatus: String,
    val commands: List<WireCommandState> = emptyList(),
    val pendingPermission: WirePendingPermission? = null,
    val expiresAt: Long = 0,
)

@Serializable
private data class WirePageResult(
    val items: List<WireHistoryItem> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
private data class WireCommitResult(
    val status: String,
    val snapshotId: String,
    val historyRevision: String,
    val deliveryWatermark: String,
    val deliveryBase: String,
    val committedAt: Long = 0,
)
