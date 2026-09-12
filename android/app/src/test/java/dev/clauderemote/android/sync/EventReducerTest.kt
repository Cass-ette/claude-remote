package dev.clauderemote.android.sync

import dev.clauderemote.android.data.local.CheckpointDao
import dev.clauderemote.android.data.local.CommandEventDao
import dev.clauderemote.android.data.local.CommandEventEntity
import dev.clauderemote.android.data.local.MessageDao
import dev.clauderemote.android.data.local.MessageEntity
import dev.clauderemote.android.data.local.PendingLiveEventDao
import dev.clauderemote.android.data.local.PendingLiveEventEntity
import dev.clauderemote.android.data.local.SessionDao
import dev.clauderemote.android.data.local.SessionEntity
import dev.clauderemote.android.network.BridgeCommandApi
import dev.clauderemote.android.protocol.v1.EventType
import dev.clauderemote.android.protocol.v1.ProtocolCommand
import dev.clauderemote.android.protocol.v1.ProtocolEvent
import dev.clauderemote.android.protocol.v1.ProtocolJson
import dev.clauderemote.android.protocol.v1.ProtocolResponse
import dev.clauderemote.android.protocol.v1.ResponseType
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the §8.4 event reducer (spec §6.7, §8.4, §8.5).
 *
 * The reducer is a pure function of (DAO bundle, event): it never opens a
 * Room transaction itself — the SessionRepository wraps every call in one —
 * so the JVM suite drives it against in-memory fakes of the Task-27 DAOs
 * (including their default-method invariants: monotonic ackIfAfter, guarded
 * ackGuarded, revision replace, ordered take). The real Room wiring is
 * exercised on-device by SnapshotCoordinatorTest.
 *
 * Payload fixtures mirror the bridge emitters exactly:
 * - session.state.changed {previousStatus, status}        (session-supervisor.ts)
 * - command.status.changed (typed in ProtocolModels)      (command-ledger.ts)
 * - assistant.message.delta {frame}                       (session-event-pump.ts)
 * - assistant.message.completed {messageUuid, message}    (session-event-pump.ts)
 * - permission.requested/resolved                         (permission-broker.ts)
 * The remaining event types have intentionally loose v1 payloads; the
 * reducer's local payload data classes (see EventReducer) define the
 * App-side contract for them.
 */
class EventReducerTest {

    private val now: Instant = Instant.parse("2026-09-03T10:00:00Z")
    private val reducer = EventReducer(now = { now })

    private lateinit var sessions: FakeSessionDao
    private lateinit var messages: FakeMessageDao
    private lateinit var commands: FakeCommandEventDao
    private lateinit var pendingEvents: FakePendingLiveEventDao
    private lateinit var daos: ProjectionDaos

    @org.junit.Before
    fun setUp() {
        sessions = FakeSessionDao()
        messages = FakeMessageDao()
        commands = FakeCommandEventDao()
        pendingEvents = FakePendingLiveEventDao()
        daos = ProjectionDaos(
            sessions = sessions,
            messages = messages,
            commands = commands,
            pendingEvents = pendingEvents,
        )
    }

    // -------------------------------------------------------------------
    // 1. session.state.changed
    // -------------------------------------------------------------------

    @Test
    fun sessionStateChanged_updatesStatusAndCreatesMissingSessionRow() {
        val outcome = reducer.apply(daos, event(1, "session.state.changed", """{"sessionId":"$SESSION_ID","previousStatus":"idle","status":"running"}"""))

        assertEquals(EventReducer.Outcome.APPLIED, outcome)
        val session = sessions.rows[SESSION_ID]
        assertNotNull("event for an unknown session auto-creates the row", session)
        assertEquals("running", session?.status)
        assertEquals(1L, session?.lastAckEventId)
    }

    @Test
    fun sessionStateChanged_replacesPriorStatus() {
        sessions.rows[SESSION_ID] = session(status = "idle", lastAckEventId = 7)
        reducer.apply(daos, event(8, "session.state.changed", """{"previousStatus":"idle","status":"waiting_permission"}"""))
        assertEquals("waiting_permission", sessions.rows[SESSION_ID]?.status)
        assertEquals(8L, sessions.rows[SESSION_ID]?.lastAckEventId)
    }

    // -------------------------------------------------------------------
    // 2. command.status.changed
    // -------------------------------------------------------------------

    @Test
    fun commandStatusChanged_updatesCommandRowAndFinalizesLinkedMessage() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        commands.rows["req-1"] = commandEvent(requestId = "req-1", status = "dispatched")
        messages.rows["msg-user-1"] = message(historyItemId = "msg-user-1", role = "user", status = "streaming", requestId = "req-1")

        val outcome = reducer.apply(
            daos,
            event(
                1,
                "command.status.changed",
                """
                {
                  "requestId": "req-1",
                  "idempotencyKey": "idem-1",
                  "commandType": "message.send",
                  "commandStatus": "completed",
                  "result": {"result": "done"}
                }
                """.trimIndent(),
            ),
        )

        assertEquals(EventReducer.Outcome.APPLIED, outcome)
        // Correlation key is requestId: exactly the matching row transitions.
        assertEquals("completed", commands.rows["req-1"]?.status)
        assertTrue(commands.rows["req-1"]?.resultJson?.contains("done") == true)
        // The linked MessageEntity (badge source) finalizes.
        assertEquals("complete", messages.rows["msg-user-1"]?.status)
    }

    @Test
    fun commandStatusChanged_unknownRequestIdInsertsRow() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        reducer.apply(
            daos,
            event(
                1,
                "command.status.changed",
                """
                {
                  "requestId": "req-other-device",
                  "idempotencyKey": "idem-x",
                  "commandType": "message.send",
                  "commandStatus": "dispatching"
                }
                """.trimIndent(),
            ),
        )
        // A command issued by another device still projects (0 rows updated
        // → insert from the payload).
        val inserted = commands.rows["req-other-device"]
        assertNotNull(inserted)
        assertEquals("dispatching", inserted?.status)
        assertEquals("message.send", inserted?.commandType)
        assertEquals(SESSION_ID, inserted?.sessionId)
        // Non-terminal status leaves the message badge untouched (no linked row anyway).
    }

    // -------------------------------------------------------------------
    // 3. assistant.message.delta / .completed
    // -------------------------------------------------------------------

    @Test
    fun assistantMessageDeltas_accumulateIntoOneStreamingRow() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)

        // message_start establishes the turn (its frame carries the UUID,
        // but delta payloads do not — the streaming row is per-session).
        reducer.apply(daos, event(1, "assistant.message.delta", """{"frame":{"type":"message_start","message":{"id":"msg-77","role":"assistant"}}}"""))
        // Text deltas grow the row.
        reducer.apply(daos, event(2, "assistant.message.delta", """{"frame":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}"""))
        reducer.apply(daos, event(3, "assistant.message.delta", """{"frame":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}}"""))

        assertEquals(1, messages.rows.size)
        val row = messages.rows.values.single()
        assertEquals("assistant", row.role)
        assertEquals("streaming", row.status)
        assertEquals("""[{"kind":"text","text":"Hello"}]""", row.contentJson)
        assertEquals(3L, sessions.rows[SESSION_ID]?.lastAckEventId)
    }

    @Test
    fun assistantMessageCompleted_finalizesRowAndDropsStaleFallbackStreamingRow() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        // Deltas WITHOUT any derivable id fall back to the per-session
        // streaming row.
        reducer.apply(daos, event(1, "assistant.message.delta", """{"frame":{"type":"content_block_delta","delta":{"type":"text_delta","text":"part"}}}"""))
        val fallbackId = messages.rows.keys.single()
        assertTrue(fallbackId.startsWith("streaming-assistant:"))

        reducer.apply(
            daos,
            event(
                2,
                "assistant.message.completed",
                """{"messageUuid":"msg-9","message":{"id":"msg-9","content":[{"type":"text","text":"Full answer"}]}}""",
            ),
        )

        // The finalized row lands under the stable messageUuid...
        val completed = messages.rows["msg-9"]
        assertNotNull(completed)
        assertEquals("complete", completed?.status)
        assertEquals("""[{"kind":"text","text":"Full answer"}]""", completed?.contentJson)
        // ...and the stale fallback partial is removed, not displayed twice.
        assertNull(messages.rows[fallbackId])
        assertEquals(1, messages.rows.size)
    }

    @Test
    fun assistantMessageCompleted_upsertsSnapshotRowBySharedStableId() {
        // §6.7: snapshot items and live events share the message UUID; the
        // upsert on the stable id prevents snapshot/live duplicates.
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 6)
        messages.rows["msg-7"] = message(historyItemId = "msg-7", role = "assistant", status = "complete", contentJson = """[{"kind":"text","text":"snapshot text"}]""", revision = "rev-snap")

        reducer.apply(
            daos,
            event(
                7,
                "assistant.message.completed",
                """{"messageUuid":"msg-7","message":{"content":[{"type":"text","text":"live re-delivery"}]}}""",
            ),
        )

        assertEquals(1, messages.rows.size)
        assertEquals("live re-delivery", messages.rows["msg-7"]?.contentJson?.substringAfter("\"text\":\"")?.substringBefore('"'))
    }

    // -------------------------------------------------------------------
    // 4. tool.started / tool.output.delta / tool.completed
    // -------------------------------------------------------------------

    @Test
    fun toolLifecycle_rowsKeyedByToolUseIdWithStatusTransitions() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)

        reducer.apply(daos, event(1, "tool.started", """{"toolUseId":"tu-1","toolName":"Bash","input":{"command":"ls"}}"""))
        assertEquals("running", messages.rows["tu-1"]?.status)
        assertEquals("tool", messages.rows["tu-1"]?.role)
        assertTrue(messages.rows["tu-1"]?.contentJson?.contains("\"kind\":\"tool_use\"") == true)
        assertTrue(messages.rows["tu-1"]?.contentJson?.contains("\"toolName\":\"Bash\"") == true)

        reducer.apply(daos, event(2, "tool.output.delta", """{"toolUseId":"tu-1","delta":"par"}"""))
        reducer.apply(daos, event(3, "tool.output.delta", """{"toolUseId":"tu-1","delta":"tial"}"""))
        assertTrue(messages.rows["tu-1"]?.contentJson?.contains("\"kind\":\"tool_output\",\"text\":\"partial\"") == true)

        reducer.apply(daos, event(4, "tool.completed", """{"toolUseId":"tu-1","status":"success","output":"exit 0"}"""))
        assertEquals("complete", messages.rows["tu-1"]?.status)
        assertTrue(messages.rows["tu-1"]?.contentJson?.contains("\"kind\":\"tool_result\"") == true)
        assertTrue(messages.rows["tu-1"]?.contentJson?.contains("\"content\":\"exit 0\"") == true)
    }

    @Test
    fun toolCompleted_withErrorStatusMarksRowFailed() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        reducer.apply(daos, event(1, "tool.started", """{"toolUseId":"tu-2","toolName":"Bash"}"""))
        reducer.apply(daos, event(2, "tool.completed", """{"toolUseId":"tu-2","status":"error","output":"boom"}"""))
        assertEquals("failed", messages.rows["tu-2"]?.status)
    }

    @Test
    fun toolOutputDelta_afterTerminalRowIsIgnored() {
        // A buffered delta replayed after the snapshot already completed this
        // tool (shared toolUseId) must not regress or duplicate the row.
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        messages.rows["tu-3"] = message(
            historyItemId = "tu-3",
            role = "tool",
            status = "complete",
            contentJson = """[{"kind":"tool_use","toolUseId":"tu-3","toolName":"Bash"},{"kind":"tool_result","toolUseId":"tu-3","content":"done"}]""",
        )
        val before = messages.rows["tu-3"]?.contentJson

        val outcome = reducer.apply(daos, event(1, "tool.output.delta", """{"toolUseId":"tu-3","delta":"late"}"""))

        assertEquals(EventReducer.Outcome.APPLIED, outcome)
        assertEquals(before, messages.rows["tu-3"]?.contentJson)
        assertEquals("complete", messages.rows["tu-3"]?.status)
    }

    // -------------------------------------------------------------------
    // 5. permission.requested / permission.resolved
    // -------------------------------------------------------------------

    @Test
    fun permissionRequested_thenResolved_updatesPermissionRow() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)

        reducer.apply(
            daos,
            event(
                1,
                "permission.requested",
                """
                {
                  "permissionRequestId": "pr-1",
                  "toolName": "Write",
                  "input": {"file_path": "/tmp/x"},
                  "toolUseId": "tu-9",
                  "requestedAt": "2026-09-03T09:59:00Z",
                  "expiresAt": "2026-09-03T10:01:00Z",
                  "displayCategory": "file_change"
                }
                """.trimIndent(),
            ),
        )
        val requested = messages.rows["pr-1"]
        assertNotNull(requested)
        assertEquals("permission", requested?.role)
        assertEquals("pending", requested?.status)
        assertTrue(requested?.contentJson?.contains("\"kind\":\"permission_request\"") == true)
        assertTrue(requested?.contentJson?.contains("\"toolName\":\"Write\"") == true)
        assertTrue(requested?.sourceIdsJson?.contains("pr-1") == true)

        reducer.apply(
            daos,
            event(
                2,
                "permission.resolved",
                """{"permissionRequestId":"pr-1","behavior":"allow","reason":"user_allowed"}""",
            ),
        )
        val resolved = messages.rows["pr-1"]
        assertEquals("resolved", resolved?.status)
        assertTrue(resolved?.contentJson?.contains("\"kind\":\"permission_resolution\"") == true)
        assertTrue(resolved?.contentJson?.contains("\"behavior\":\"allow\"") == true)
        // The original request stays visible after resolution.
        assertTrue(resolved?.contentJson?.contains("\"toolName\":\"Write\"") == true)
    }

    @Test
    fun permissionResolved_unknownRequestIsNoop() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        val outcome = reducer.apply(
            daos,
            event(1, "permission.resolved", """{"permissionRequestId":"pr-404","behavior":"deny","reason":"timeout"}"""),
        )
        // Consumed (cursor advances) but nothing projected: there is no row to resolve.
        assertEquals(EventReducer.Outcome.APPLIED, outcome)
        assertEquals(0, messages.rows.size)
        assertEquals(1L, sessions.rows[SESSION_ID]?.lastAckEventId)
    }

    // -------------------------------------------------------------------
    // 6. process.stderr.summary / session.interrupted / session.failed
    // -------------------------------------------------------------------

    @Test
    fun processStderrSummary_addsSystemNote() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        reducer.apply(daos, event(1, "process.stderr.summary", """{"summary":"repeated stderr noise","bytes":4096}"""))
        val note = messages.rows["event-1"]
        assertNotNull(note)
        assertEquals("system", note?.role)
        assertEquals("complete", note?.status)
        assertEquals("""[{"kind":"system_note","text":"repeated stderr noise"}]""", note?.contentJson)
    }

    @Test
    fun sessionInterrupted_addsNoteAndSetsStatus() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        reducer.apply(daos, event(1, "session.interrupted", """{"reason":"user stop"}"""))
        assertEquals("interrupted", sessions.rows[SESSION_ID]?.status)
        assertEquals("""[{"kind":"system_note","text":"user stop"}]""", messages.rows["event-1"]?.contentJson)
    }

    @Test
    fun sessionFailed_addsNoteAndSetsStatus() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        reducer.apply(
            daos,
            event(1, "session.failed", """{"error":{"code":"CLAUDE_CRASHED","message":"child exited"}}"""),
        )
        assertEquals("failed", sessions.rows[SESSION_ID]?.status)
        assertEquals("""[{"kind":"system_note","text":"child exited"}]""", messages.rows["event-1"]?.contentJson)
    }

    // -------------------------------------------------------------------
    // 7. §8.5 duplicate + out-of-order delivery
    // -------------------------------------------------------------------

    @Test
    fun duplicateEventId_isDroppedSilently() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        val first = reducer.apply(daos, event(1, "session.state.changed", """{"previousStatus":"running","status":"idle"}"""))
        assertEquals(EventReducer.Outcome.APPLIED, first)

        // Bridge redelivery of the SAME eventId (reconnect replay above the
        // resume marker is deduped downstream): dropped, no state change.
        val dup = reducer.apply(daos, event(1, "session.state.changed", """{"previousStatus":"idle","status":"failed"}"""))
        assertEquals(EventReducer.Outcome.DUPLICATE_DROPPED, dup)
        assertEquals("idle", sessions.rows[SESSION_ID]?.status)
        assertEquals(1L, sessions.rows[SESSION_ID]?.lastAckEventId)
    }

    @Test
    fun outOfOrderEvents_areBufferedUntilTheGapFills_thenAppliedInOrder() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)

        // Events 3 and 2 arrive before the contiguous head (1): buffered.
        assertEquals(EventReducer.Outcome.BUFFERED, reducer.apply(daos, event(3, "assistant.message.delta", """{"messageUuid":"m","frame":{"type":"content_block_delta","delta":{"type":"text_delta","text":"c"}}}""")))
        assertEquals(EventReducer.Outcome.BUFFERED, reducer.apply(daos, event(2, "assistant.message.delta", """{"messageUuid":"m","frame":{"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}}""")))
        assertEquals(2, pendingEvents.rows.count { it.sessionId == SESSION_ID })

        // The gap-filler arrives: 1 applies, then the buffer drains 2 and 3
        // IN EVENT ID ORDER (text "a"+"b"+"c", never "c" first).
        assertEquals(EventReducer.Outcome.APPLIED, reducer.apply(daos, event(1, "assistant.message.delta", """{"messageUuid":"m","frame":{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}}""")))

        assertEquals(0, pendingEvents.rows.count { it.sessionId == SESSION_ID })
        assertEquals(1, messages.rows.size)
        assertEquals("""[{"kind":"text","text":"abc"}]""", messages.rows.values.single().contentJson)
        assertEquals(3L, sessions.rows[SESSION_ID]?.lastAckEventId)
    }

    @Test
    fun outOfOrderGap_persistsWhenOnlyPartiallyFilled() {
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 5)
        assertEquals(EventReducer.Outcome.BUFFERED, reducer.apply(daos, event(8, "session.state.changed", """{"status":"idle"}""")))
        // 6 fills one slot; 8 remains buffered (7 still missing).
        assertEquals(EventReducer.Outcome.APPLIED, reducer.apply(daos, event(6, "session.state.changed", """{"status":"running"}""")))
        assertEquals(EventReducer.Outcome.BUFFERED, reducer.apply(daos, event(9, "session.state.changed", """{"status":"idle"}""")))
        assertEquals(EventReducer.Outcome.APPLIED, reducer.apply(daos, event(7, "session.state.changed", """{"status":"idle"}""")))
        // 7, 8, 9 all applied now.
        assertEquals(9L, sessions.rows[SESSION_ID]?.lastAckEventId)
        assertEquals(0, pendingEvents.rows.count { it.sessionId == SESSION_ID })
    }

    @Test
    fun malformedPayload_isConsumedWithoutCorruptingTheProjection() {
        // Payload drift (missing required field on a loose v1 event): the
        // position still advances — otherwise the session would wedge on a
        // permanently unparseable redelivery — but nothing is projected.
        sessions.rows[SESSION_ID] = session(status = "running", lastAckEventId = 0)
        val outcome = reducer.apply(daos, event(1, "session.state.changed", """{"previousStatus":"running"}"""))
        assertEquals(EventReducer.Outcome.APPLIED, outcome)
        assertEquals("running", sessions.rows[SESSION_ID]?.status)
        assertEquals(1L, sessions.rows[SESSION_ID]?.lastAckEventId)
        assertEquals(0, messages.rows.size)
    }

    // -------------------------------------------------------------------
    // 7b. Unknown session + non-status first event: cursor still advances
    // -------------------------------------------------------------------

    @Test
    fun nonStatusFirstEventForUnknownSession_createsCursorRowAndAdvances() {
        // NO sessions row at all (the session's first delivery is a delta,
        // which upserts no session row): the cursor must still persist —
        // otherwise every reconnect replays from zero and the session
        // wedges (§8.5).
        val outcome = reducer.apply(
            daos,
            event(1, "assistant.message.delta", """{"frame":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"""),
        )

        assertEquals(EventReducer.Outcome.APPLIED, outcome)
        val session = sessions.rows[SESSION_ID]
        assertNotNull("a non-status first event still materializes a cursor row", session)
        assertEquals(EventReducer.STATUS_UNKNOWN, session?.status)
        assertEquals(1L, session?.lastAckEventId)
        assertEquals("""[{"kind":"text","text":"Hi"}]""", messages.rows.values.single().contentJson)

        // Continuity holds on the next event too (no duplicate/replay).
        val second = reducer.apply(
            daos,
            event(2, "assistant.message.delta", """{"frame":{"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}}"""),
        )
        assertEquals(EventReducer.Outcome.APPLIED, second)
        assertEquals(2L, sessions.rows[SESSION_ID]?.lastAckEventId)
        assertEquals("""[{"kind":"text","text":"Hi there"}]""", messages.rows.values.single().contentJson)
    }

    // -------------------------------------------------------------------
    // 8. BridgeSnapshotApi wire mapping (dispatcher field names)
    // -------------------------------------------------------------------

    @Test
    fun bridgeSnapshotApi_decodesBeginPageCommitResponses() = runBlocking {
        val api = BridgeSnapshotApi(
            commands = FakeCommandApi(
                listOf(
                    // begin
                    ok(
                        """
                        {
                          "snapshotId": "snap-1",
                          "historyRevision": "rev-abc",
                          "items": [
                            {"historyItemId":"h1","role":"user","contentBlocks":[{"kind":"text","text":"hi"}],"createdAt":"2026-09-03T09:00:00Z","sourceTranscriptOffset":0},
                            {"historyItemId":"h2","role":"assistant","contentBlocks":[{"kind":"text","text":"hello"}],"createdAt":"2026-09-03T09:00:05Z","sourceTranscriptOffset":100}
                          ],
                          "nextCursor": "cur-1",
                          "deliveryBase": "100",
                          "deliveryWatermark": "200",
                          "sessionStatus": "running",
                          "commands": [{"requestId":"req-1","commandType":"message.send","status":"dispatched"}],
                          "pendingPermission": {"payloadJson":"{\"toolName\":\"Write\"}","remainingMs":42000},
                          "expiresAt": 1757000000000
                        }
                        """.trimIndent(),
                    ),
                    // page (cur-1)
                    ok("""{"items":[{"historyItemId":"h3","role":"system","contentBlocks":[{"kind":"system_note","text":"note"}],"createdAt":"2026-09-03T09:01:00Z","sourceTranscriptOffset":200}],"nextCursor":null}"""),
                    // commit
                    ok("""{"status":"committed","snapshotId":"snap-1","historyRevision":"rev-abc","deliveryWatermark":"200","deliveryBase":"100","committedAt":1757000001000}"""),
                ),
            ),
        )

        val begin = api.begin(SESSION_ID)
        assertEquals("snap-1", begin.snapshotId)
        assertEquals("rev-abc", begin.historyRevision)
        assertEquals(100L, begin.deliveryBase)
        assertEquals(200L, begin.deliveryWatermark)
        assertEquals("running", begin.sessionStatus)
        assertEquals(2, begin.items.size)
        assertEquals("user", begin.items[0].role)
        assertEquals("""[{"kind":"text","text":"hi"}]""", begin.items[0].contentBlocks.toString())
        assertEquals("cur-1", begin.nextCursor)
        assertEquals(1, begin.commands.size)
        assertEquals("dispatched", begin.commands[0].status)
        assertEquals(42000L, begin.pendingPermission?.remainingMs)

        val page = api.page(SESSION_ID, "cur-1")
        assertEquals(1, page.items.size)
        assertEquals(null, page.nextCursor)

        val commit = api.commit(SESSION_ID, snapshotId = "snap-1", historyRevision = "rev-abc", deliveryWatermark = 200, idempotencyKey = "idem-c")
        assertEquals("committed", commit.status)
        assertEquals(200L, commit.deliveryWatermark)

        // All three commands carried the §8.2 envelope shape.
        val sent = api.commands as FakeCommandApi
        assertEquals(
            listOf("session.snapshot.begin", "session.snapshot.page", "session.snapshot.commit"),
            sent.sent.map { it.commandType.wire },
        )
    }

    // -------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------

    private fun session(status: String, lastAckEventId: Long?): SessionEntity =
        SessionEntity(
            sessionId = SESSION_ID,
            projectId = "project-1",
            displayName = "Alpha",
            status = status,
            lastAckEventId = lastAckEventId,
            updatedAt = now,
        )

    private fun message(
        historyItemId: String,
        role: String,
        status: String,
        contentJson: String = """[{"kind":"text","text":"x"}]""",
        revision: String = "live",
        requestId: String? = null,
    ): MessageEntity =
        MessageEntity(
            historyItemId = historyItemId,
            sessionId = SESSION_ID,
            historyRevision = revision,
            role = role,
            contentJson = contentJson,
            sourceIdsJson = """["$historyItemId"]""",
            status = status,
            requestId = requestId,
            position = messages.rows.size.toLong(),
            createdAt = "2026-09-03T09:00:00Z",
            updatedAt = now,
        )

    private fun commandEvent(requestId: String, status: String): CommandEventEntity =
        CommandEventEntity(
            requestId = requestId,
            sessionId = SESSION_ID,
            idempotencyKey = "idem-$requestId",
            commandType = "message.send",
            status = status,
            resultJson = null,
            updatedAt = now,
        )

    /** Envelope fixture: payload passed through as raw JSON. */
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

    private fun ok(resultJson: String): ProtocolResponse = ProtocolJson.json.decodeFromString(
        ProtocolResponse.serializer(),
        """
        {
          "protocolVersion": "claude-remote.v1",
          "requestId": "00000000-0000-4000-8000-000000000001",
          "responseType": "command.status",
          "commandStatus": "completed",
          "result": $resultJson
        }
        """.trimIndent(),
    )

    private companion object {
        const val SESSION_ID = "11111111-1111-4111-8111-111111111111"
    }
}

// ---------------------------------------------------------------------------
// In-memory DAO fakes. Only the abstract @Query methods are implemented; the
// interface default methods (ackIfAfter/ackGuarded, replaceHistoryRevision,
// takeBufferedEvents) are inherited, so the fakes exercise the same
// invariants Room runs.
// ---------------------------------------------------------------------------

private class FakeSessionDao : SessionDao {
    val rows = linkedMapOf<String, SessionEntity>()
    var injectedCeiling: Long? = null

    override fun upsert(session: SessionEntity) {
        rows[session.sessionId] = session
    }

    override fun getBySessionId(sessionId: String): SessionEntity? = rows[sessionId]

    override fun getAll(): List<SessionEntity> = rows.values.sortedByDescending { it.updatedAt }

    override fun ackIfAfterRows(sessionId: String, candidate: Long, now: Instant): Int {
        val row = rows[sessionId] ?: return 0
        val current = row.lastAckEventId ?: return upsertAndCount(row, candidate, now)
        if (candidate <= current) return 0
        return upsertAndCount(row, candidate, now)
    }

    private fun upsertAndCount(row: SessionEntity, candidate: Long, now: Instant): Int {
        rows[row.sessionId] = row.copy(lastAckEventId = candidate, updatedAt = now)
        return 1
    }

    override fun pendingAckCeiling(): Long? = injectedCeiling
}

private class FakeMessageDao : MessageDao {
    val rows = linkedMapOf<String, MessageEntity>()

    override fun upsertMessage(message: MessageEntity) {
        rows[message.historyItemId] = message
    }

    override fun upsertAll(messages: List<MessageEntity>) {
        messages.forEach { upsertMessage(it) }
    }

    override fun getByHistoryItemId(historyItemId: String): MessageEntity? = rows[historyItemId]

    override fun getForSession(sessionId: String): List<MessageEntity> =
        rows.values.filter { it.sessionId == sessionId }.sortedBy { it.position }

    override fun countForSession(sessionId: String): Int = rows.values.count { it.sessionId == sessionId }

    override fun deleteForSession(sessionId: String) {
        rows.keys.removeAll(rows.values.filter { it.sessionId == sessionId }.map { it.historyItemId }.toSet())
    }

    override fun maxPosition(sessionId: String): Long? =
        rows.values.filter { it.sessionId == sessionId }.maxOfOrNull { it.position }

    override fun getByRequestId(sessionId: String, requestId: String): MessageEntity? =
        rows.values.firstOrNull { it.sessionId == sessionId && it.requestId == requestId }

    override fun deleteByHistoryItemId(historyItemId: String) {
        rows.remove(historyItemId)
    }
}

private class FakeCommandEventDao : CommandEventDao {
    val rows = linkedMapOf<String, CommandEventEntity>()

    override fun upsert(event: CommandEventEntity) {
        rows[event.requestId] = event
    }

    override fun getByRequestId(requestId: String): CommandEventEntity? = rows[requestId]

    override fun getForSession(sessionId: String): List<CommandEventEntity> =
        rows.values.filter { it.sessionId == sessionId }.sortedBy { it.updatedAt }

    override fun updateCommandStatusByRequestId(
        requestId: String,
        status: String,
        resultJson: String?,
        now: Instant,
    ): Int {
        val row = rows[requestId] ?: return 0
        rows[requestId] = row.copy(status = status, resultJson = resultJson, updatedAt = now)
        return 1
    }
}

private class FakePendingLiveEventDao : PendingLiveEventDao {
    val rows = mutableListOf<PendingLiveEventEntity>()

    override fun bufferPendingEvent(event: PendingLiveEventEntity) {
        rows.removeAll { it.sessionId == event.sessionId && it.eventId == event.eventId }
        rows.add(event)
    }

    override fun getBufferedEvents(sessionId: String, afterEventId: Long): List<PendingLiveEventEntity> =
        rows.filter { it.sessionId == sessionId && it.eventId > afterEventId }.sortedBy { it.eventId }

    override fun deleteBufferedEvents(sessionId: String, afterEventId: Long): Int {
        val doomed = rows.filter { it.sessionId == sessionId && it.eventId > afterEventId }
        rows.removeAll(doomed.toSet())
        return doomed.size
    }

    override fun deleteBufferedEventsUpTo(sessionId: String, watermark: Long): Int {
        val doomed = rows.filter { it.sessionId == sessionId && it.eventId <= watermark }
        rows.removeAll(doomed.toSet())
        return doomed.size
    }

    override fun countForSession(sessionId: String): Int = rows.count { it.sessionId == sessionId }

    override fun clearForSession(sessionId: String) {
        rows.removeAll { it.sessionId == sessionId }
    }
}

/** Records commands and replays canned §8.3 responses in order. */
private class FakeCommandApi(private val responses: List<ProtocolResponse>) : BridgeCommandApi {
    val sent = mutableListOf<ProtocolCommand>()
    private var index = 0

    override suspend fun postCommand(command: ProtocolCommand): ProtocolResponse {
        sent.add(command)
        return responses[index++]
    }
}
