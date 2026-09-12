package dev.clauderemote.android.data.local

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented contract tests for the atomic projection/ACK DAOs (spec §6.1,
 * §6.7, §8.5). Every scenario runs its writes inside a single Room
 * transaction, mirroring the commit transaction the snapshot coordinator
 * performs. Room needs a real database, so these run on-device/on-emulator.
 */
@RunWith(AndroidJUnit4::class)
class RoomProjectionTest {

    private lateinit var context: Context
    private lateinit var db: AppDatabase

    private val sessionId = "session-alpha"
    private val otherSessionId = "session-beta"
    private val now: Instant = Instant.parse("2026-08-04T12:00:00Z")

    @Before
    fun createDb() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase(TEST_DB_NAME)
        db = openDb()
    }

    @After
    fun closeDb() {
        db.close()
        context.deleteDatabase(TEST_DB_NAME)
    }

    /** Reopens the SAME database file, standing in for a process restart. */
    private fun openDb(): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, TEST_DB_NAME)
            .addMigrations(*Migrations.ALL)
            .allowMainThreadQueries()
            .build()

    // -------------------------------------------------------------------------
    // 1. History revision replace upserts by stable historyItemId
    // -------------------------------------------------------------------------

    @Test
    fun replaceHistoryRevisionUpsertsByStableHistoryItemId() {
        db.runInTransaction {
            val messages = db.messageDao()

            // Snapshot projection of revision 1.
            messages.replaceHistoryRevision(
                sessionId = sessionId,
                historyRevision = "rev-1",
                items = listOf(
                    message("h1", "rev-1", "user", "hello"),
                    message("h2", "rev-1", "assistant", "partial answer"),
                ),
            )
            assertEquals(2, messages.countForSession(sessionId))

            // A live event carrying the SAME stable historyItemId (the message
            // UUID the snapshot already projected) must upsert the existing
            // row, never append a duplicate (§6.7 shared source IDs).
            messages.upsertMessage(message("h2", "live", "assistant", "completed answer"))
            assertEquals(2, messages.countForSession(sessionId))
            assertEquals("completed answer", messages.getByHistoryItemId("h2")?.contentJson)

            // Replacing with revision 2 atomically rewrites the session's
            // projection: updated h2 stays a single row, h3 appears, h1 keeps
            // exactly one row.
            messages.replaceHistoryRevision(
                sessionId = sessionId,
                historyRevision = "rev-2",
                items = listOf(
                    message("h1", "rev-2", "user", "hello"),
                    message("h2", "rev-2", "assistant", "final answer"),
                    message("h3", "rev-2", "assistant", "tool summary"),
                ),
            )
            val rows = messages.getForSession(sessionId)
            assertEquals(listOf("h1", "h2", "h3"), rows.map { it.historyItemId })
            assertEquals("final answer", rows.single { it.historyItemId == "h2" }.contentJson)
            assertEquals("rev-2", rows.single { it.historyItemId == "h1" }.historyRevision)
        }
    }

    // -------------------------------------------------------------------------
    // 2. events.ack writes lastAckEventId only when monotonically increasing
    // -------------------------------------------------------------------------

    @Test
    fun ackWritesLastAckEventIdOnlyWhenMonotonicallyIncreasing() {
        db.runInTransaction {
            val sessions = db.sessionDao()
            sessions.upsert(session(lastAckEventId = null))

            // Null cursor: the first ack always writes.
            assertTrue(sessions.ackIfAfter(sessionId, candidate = 100, now = now))
            assertEquals(100L, sessions.getBySessionId(sessionId)?.lastAckEventId)

            // Forward write accepted.
            assertTrue(sessions.ackIfAfter(sessionId, candidate = 150, now = now))
            assertEquals(150L, sessions.getBySessionId(sessionId)?.lastAckEventId)

            // Equal and backward candidates are refused; unknown sessions too.
            assertFalse(sessions.ackIfAfter(sessionId, candidate = 150, now = now))
            assertFalse(sessions.ackIfAfter(sessionId, candidate = 149, now = now))
            assertFalse(sessions.ackIfAfter("session-unknown", candidate = 999, now = now))
            assertEquals(150L, sessions.getBySessionId(sessionId)?.lastAckEventId)
        }
    }

    // -------------------------------------------------------------------------
    // 3. checkpoint_commit_pending persists across process restart
    // -------------------------------------------------------------------------

    @Test
    fun pendingCheckpointPersistsAcrossReopen() {
        db.runInTransaction {
            db.checkpointDao().setPendingCheckpoint(pendingCheckpoint())
        }
        val before = db.checkpointDao().getPendingCheckpoint()
        assertNotNull(before)

        // Closing and reopening the same file stands in for process death:
        // after a crash the app MUST retry the same commit, so the row (with
        // its pre-generated idempotency key) has to survive.
        db.close()
        db = openDb()

        val after = db.checkpointDao().getPendingCheckpoint()
        assertNotNull(after)
        assertEquals(before!!.idempotencyKey, after!!.idempotencyKey)
        assertEquals(before.snapshotId, after.snapshotId)
        assertEquals(before.historyRevision, after.historyRevision)
        assertEquals(before.deliveryBase, after.deliveryBase)
        assertEquals(before.deliveryWatermark, after.deliveryWatermark)
        assertEquals(before.sessionId, after.sessionId)
    }

    // -------------------------------------------------------------------------
    // 4. Guarded ACK ceiling is deliveryBase while a checkpoint is pending
    // -------------------------------------------------------------------------

    @Test
    fun guardedAckCeilingIsDeliveryBaseWhileCheckpointPending() {
        db.runInTransaction {
            db.sessionDao().upsert(session(lastAckEventId = 90))
            db.checkpointDao().setPendingCheckpoint(
                pendingCheckpoint(deliveryBase = 100, deliveryWatermark = 200),
            )

            val sessions = db.sessionDao()

            // Acks up to and including deliveryBase are allowed.
            assertTrue(sessions.ackGuarded(sessionId, candidate = 100, now = now))

            // deliveryBase + 1 is rejected...
            assertFalse(sessions.ackGuarded(sessionId, candidate = 101, now = now))

            // ...and so is the deliveryWatermark: the ceiling while pending is
            // deliveryBase, NOT deliveryWatermark (§6.7).
            assertFalse(sessions.ackGuarded(sessionId, candidate = 200, now = now))

            // Only the accepted ack (== deliveryBase) reached the cursor.
            assertEquals(100L, sessions.getBySessionId(sessionId)?.lastAckEventId)
        }

        // The ceiling lifts only once the pending row is cleared post-commit.
        db.checkpointDao().clearPendingCheckpoint(snapshotId = "snap-1")
        assertTrue(db.sessionDao().ackGuarded(sessionId, candidate = 150, now = now))
        assertEquals(150L, db.sessionDao().getBySessionId(sessionId)?.lastAckEventId)
    }

    // -------------------------------------------------------------------------
    // 4b. clearPendingCheckpoint deletes only the named cycle's row
    // -------------------------------------------------------------------------

    @Test
    fun clearPendingCheckpointScopesToTheCycleSnapshotRow() {
        db.checkpointDao().setPendingCheckpoint(pendingCheckpoint(snapshotId = "snap-A"))

        // A clear naming a DIFFERENT snapshot (e.g. a cycle whose row was
        // replaced mid-flight) must leave this row — and its ACK ceiling —
        // alone: deleting unconditionally could clobber another session's
        // prepared checkpoint.
        db.checkpointDao().clearPendingCheckpoint(snapshotId = "snap-B")
        assertEquals("snap-A", db.checkpointDao().getPendingCheckpoint()?.snapshotId)
        assertFalse(db.sessionDao().ackGuarded(sessionId, candidate = 150, now = now))

        db.checkpointDao().clearPendingCheckpoint(snapshotId = "snap-A")
        assertNull(db.checkpointDao().getPendingCheckpoint())
    }

    // -------------------------------------------------------------------------
    // 5. command.status.changed updates exactly the matching requestId row
    // -------------------------------------------------------------------------

    @Test
    fun commandStatusChangedUpdatesOnlyTheMatchingRequestIdRow() {
        db.runInTransaction {
            val commands = db.commandEventDao()
            commands.upsert(commandEvent(requestId = "req-X", status = "dispatching"))
            commands.upsert(commandEvent(requestId = "req-Y", status = "dispatching"))

            val updatedRows = commands.updateCommandStatusByRequestId(
                requestId = "req-X",
                status = "completed",
                resultJson = """{"ok":true}""",
                now = now,
            )

            // The correlation key is requestId: exactly one row affected.
            assertEquals(1, updatedRows)

            val x = commands.getByRequestId("req-X")
            assertEquals("completed", x?.status)
            assertEquals("""{"ok":true}""", x?.resultJson)

            val y = commands.getByRequestId("req-Y")
            assertEquals("dispatching", y?.status)
            assertNull(y?.resultJson)
        }
    }

    // -------------------------------------------------------------------------
    // 6. Live events buffered during snapshot paging: dedup + ordered take
    // -------------------------------------------------------------------------

    @Test
    fun bufferedLiveEventsAreDeduplicatedAndTakenInEventIdOrder() {
        db.runInTransaction {
            val buffer = db.pendingLiveEventDao()

            buffer.bufferPendingEvent(liveEvent(sessionId, eventId = 103, body = "e103"))
            buffer.bufferPendingEvent(liveEvent(sessionId, eventId = 101, body = "e101"))
            buffer.bufferPendingEvent(liveEvent(otherSessionId, eventId = 101, body = "other"))

            // Re-delivery of the same (sessionId, eventId) replaces the row
            // instead of duplicating it.
            buffer.bufferPendingEvent(liveEvent(sessionId, eventId = 103, body = "e103-retry"))
            assertEquals(2, buffer.countForSession(sessionId))

            // Take consumes the session's buffered events in eventId order.
            val taken = buffer.takeBufferedEvents(sessionId, afterEventId = 100)
            assertEquals(listOf(101L, 103L), taken.map { it.eventId })
            assertEquals("e103-retry", taken.last().envelopeJson)
            assertEquals(0, buffer.countForSession(sessionId))

            // The other session's buffer is untouched.
            assertEquals(1, buffer.countForSession(otherSessionId))
        }
    }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    private fun session(lastAckEventId: Long?): SessionEntity =
        SessionEntity(
            sessionId = sessionId,
            projectId = "project-1",
            displayName = "Alpha",
            status = "running",
            lastAckEventId = lastAckEventId,
            updatedAt = now,
        )

    private fun message(
        historyItemId: String,
        historyRevision: String,
        role: String,
        contentJson: String,
    ): MessageEntity =
        MessageEntity(
            historyItemId = historyItemId,
            sessionId = sessionId,
            historyRevision = historyRevision,
            role = role,
            contentJson = contentJson,
            sourceIdsJson = """["$historyItemId"]""",
            status = "complete",
            requestId = null,
            position = historyItemId.removePrefix("h").toLong(),
            createdAt = "2026-08-04T12:00:00Z",
            updatedAt = now,
        )

    private fun commandEvent(requestId: String, status: String): CommandEventEntity =
        CommandEventEntity(
            requestId = requestId,
            sessionId = sessionId,
            idempotencyKey = "idem-$requestId",
            commandType = "message.send",
            status = status,
            resultJson = null,
            updatedAt = now,
        )

    private fun pendingCheckpoint(
        deliveryBase: Long = 100,
        deliveryWatermark: Long = 200,
        snapshotId: String = "snap-1",
    ): CheckpointCommitPendingEntity =
        CheckpointCommitPendingEntity(
            sessionId = sessionId,
            snapshotId = snapshotId,
            historyRevision = "rev-1",
            deliveryBase = deliveryBase,
            deliveryWatermark = deliveryWatermark,
            idempotencyKey = "idem-commit-1",
            createdAt = now,
        )

    private fun liveEvent(sessionId: String, eventId: Long, body: String): PendingLiveEventEntity =
        PendingLiveEventEntity(
            sessionId = sessionId,
            eventId = eventId,
            envelopeJson = body,
            receivedAt = now,
        )

    private companion object {
        const val TEST_DB_NAME = "room-projection-test.db"
    }
}
