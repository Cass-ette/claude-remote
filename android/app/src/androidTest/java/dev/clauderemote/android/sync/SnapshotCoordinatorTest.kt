package dev.clauderemote.android.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.clauderemote.android.data.local.AppDatabase
import dev.clauderemote.android.data.local.CheckpointCommitPendingEntity
import dev.clauderemote.android.data.local.Migrations
import dev.clauderemote.android.data.local.PendingLiveEventEntity
import dev.clauderemote.android.data.local.SessionEntity
import dev.clauderemote.android.network.SnapshotExpiredError
import dev.clauderemote.android.protocol.v1.ProtocolEvent
import dev.clauderemote.android.protocol.v1.ProtocolJson
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented contract tests for the §6.7 two-phase checkpoint recovery
 * (Android side) against a REAL Room database:
 *
 * 1. 4410 → snapshot.begin → page through all items while buffering live
 *    events with eventId > deliveryWatermark → ONE Room transaction
 *    {revision replace, session status, non-terminal commands, pending
 *    permission, checkpoint_commit_pending, cursor = deliveryWatermark} →
 *    snapshot.commit with the pre-generated idempotency key → clear pending
 *    → apply the buffered events in eventId order;
 * 2. while the commit is pending, the plain-ACK path refuses anything past
 *    deliveryBase (NOT deliveryWatermark);
 * 3. an app crash between the Room transaction and the confirmed commit
 *    leaves the pending row durable; restart retries the SAME
 *    idempotencyKey, never a plain ACK;
 * 4. a 410 SNAPSHOT_EXPIRED commit keeps the pending row's deliveryBase as
 *    the ACK ceiling and rebuilds from a fresh begin whose transaction
 *    REPLACES the row;
 * 5. the SessionRepository pipeline applies normal events and ACKs only
 *    what was applied.
 *
 * The bridge side is faked (SnapshotApi script); Room is real, so every
 * transaction/persistence claim is exercised on-device.
 */
@RunWith(AndroidJUnit4::class)
class SnapshotCoordinatorTest {

    private lateinit var context: Context
    private lateinit var db: AppDatabase
    private lateinit var api: FakeSnapshotApi
    private lateinit var acks: RecordingAckSender
    private lateinit var coordinator: SnapshotCoordinator
    private lateinit var repository: SessionRepository

    private val now: Instant = Instant.parse("2026-09-03T10:00:00Z")

    @Before
    fun createDb() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase(TEST_DB_NAME)
        db = Room.databaseBuilder(context, AppDatabase::class.java, TEST_DB_NAME)
            .addMigrations(*Migrations.ALL)
            .allowMainThreadQueries()
            .build()
        api = FakeSnapshotApi()
        acks = RecordingAckSender()
        coordinator = SnapshotCoordinator(
            db = db,
            api = api,
            ackSender = acks,
            newIdempotencyKey = { java.util.UUID.randomUUID().toString() },
            now = { now },
        )
        repository = SessionRepository(db = db, coordinator = coordinator, now = { now })
    }

    @After
    fun closeDb() {
        db.close()
        context.deleteDatabase(TEST_DB_NAME)
    }

    // -------------------------------------------------------------------------
    // 1. Full two-phase recovery with concurrent live-event buffering
    // -------------------------------------------------------------------------

    @Test
    fun fullTwoPhaseRecovery_pagesSnapshotsCommitsAndAppliesBufferedEvents() {
        db.sessionDao().upsert(session(status = "idle", lastAckEventId = 95))
        // Pre-existing projection rows must be replaced by the revision swap.
        seedBuffer(deltaEvent(201, "Hel"))
        seedBuffer(deltaEvent(202, "lo"))
        // eventId <= deliveryWatermark: superseded by the checkpoint, never applied.
        seedBuffer(event(150, "session.state.changed", """{"previousStatus":"idle","status":"failed"}"""))

        val inPage = CompletableDeferred<Unit>()
        val releasePage = CompletableDeferred<Unit>()
        api.pageHook = {
            inPage.complete(Unit)
            releasePage.await()
        }
        api.beginScript += beginResult(
            snapshotId = "snap-1",
            historyRevision = "rev-1",
            deliveryBase = 100,
            deliveryWatermark = 200,
            items = listOf(historyItem("h1", "user", "hello")),
            nextCursor = "c1",
            commands = listOf(SnapshotCommandState("req-1", "message.send", "dispatched")),
            pendingPermission = PendingPermissionSnapshot(
                // The captured permission.requested payload, verbatim. Kept
                // as one trimIndent raw string: splitting it across adjacent
                // raw-string literals once produced `,""requestedAt"` (an
                // unparseable double quote) and the coordinator's defensive
                // parse skip silently dropped the permission projection.
                payloadJson = """
                    {
                      "permissionRequestId": "pr-1",
                      "toolName": "Write",
                      "input": {"file_path": "/tmp/x"},
                      "requestedAt": "2026-09-03T09:59:00Z",
                      "expiresAt": "2026-09-03T10:01:00Z",
                      "displayCategory": "file_change"
                    }
                """.trimIndent(),
                remainingMs = 42_000,
            ),
        )
        api.pages["c1"] = SnapshotPageResult(
            items = listOf(historyItem("h2", "assistant", "hi there")),
            nextCursor = null,
        )
        api.commitScript += { call -> commitResult(call) }

        runBlocking {
            val job = launch { coordinator.onResyncRequired(SESSION_ID) }

            // A live event delivered while paging is in flight is buffered,
            // not applied (§6.7).
            inPage.await()
            repository.handleEvent(deltaEvent(203, "!"))
            assertEquals(0, db.messageDao().countForSession(SESSION_ID))
            releasePage.complete(Unit)

            job.join()
        }

        // Projection = snapshot items (revision-replaced) + buffered events
        // applied in eventId order ("Hel"+"lo"+"!" — never out of order).
        val rows = db.messageDao().getForSession(SESSION_ID)
        assertEquals(listOf("h1", "h2"), rows.filter { it.historyItemId in setOf("h1", "h2") }.map { it.historyItemId })
        assertEquals("rev-1", rows.first { it.historyItemId == "h1" }.historyRevision)
        val streaming = rows.single { it.status == "streaming" }
        assertEquals("""[{"kind":"text","text":"Hello!"}]""", streaming.contentJson)

        // The superseded event (150 <= watermark) was dropped: the begin's
        // sessionStatus wins, the failed flip never applied.
        assertEquals("running", db.sessionDao().getBySessionId(SESSION_ID)?.status)
        assertEquals(203L, db.sessionDao().getBySessionId(SESSION_ID)?.lastAckEventId)

        // Checkpoint state and captured projection pieces.
        assertNull(db.checkpointDao().getPendingCheckpoint())
        assertEquals("dispatched", db.commandEventDao().getByRequestId("req-1")?.status)
        val permission = db.messageDao().getByHistoryItemId("pr-1")
        assertNotNull(permission)
        assertEquals("permission", permission?.role)
        assertEquals("pending", permission?.status)

        // The buffer is fully drained.
        assertEquals(0, db.pendingLiveEventDao().countForSession(SESSION_ID))

        // The commit used the SAME pre-generated idempotency key that the
        // pending row stored, with the begin's fields.
        assertEquals(1, api.commitCalls.size)
        val call = api.commitCalls.single()
        assertEquals(SESSION_ID, call.sessionId)
        assertEquals("snap-1", call.snapshotId)
        assertEquals("rev-1", call.historyRevision)
        assertEquals(200L, call.deliveryWatermark)
        assertTrue(call.idempotencyKey.matches(Regex("^[0-9a-f-]{36}$")))

        // Exactly ONE ack, for the final contiguous position (the
        // checkpointed watermark itself needs no ack — commit advanced it).
        assertEquals(listOf(SESSION_ID to 203L), acks.sent.toList())
        assertFalse(coordinator.isResyncing(SESSION_ID))
    }

    // -------------------------------------------------------------------------
    // 2. Plain ACK refuses past deliveryBase while the commit is pending
    // -------------------------------------------------------------------------

    @Test
    fun acknowledgeRefusesPastDeliveryBaseWhileCheckpointPending() {
        db.sessionDao().upsert(session(status = "running", lastAckEventId = 95))
        val commitEntered = CompletableDeferred<Unit>()
        val releaseCommit = CompletableDeferred<Unit>()
        api.beginScript += beginResult(snapshotId = "snap-1", historyRevision = "rev-1", deliveryBase = 100, deliveryWatermark = 200)
        api.commitScript += { call ->
            commitEntered.complete(Unit)
            releaseCommit.await()
            commitResult(call)
        }

        runBlocking {
            val job = launch { coordinator.onResyncRequired(SESSION_ID) }
            commitEntered.await()

            // The pending row is durable before the bridge commit fires.
            val pending = db.checkpointDao().getPendingCheckpoint()
            assertNotNull(pending)
            assertEquals(100L, pending?.deliveryBase)
            assertEquals(200L, pending?.deliveryWatermark)

            // §6.7 step 5: while pending, a plain events.ack may not advance
            // past deliveryBase — not even to deliveryWatermark.
            assertFalse(coordinator.acknowledge(SESSION_ID, candidate = 200))
            assertFalse(coordinator.acknowledge(SESSION_ID, candidate = 150))
            assertTrue(coordinator.acknowledge(SESSION_ID, candidate = 100))
            assertEquals(listOf(SESSION_ID to 100L), acks.sent.toList())

            releaseCommit.complete(Unit)
            job.join()
        }
        assertNull(db.checkpointDao().getPendingCheckpoint())
    }

    // -------------------------------------------------------------------------
    // 3. Crash before commit: restart retries the SAME idempotency key
    // -------------------------------------------------------------------------

    @Test
    fun crashBeforeCommit_retainsPendingRowAndRestartRetriesSameKey() {
        db.sessionDao().upsert(session(status = "running", lastAckEventId = 95))
        seedBuffer(deltaEvent(201, "Hel"))
        api.beginScript += beginResult(
            snapshotId = "snap-1",
            historyRevision = "rev-1",
            deliveryBase = 100,
            deliveryWatermark = 200,
            items = listOf(historyItem("h1", "user", "hello")),
        )
        api.commitScript += { throw RuntimeException("app died before the commit response") }

        // The cycle aborts (simulated crash between the Room transaction and
        // a confirmed commit) — the pending row must survive it.
        runBlocking {
            try {
                coordinator.onResyncRequired(SESSION_ID)
                throw AssertionError("expected the crash to propagate")
            } catch (expected: RuntimeException) {
            }
        }
        val pending = db.checkpointDao().getPendingCheckpoint()
        assertNotNull(pending)
        val crashedKey = pending!!.idempotencyKey
        assertFalse(coordinator.isResyncing(SESSION_ID))

        // "Restart": a fresh coordinator over the same database file.
        api.commitScript.clear()
        api.commitScript += { call -> commitResult(call) }
        val restarted = SnapshotCoordinator(
            db = db,
            api = api,
            ackSender = acks,
            now = { now },
        )
        val recovered = runBlocking { restarted.recoverPendingCheckpoints() }

        assertTrue(recovered)
        // The crashed attempt AND the restart retry — the fake records every
        // commit invocation, including the one that "died" mid-response.
        assertEquals(2, api.commitCalls.size)
        assertEquals(crashedKey, api.commitCalls.first().idempotencyKey)
        val retry = api.commitCalls.last()
        assertEquals(crashedKey, retry.idempotencyKey)
        assertEquals("snap-1", retry.snapshotId)
        assertEquals("rev-1", retry.historyRevision)
        assertEquals(200L, retry.deliveryWatermark)
        assertNull(db.checkpointDao().getPendingCheckpoint())

        // The buffered event above the watermark applied post-commit.
        assertEquals("""[{"kind":"text","text":"Hel"}]""", db.messageDao().getForSession(SESSION_ID).single { it.status == "streaming" }.contentJson)
        assertEquals(201L, db.sessionDao().getBySessionId(SESSION_ID)?.lastAckEventId)
    }

    // -------------------------------------------------------------------------
    // 4. 410 SNAPSHOT_EXPIRED: keep the deliveryBase ceiling, rebuild
    // -------------------------------------------------------------------------

    @Test
    fun snapshotExpiredOnCommit_retainsAckCeilingAndRebuildsWithFreshSnapshot() {
        db.sessionDao().upsert(session(status = "running", lastAckEventId = 95))
        api.beginScript += beginResult(
            snapshotId = "snap-1",
            historyRevision = "rev-1",
            deliveryBase = 100,
            deliveryWatermark = 200,
            items = listOf(historyItem("hA1", "user", "stale")),
        )
        api.commitScript += { throw SnapshotExpiredError(retryable = true, "snapshot expired") }

        // The rebuild begin blocks until the mid-window assertions ran: the
        // OLD pending row (deliveryBase 100) must still pin the ceiling.
        val beginBEntered = CompletableDeferred<Unit>()
        val releaseBeginB = CompletableDeferred<Unit>()
        api.beginHooks[1] = {
            beginBEntered.complete(Unit)
            releaseBeginB.await()
        }
        api.beginScript += beginResult(
            snapshotId = "snap-2",
            historyRevision = "rev-2",
            deliveryBase = 100,
            deliveryWatermark = 250,
            items = listOf(historyItem("hB1", "user", "fresh 1"), historyItem("hB2", "assistant", "fresh 2")),
        )
        api.commitScript += { call -> commitResult(call) }

        runBlocking {
            val job = launch { coordinator.onResyncRequired(SESSION_ID) }
            beginBEntered.await()

            // Between the 410 and the fresh commit, the stale projection is
            // invalid but the ACK ceiling stays at the OLD deliveryBase.
            val pending = db.checkpointDao().getPendingCheckpoint()
            assertEquals("snap-1", pending?.snapshotId)
            assertFalse(coordinator.acknowledge(SESSION_ID, candidate = 200))
            assertTrue(coordinator.acknowledge(SESSION_ID, candidate = 100))

            releaseBeginB.complete(Unit)
            job.join()
        }

        // The second cycle's transaction REPLACED the pending row and the
        // projection, then cleared it on the successful commit.
        assertNull(db.checkpointDao().getPendingCheckpoint())
        assertEquals(listOf("hB1", "hB2"), db.messageDao().getForSession(SESSION_ID).map { it.historyItemId })
        assertEquals(250L, db.sessionDao().getBySessionId(SESSION_ID)?.lastAckEventId)

        // Two commits: the expired one and the fresh one, under DIFFERENT
        // keys (the new snapshot is a new checkpoint).
        assertEquals(2, api.commitCalls.size)
        assertEquals("snap-1", api.commitCalls[0].snapshotId)
        assertEquals("snap-2", api.commitCalls[1].snapshotId)
        assertNotEquals(api.commitCalls[0].idempotencyKey, api.commitCalls[1].idempotencyKey)
    }

    // -------------------------------------------------------------------------
    // 5. Normal (non-resync) pipeline: apply + ACK only what was applied
    // -------------------------------------------------------------------------

    @Test
    fun repositoryAppliesNormalEventsAndAcksOnlyAppliedOnes() {
        db.sessionDao().upsert(session(status = "idle", lastAckEventId = 0))
        runBlocking {
            repository.handleEvent(event(1, "session.state.changed", """{"previousStatus":"idle","status":"running"}"""))
            // Bridge redelivery of the same eventId: deduped, NOT re-acked.
            repository.handleEvent(event(1, "session.state.changed", """{"previousStatus":"running","status":"failed"}"""))
        }
        assertEquals("running", db.sessionDao().getBySessionId(SESSION_ID)?.status)
        assertEquals(1L, db.sessionDao().getBySessionId(SESSION_ID)?.lastAckEventId)
        assertEquals(listOf(SESSION_ID to 1L), acks.sent.toList())
    }

    // -------------------------------------------------------------------------
    // 6. 410 while paging: rebuild from a fresh begin, nothing durable written
    // -------------------------------------------------------------------------

    @Test
    fun snapshotExpiredWhilePaging_rebuildsFromFreshBeginWithoutCommitting() {
        db.sessionDao().upsert(session(status = "running", lastAckEventId = 95))
        api.beginScript += beginResult(
            snapshotId = "snap-1",
            historyRevision = "rev-1",
            deliveryBase = 100,
            deliveryWatermark = 200,
            items = listOf(historyItem("hA1", "user", "stale")),
            nextCursor = "c1",
        )
        // The prepared snapshot expires between the first and second page:
        // a 410 from page must trigger a fresh begin, never propagate.
        api.pages["c1"] = SnapshotPageResult(
            items = listOf(historyItem("hA2", "assistant", "stale 2")),
            nextCursor = "c2",
        )
        api.pageErrors["c2"] = SnapshotExpiredError(retryable = true, "snapshot expired")
        api.beginScript += beginResult(
            snapshotId = "snap-2",
            historyRevision = "rev-2",
            deliveryBase = 100,
            deliveryWatermark = 200,
            items = listOf(historyItem("hB1", "user", "fresh")),
        )
        api.commitScript += { call -> commitResult(call) }

        runBlocking { coordinator.onResyncRequired(SESSION_ID) }

        // Only the rebuilt snapshot reached the projection and the commit:
        // the expired cycle wrote NOTHING durable — no projection replace,
        // no pending row, no commit.
        assertEquals(listOf("hB1"), db.messageDao().getForSession(SESSION_ID).map { it.historyItemId })
        assertEquals(1, api.commitCalls.size)
        assertEquals("snap-2", api.commitCalls.single().snapshotId)
        assertNull(db.checkpointDao().getPendingCheckpoint())
        assertEquals(200L, db.sessionDao().getBySessionId(SESSION_ID)?.lastAckEventId)
    }

    @Test
    fun snapshotExpiredWhilePaging_boundedByMaxCyclesPropagates() {
        db.sessionDao().upsert(session(status = "running", lastAckEventId = 95))
        repeat(SnapshotCoordinator.MAX_SNAPSHOT_CYCLES) { n ->
            api.beginScript += beginResult(
                snapshotId = "snap-$n",
                historyRevision = "rev-$n",
                deliveryBase = 100,
                deliveryWatermark = 200,
                nextCursor = "c-$n",
            )
            api.pageErrors["c-$n"] = SnapshotExpiredError(retryable = true, "snapshot expired")
        }
        var propagated: SnapshotExpiredError? = null
        runBlocking {
            try {
                coordinator.onResyncRequired(SESSION_ID)
            } catch (e: SnapshotExpiredError) {
                propagated = e
            }
        }
        assertNotNull("page 410s beyond MAX_SNAPSHOT_CYCLES must propagate", propagated)
        assertEquals(0, api.commitCalls.size)
        assertFalse(coordinator.isResyncing(SESSION_ID))
    }

    // -------------------------------------------------------------------------
    // 7. Cross-session single-flight: never clobber another pending row
    // -------------------------------------------------------------------------

    @Test
    fun resyncRequired_refusesWhenAnotherSessionsCheckpointIsPending() {
        db.checkpointDao().setPendingCheckpoint(
            CheckpointCommitPendingEntity(
                sessionId = OTHER_SESSION_ID,
                snapshotId = "snap-other",
                historyRevision = "rev-other",
                deliveryBase = 10,
                deliveryWatermark = 20,
                idempotencyKey = "idem-other",
                createdAt = now,
            ),
        )

        var conflict: PendingCheckpointConflictException? = null
        runBlocking {
            try {
                coordinator.onResyncRequired(SESSION_ID)
            } catch (e: PendingCheckpointConflictException) {
                conflict = e
            }
        }
        assertNotNull("a second session's cycle must refuse, not clobber", conflict)
        assertEquals(SESSION_ID, conflict?.requestedSessionId)
        assertEquals(OTHER_SESSION_ID, conflict?.pendingSessionId)
        // The other session's pending row (and its ACK ceiling) is intact,
        // and no network cycle was started for this session.
        assertEquals("snap-other", db.checkpointDao().getPendingCheckpoint()?.snapshotId)
        assertEquals(0, api.commitCalls.size)
        assertFalse(coordinator.isResyncing(SESSION_ID))
    }

    // -------------------------------------------------------------------------
    // 8. Buffered event above the watermark survives the post-commit cleanup
    // -------------------------------------------------------------------------

    @Test
    fun bufferedEventAboveWatermarkBehindGap_survivesCommitCleanupAndAppliesWhenGapFills() {
        db.sessionDao().upsert(session(status = "running", lastAckEventId = 95))
        seedBuffer(deltaEvent(201, "Hel"))
        seedBuffer(deltaEvent(202, "lo"))
        // 203 is still in flight: a mid-window arrival at 204 must NOT be
        // dropped by the post-commit buffer cleanup — only rows <= the
        // committed watermark are superseded.
        seedBuffer(deltaEvent(204, "!"))
        api.beginScript += beginResult(
            snapshotId = "snap-1",
            historyRevision = "rev-1",
            deliveryBase = 100,
            deliveryWatermark = 200,
            items = listOf(historyItem("h1", "user", "hello")),
        )
        api.commitScript += { call -> commitResult(call) }

        runBlocking { coordinator.onResyncRequired(SESSION_ID) }

        // 201/202 applied; 204 (> watermark, gap at 203) survived the cleanup.
        assertEquals(1, db.pendingLiveEventDao().countForSession(SESSION_ID))
        assertEquals(202L, db.sessionDao().getBySessionId(SESSION_ID)?.lastAckEventId)

        // The gap fills (bridge redelivery of 203): the survivor drains and
        // applies in eventId order — "Hel"+"lo"+""+"!".
        runBlocking { repository.handleEvent(deltaEvent(203, "")) }
        assertEquals(0, db.pendingLiveEventDao().countForSession(SESSION_ID))
        val streaming = db.messageDao().getForSession(SESSION_ID).single { it.status == "streaming" }
        assertEquals("""[{"kind":"text","text":"Hello!"}]""", streaming.contentJson)
        assertEquals(204L, db.sessionDao().getBySessionId(SESSION_ID)?.lastAckEventId)
    }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    private fun session(status: String, lastAckEventId: Long?): SessionEntity =
        SessionEntity(
            sessionId = SESSION_ID,
            projectId = "project-1",
            displayName = "Alpha",
            status = status,
            lastAckEventId = lastAckEventId,
            updatedAt = now,
        )

    private fun historyItem(id: String, role: String, text: String): SnapshotHistoryItem =
        SnapshotHistoryItem(
            historyItemId = id,
            role = role,
            contentBlocks = Json.parseToJsonElement("""[{"kind":"text","text":"$text"}]"""),
            createdAt = "2026-09-03T09:00:00Z",
            sourceTranscriptOffset = 0,
        )

    private fun beginResult(
        snapshotId: String,
        historyRevision: String,
        deliveryBase: Long,
        deliveryWatermark: Long,
        items: List<SnapshotHistoryItem> = emptyList(),
        nextCursor: String? = null,
        commands: List<SnapshotCommandState> = emptyList(),
        pendingPermission: PendingPermissionSnapshot? = null,
    ): SnapshotBeginResult =
        SnapshotBeginResult(
            snapshotId = snapshotId,
            historyRevision = historyRevision,
            items = items,
            nextCursor = nextCursor,
            deliveryBase = deliveryBase,
            deliveryWatermark = deliveryWatermark,
            sessionStatus = "running",
            commands = commands,
            pendingPermission = pendingPermission,
            expiresAt = 1_757_000_000_000,
        )

    private fun commitResult(call: FakeSnapshotApi.CommitCall): SnapshotCommitResult =
        SnapshotCommitResult(
            status = "committed",
            snapshotId = call.snapshotId,
            historyRevision = call.historyRevision,
            deliveryWatermark = call.deliveryWatermark,
            deliveryBase = 100,
            committedAt = 1_757_000_001_000,
        )

    private fun event(eventId: Long, eventType: String, payload: String): ProtocolEvent =
        ProtocolJson.json.decodeFromString(
            ProtocolEvent.serializer(),
            """
            {
              "protocolVersion": "claude-remote.v1",
              "eventId": "$eventId",
              "sessionId": "$SESSION_ID",
              "eventType": "$eventType",
              "timestamp": "2026-09-03T10:00:00Z",
              "payload": $payload
            }
            """.trimIndent(),
        )

    private fun deltaEvent(eventId: Long, text: String): ProtocolEvent =
        event(
            eventId,
            "assistant.message.delta",
            """{"frame":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"$text"}}}""",
        )

    private fun seedBuffer(event: ProtocolEvent) {
        db.pendingLiveEventDao().bufferPendingEvent(
            PendingLiveEventEntity(
                sessionId = event.sessionId,
                eventId = event.eventId.value,
                envelopeJson = ProtocolJson.json.encodeToString(ProtocolEvent.serializer(), event),
                receivedAt = now,
            ),
        )
    }

    private companion object {
        const val SESSION_ID = "22222222-2222-4222-8222-222222222222"
        const val OTHER_SESSION_ID = "33333333-3333-4333-8333-333333333333"
        const val TEST_DB_NAME = "snapshot-coordinator-test.db"
    }
}

/** Scripted [SnapshotApi]: canned begins/pages and per-call commit handlers. */
private class FakeSnapshotApi : SnapshotApi {
    data class CommitCall(
        val sessionId: String,
        val snapshotId: String,
        val historyRevision: String,
        val deliveryWatermark: Long,
        val idempotencyKey: String,
    )

    val commitCalls = mutableListOf<CommitCall>()
    val beginScript = ArrayDeque<SnapshotBeginResult>()
    val beginHooks = mutableMapOf<Int, suspend () -> Unit>()
    val pages = mutableMapOf<String, SnapshotPageResult>()
    val pageErrors = mutableMapOf<String, Exception>()
    val commitScript = ArrayDeque<suspend (CommitCall) -> SnapshotCommitResult>()
    var pageHook: (suspend () -> Unit)? = null
    private var beginsServed = 0

    override suspend fun begin(sessionId: String): SnapshotBeginResult {
        beginHooks[beginsServed]?.invoke()
        beginsServed += 1
        return beginScript.removeFirst()
    }

    override suspend fun page(sessionId: String, cursor: String): SnapshotPageResult {
        pageHook?.invoke()
        pageErrors[cursor]?.let { throw it }
        return pages.getValue(cursor)
    }

    override suspend fun commit(
        sessionId: String,
        snapshotId: String,
        historyRevision: String,
        deliveryWatermark: Long,
        idempotencyKey: String,
    ): SnapshotCommitResult {
        val call = CommitCall(sessionId, snapshotId, historyRevision, deliveryWatermark, idempotencyKey)
        commitCalls.add(call)
        val handler = commitScript.removeFirst()
        return handler(call)
    }
}

private class RecordingAckSender : AckSender {
    val sent = mutableListOf<Pair<String, Long>>()

    override suspend fun send(sessionId: String, lastEventId: Long) {
        sent.add(sessionId to lastEventId)
    }
}
