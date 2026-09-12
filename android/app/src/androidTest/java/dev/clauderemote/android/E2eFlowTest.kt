package dev.clauderemote.android

import androidx.room.Room
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.clauderemote.android.data.local.AppDatabase
import dev.clauderemote.android.data.local.Migrations
import dev.clauderemote.android.network.BridgeCredentials
import dev.clauderemote.android.network.ConnectionState
import dev.clauderemote.android.network.HttpBridgeApi
import dev.clauderemote.android.protocol.v1.EventId
import dev.clauderemote.android.protocol.v1.EventType
import dev.clauderemote.android.protocol.v1.ProtocolEvent
import dev.clauderemote.android.protocol.v1.SessionCreateCommand
import dev.clauderemote.android.protocol.v1.SessionCreatePayload
import dev.clauderemote.android.sync.BridgeSnapshotApi
import dev.clauderemote.android.sync.SessionRepository
import dev.clauderemote.android.sync.SnapshotApi
import dev.clauderemote.android.sync.SnapshotCommitResult
import dev.clauderemote.android.sync.SnapshotCoordinator
import dev.clauderemote.android.ui.ConversationItem
import dev.clauderemote.android.ui.ConversationViewModel
import dev.clauderemote.android.ui.MessageAction
import dev.clauderemote.android.ui.MessageBadge
import dev.clauderemote.android.ui.MainActivity
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * End-to-end instrumented verification (Task 33): the REAL app stack —
 * OkHttp transport, ConnectionCoordinator, SnapshotCoordinator, reducer,
 * Room projection, encrypted token store, Keystore device key, OAuthManager,
 * DeviceSessionManager, ConversationViewModel — runs UNCHANGED against an
 * embedded fake bridge ([E2eFakeBridgeServer]: MockWebServer over device
 * loopback speaking the actual protocol, with real ECDSA P-256 verification).
 *
 * Covered flows: §10.3 pairing + credential headers on every request, §8.2
 * session create/resume + message.send through §8.4 status transitions to a
 * rendered assistant message, §12.3 permission allow-once/deny-stops-turn,
 * §8.5/§11.1 redelivery of unacked events after a 4500 disconnect, §6.7/§11.1
 * 4410 snapshot recovery resuming from the checkpointed watermark, the two
 * §6.7 crash windows (death between the checkpoint tx and the commit; a 410
 * SNAPSHOT_EXPIRED commit), and a background→foreground round trip.
 */
@RunWith(AndroidJUnit4::class)
class E2eFlowTest {

    private lateinit var server: E2eFakeBridgeServer
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    /** Graphs/scopes/dbs created by the running test, torn down in [After]. */
    private val graphs = mutableListOf<AppGraph>()
    private val scopes = mutableListOf<CoroutineScope>()
    private val dbs = mutableListOf<AppDatabase>()

    @Before
    fun setUp() {
        server = E2eFakeBridgeServer()
        server.start()
    }

    @After
    fun tearDown() {
        for (graph in graphs) runCatching { graph.shutdown() }
        for (db in dbs) runCatching { db.close() }
        for (scope in scopes) runCatching { scope.cancel() }
        server.shutdown()
    }

    // -------------------------------------------------------------------
    // 1. Pairing + OAuth credentials ride every request
    // -------------------------------------------------------------------

    @Test
    fun pairing_enrollsKeystoreKey_andAccessTokenRidesEveryRequest() {
        val graph = newGraph()
        seedStaticCredentials(graph)

        // §10.3 pairing: the Keystore SPKI key is enrolled and the
        // server-recomputed deviceId matches the client's claim.
        runBlocking { graph.deviceSessions.pairDevice(PAIRING_TOKEN, "E2E Device") }
        assertEquals(1, server.pairRequests.size)
        assertTrue("server-recomputed deviceId must match the claim", server.deviceIdMatched == true)
        assertNotNull(server.enrolledDeviceId)

        // The connect loop runs the full challenge → sign → verify round trip
        // with a REAL ECDSA P-256 signature over buildSigningBytes.
        graph.start()
        awaitTrue { graph.coordinator.state.value == ConnectionState.CONNECTED }
        assertTrue("at least one verify must have run", server.verifyResults.isNotEmpty())
        assertTrue(
            "every signature must have verified",
            server.verifyResults.all { it.second },
        )

        // §10.2: the Access assertion rides EVERY HTTP request (pair,
        // challenge, verify, commands) and BOTH headers ride the WS Upgrade.
        assertTrue(
            "Authorization header must carry the seeded opaque Access token",
            server.httpCredentialHeaders.any { it.first == "Bearer $STATIC_ACCESS" },
        )
        assertTrue(
            "the WS Upgrade must carry the device-session token",
            server.httpCredentialHeaders.any { it.second == server.deviceSessionToken },
        )
    }

    // -------------------------------------------------------------------
    // 2. session.create / session.resume / message.send E2E
    // -------------------------------------------------------------------

    @Test
    fun messageSendFlowsThroughStatusTransitions_toRenderedAssistantMessage() {
        val graph = startedGraph()
        val vm = newViewModel(graph)

        // The session enters the projection as idle (bridge accepted create).
        server.emitEvent(ev(SESSION, EventType.SESSION_STATE_CHANGED, statusPayload("idle")))

        // §8.2 commands ride the live socket: create (via the graph seam the
        // session list uses) and resume (via the ViewModel seam).
        runBlocking {
            graph.sendCommand(
                SessionCreateCommand(
                    requestId = UUID.randomUUID().toString(),
                    idempotencyKey = UUID.randomUUID().toString(),
                    sentAt = Instant.now().toString(),
                    payload = SessionCreatePayload("e2e-project", "E2E Session"),
                ),
            )
        }
        assertEquals("session.create", commandTypeOf(server.awaitWsCommand { it.isCommand("session.create") }))
        vm.resume()
        assertEquals("session.resume", commandTypeOf(server.awaitWsCommand { it.isCommand("session.resume") }))

        // §12.2 send gate: idle ⇒ enabled.
        awaitTrue { vm.refresh(); vm.uiState.value.sendEnabled }

        vm.sendMessage("hello bridge")
        val sendCommand = server.awaitWsCommand { it.isCommand("message.send") }
        assertEquals(SESSION, sendCommand["payload"]!!.jsonObject["sessionId"]!!.jsonPrimitive.content)
        assertEquals("hello bridge", sendCommand["payload"]!!.jsonObject["text"]!!.jsonPrimitive.content)
        val requestId = sendCommand["requestId"]!!.jsonPrimitive.content

        // §8.4 status transitions on the correlation id.
        server.emitEvent(ev(SESSION, EventType.COMMAND_STATUS_CHANGED, cmdStatusPayload(requestId, "accepted")))
        awaitCommandStatus(graph, requestId, "accepted")
        server.emitEvent(ev(SESSION, EventType.COMMAND_STATUS_CHANGED, cmdStatusPayload(requestId, "dispatched")))
        awaitCommandStatus(graph, requestId, "dispatched")

        // The assistant turn streams, then finalizes under its stable UUID
        // (the streaming fallback row is dropped).
        server.emitEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_DELTA, deltaPayload("Hel")))
        server.emitEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_DELTA, deltaPayload("lo")))
        awaitTrue {
            vm.refresh()
            vm.uiState.value.items.filterIsInstance<ConversationItem.Text>()
                .any { it.role == "assistant" && it.text == "Hello" && it.streaming }
        }
        server.emitEvent(
            ev(SESSION, EventType.ASSISTANT_MESSAGE_COMPLETED, completedPayload("msg-a1", "Hello from assistant")),
        )
        awaitTrue {
            vm.refresh()
            val texts = vm.uiState.value.items.filterIsInstance<ConversationItem.Text>()
            texts.any { it.id == "msg-a1" && it.role == "assistant" && it.text == "Hello from assistant" && !it.streaming } &&
                texts.none { it.streaming }
        }

        // Terminal status finalizes the optimistic user row's badge.
        server.emitEvent(ev(SESSION, EventType.COMMAND_STATUS_CHANGED, cmdStatusPayload(requestId, "completed")))
        awaitTrue {
            vm.refresh()
            vm.uiState.value.items.filterIsInstance<ConversationItem.Text>()
                .first { it.requestId == requestId }.badge == MessageBadge.COMPLETED
        }
        // §8.5: everything applied and acked through the guarded pipeline.
        awaitTrue { server.ackWatermarks[SESSION] == 7L }
    }

    // -------------------------------------------------------------------
    // 3. Permission allow-once / deny-stops-turn
    // -------------------------------------------------------------------

    @Test
    fun permissionAllowExecutesOnce_andDenyStopsTheTurnWithResumeAffordance() {
        val graph = startedGraph()
        val vm = newViewModel(graph)
        server.emitEvent(ev(SESSION, EventType.SESSION_STATE_CHANGED, statusPayload("idle")))
        awaitTrue { vm.refresh(); vm.uiState.value.sendEnabled }

        // -- Turn 1: allow executes the tool exactly once -------------------
        vm.sendMessage("run the tool")
        server.awaitWsCommand { it.isCommand("message.send") }
        server.emitEvent(ev(SESSION, EventType.TOOL_STARTED, toolStartedPayload("tu-1")))
        server.emitEvent(ev(SESSION, EventType.PERMISSION_REQUESTED, permissionRequestedPayload("perm-1", "tu-1")))
        awaitTrue { vm.refresh(); vm.uiState.value.pendingPermission?.permissionRequestId == "perm-1" }
        assertEquals("Bash", vm.uiState.value.pendingPermission?.toolName)
        assertEquals("echo e2e", vm.uiState.value.pendingPermission?.commandOrPath)

        vm.allowPermission("perm-1")
        awaitTrue { permissionResolveCount("perm-1", "allow") == 1 }
        // The single resolution is the whole §12.3 contract: exactly one
        // permission.resolve for this prompt.
        Thread.sleep(500)
        assertEquals(1, permissionResolveCount("perm-1", "allow"))

        server.emitEvent(ev(SESSION, EventType.PERMISSION_RESOLVED, permissionResolvedPayload("perm-1", "allow_once")))
        server.emitEvent(ev(SESSION, EventType.TOOL_OUTPUT_DELTA, toolOutputDeltaPayload("tu-1", "tool says hi")))
        server.emitEvent(ev(SESSION, EventType.TOOL_COMPLETED, toolCompletedPayload("tu-1", "ok", "tool result")))
        awaitTrue {
            vm.refresh()
            vm.uiState.value.pendingPermission == null &&
                vm.uiState.value.items.filterIsInstance<ConversationItem.ToolCall>()
                    .any { it.id == "tu-1" && it.status == "complete" && it.output.contains("tool result") }
        }

        // -- Turn 2: deny stops the turn, leaving the resume affordance -----
        server.emitEvent(ev(SESSION, EventType.SESSION_STATE_CHANGED, statusPayload("idle")))
        awaitTrue { vm.refresh(); vm.uiState.value.sendEnabled }
        vm.sendMessage("run the denied tool")
        val send2 = server.awaitWsCommand {
            it.isCommand("message.send") && it["payload"]!!.jsonObject["text"]!!.jsonPrimitive.content == "run the denied tool"
        }
        val requestId2 = send2["requestId"]!!.jsonPrimitive.content
        server.emitEvent(ev(SESSION, EventType.TOOL_STARTED, toolStartedPayload("tu-2")))
        server.emitEvent(ev(SESSION, EventType.PERMISSION_REQUESTED, permissionRequestedPayload("perm-2", "tu-2")))
        awaitTrue { vm.refresh(); vm.uiState.value.pendingPermission?.permissionRequestId == "perm-2" }

        vm.denyPermission("perm-2")
        awaitTrue { permissionResolveCount("perm-2", "deny") == 1 }
        Thread.sleep(500)
        assertEquals(1, permissionResolveCount("perm-2", "deny"))

        server.emitEvent(ev(SESSION, EventType.PERMISSION_RESOLVED, permissionResolvedPayload("perm-2", "deny")))
        server.emitEvent(ev(SESSION, EventType.TOOL_COMPLETED, toolCompletedPayload("tu-2", "error", "denied")))
        // Deny stops the turn: the message.send lands INTERRUPTED and the
        // session surfaces interrupted with its §7.3 resume affordance.
        server.emitEvent(ev(SESSION, EventType.COMMAND_STATUS_CHANGED, cmdStatusPayload(requestId2, "interrupted")))
        server.emitEvent(ev(SESSION, EventType.SESSION_STATE_CHANGED, statusPayload("interrupted")))
        awaitTrue {
            vm.refresh()
            val row = vm.uiState.value.items.filterIsInstance<ConversationItem.Text>()
                .first { it.requestId == requestId2 }
            row.badge == MessageBadge.INTERRUPTED && MessageAction.RESUME in row.actions
        }
        awaitTrue { vm.refresh(); vm.uiState.value.session?.status == "interrupted" }
        assertFalse(vm.uiState.value.sendEnabled)
        assertTrue(vm.uiState.value.releaseEnabled)
    }

    // -------------------------------------------------------------------
    // 4. Disconnect → reconnect replays unacked events (§8.5/§11.1)
    // -------------------------------------------------------------------

    @Test
    fun disconnectReconnectReplaysUnackedEvents_aboveAckedWatermark() {
        val graph = startedGraph()
        server.emitEvent(ev(SESSION, EventType.SESSION_STATE_CHANGED, statusPayload("idle")))
        server.emitEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_DELTA, deltaPayload("live-")))
        // Applied and ACKed: the server watermark advances to 2.
        awaitTrue { server.ackWatermarks[SESSION] == 2L }
        assertEquals(2L, graph.db.sessionDao().getBySessionId(SESSION)!!.lastAckEventId)

        // §8.5 backlog: journal entries the socket never delivered.
        server.journalOnly(ev(SESSION, EventType.ASSISTANT_MESSAGE_DELTA, deltaPayload("replayed-")))
        server.journalOnly(ev(SESSION, EventType.ASSISTANT_MESSAGE_COMPLETED, completedPayload("msg-r1", "replayed result")))

        // 4500 transport failure → §11.1 backoff reconnect.
        server.closeLatestWs(4500, "transport boom")
        awaitTrue { server.wsConnections.get() >= 2 }
        awaitTrue { graph.coordinator.state.value == ConnectionState.CONNECTED }

        // The reconnect posts the checkpointed watermark as its resume marker…
        awaitTrue { server.latestWs!!.receivedAcks().any { it.first == SESSION && it.second == 2L } }
        // …and the bridge replays everything above it; the client applies and
        // re-ACKs the advanced position.
        awaitTrue {
            graph.db.messageDao().getForSession(SESSION)
                .any { it.historyItemId == "msg-r1" && it.status == "complete" }
        }
        awaitTrue { server.ackWatermarks[SESSION] == 4L }
        assertEquals(4L, graph.db.sessionDao().getBySessionId(SESSION)!!.lastAckEventId)
    }

    // -------------------------------------------------------------------
    // 5. 4410 → §6.7 snapshot recovery → resume from checkpointed watermark
    // -------------------------------------------------------------------

    @Test
    fun close4410_runsSnapshotRecovery_andResumesFromCheckpointedWatermark() {
        val graph = startedGraph()
        // Seed a stale live projection (events 1..3 applied and acked).
        server.emitEvent(ev(SESSION, EventType.SESSION_STATE_CHANGED, statusPayload("idle")))
        server.emitEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_DELTA, deltaPayload("stale live text")))
        server.emitEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_COMPLETED, completedPayload("msg-live", "stale")))
        awaitTrue { server.ackWatermarks[SESSION] == 3L }

        server.nextSnapshot = E2eFakeBridgeServer.SnapshotScript(
            snapshotId = "snap-4410",
            historyRevision = "rev-after-4410",
            items = listOf(
                E2eFakeBridgeServer.JournalItem("u-s1", "user", "checkpointed user"),
                E2eFakeBridgeServer.JournalItem("a-s1", "assistant", "checkpointed assistant"),
            ),
            deliveryBase = 3,
            deliveryWatermark = 3,
            sessionStatus = "running",
        )

        // 4410: park, run the §6.7 cycle, re-enter the connect loop.
        server.closeLatestWs(4410, "resync required")

        // The begin/page/commit cycle rode the HTTP command endpoint with the
        // real credentials and committed exactly once.
        awaitTrue { server.recordedCommits.size == 1 }
        val commit = server.recordedCommits.single()
        assertEquals(SESSION, commit.sessionId)
        assertEquals("snap-4410", commit.snapshotId)
        assertEquals(3L, commit.deliveryWatermark)
        assertEquals(200, commit.httpStatus)

        // The projection was rebuilt from the checkpointed history.
        awaitTrue {
            graph.db.messageDao().getForSession(SESSION).map { it.historyItemId } == listOf("u-s1", "a-s1")
        }
        assertEquals("running", graph.db.sessionDao().getBySessionId(SESSION)!!.status)
        // …the cursor equals the checkpointed watermark (not the stale one)…
        assertEquals(3L, graph.db.sessionDao().getBySessionId(SESSION)!!.lastAckEventId)
        // The pending row clears once the confirmed commit is processed.
        awaitTrue { graph.db.checkpointDao().getPendingCheckpoint() == null }
        // …and the reconnect's resume ACK carries that watermark.
        awaitTrue { server.wsConnections.get() >= 2 }
        awaitTrue { graph.coordinator.state.value == ConnectionState.CONNECTED }
        awaitTrue { server.latestWs!!.receivedAcks().any { it.first == SESSION && it.second == 3L } }
    }

    // -------------------------------------------------------------------
    // 6. Crash window: death between the checkpoint tx and the commit
    // -------------------------------------------------------------------

    @Test
    fun crashBetweenCommitTxAndCommit_retriesSameIdempotencyKey_andRefusesAckPastDeliveryBase() {
        val db = manualDb()
        val realApi = BridgeSnapshotApi(staticCredentialsApi())
        val crashApi = CrashingCommitApi(realApi)
        val acksBeforeRestart = CopyOnWriteArrayList<Pair<String, Long>>()
        val coordinator = SnapshotCoordinator(
            db = db,
            api = crashApi,
            ackSender = { sessionId, lastEventId -> acksBeforeRestart.add(sessionId to lastEventId) },
        )

        server.nextSnapshot = E2eFakeBridgeServer.SnapshotScript(
            snapshotId = "snap-crash",
            historyRevision = "rev-crash",
            items = listOf(E2eFakeBridgeServer.JournalItem("m-c1", "user", "crash-window user")),
            deliveryBase = 2,
            deliveryWatermark = 4,
            sessionStatus = "running",
        )

        // Run the cycle until the app "dies" ON the commit — after the Room
        // transaction wrote the projection AND the pending row.
        crashApi.crashOnCommit = true
        runCatching { runBlocking { coordinator.onResyncRequired(SESSION) } }
        val pending = awaitPendingCheckpoint(db)
        assertEquals(2L, pending.deliveryBase)
        assertEquals(4L, pending.deliveryWatermark)
        assertEquals("snap-crash", pending.snapshotId)

        // §6.7 step 5 while pending: a plain ACK may not pass deliveryBase —
        // it is refused locally and never sent.
        assertFalse(runBlocking { coordinator.acknowledge(SESSION, 5L) })
        assertTrue(acksBeforeRestart.isEmpty())
        // …and the live pipeline BUFFERS instead of applying/acking.
        val repository = SessionRepository(db = db, coordinator = coordinator)
        runBlocking {
            repository.handleEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_DELTA, deltaPayload("buffered"), id = 5))
        }
        assertEquals(1, db.pendingLiveEventDao().countForSession(SESSION))

        // "Process restart": a NEW coordinator over the SAME durable state
        // retries the commit with the SAME idempotency key.
        crashApi.crashOnCommit = false
        val acksAfterRestart = CopyOnWriteArrayList<Pair<String, Long>>()
        val restarted = SnapshotCoordinator(
            db = db,
            api = realApi,
            ackSender = { sessionId, lastEventId -> acksAfterRestart.add(sessionId to lastEventId) },
        )
        assertTrue(runBlocking { restarted.recoverPendingCheckpoints() })

        // Exactly ONE commit reached the bridge — the retried one, same key.
        assertEquals(1, server.recordedCommits.size)
        val retried = server.recordedCommits.single()
        assertEquals(pending.idempotencyKey, retried.idempotencyKey)
        assertEquals(200, retried.httpStatus)
        assertEquals(4L, retried.deliveryWatermark)

        // The pending row is cleared, the buffered event applies as the new
        // contiguous head, and only NOW does the ACK pass the old ceiling.
        awaitTrue { db.checkpointDao().getPendingCheckpoint() == null }
        awaitTrue {
            db.messageDao().getForSession(SESSION).any { it.historyItemId == "streaming-assistant:$SESSION" }
        }
        awaitTrue { acksAfterRestart.contains(SESSION to 5L) }
    }

    // -------------------------------------------------------------------
    // 7. Crash window: commit returns 410 SNAPSHOT_EXPIRED
    // -------------------------------------------------------------------

    @Test
    fun commit410_retainsCeiling_andFreshCycleSucceeds() {
        val db = manualDb()
        val realApi = BridgeSnapshotApi(staticCredentialsApi())
        val gateApi = SecondBeginGate(realApi)
        val acks = CopyOnWriteArrayList<Pair<String, Long>>()
        val coordinator = SnapshotCoordinator(
            db = db,
            api = gateApi,
            ackSender = { sessionId, lastEventId -> acks.add(sessionId to lastEventId) },
        )

        server.commitFailuresRemaining.set(1)
        server.enqueueScripts(
            E2eFakeBridgeServer.SnapshotScript(
                snapshotId = "snap-a",
                historyRevision = "rev-a",
                items = listOf(E2eFakeBridgeServer.JournalItem("m-a", "user", "stale item")),
                deliveryBase = 0,
                deliveryWatermark = 0,
                sessionStatus = "running",
            ),
            E2eFakeBridgeServer.SnapshotScript(
                snapshotId = "snap-b",
                historyRevision = "rev-b",
                items = listOf(
                    E2eFakeBridgeServer.JournalItem("m-b1", "user", "fresh one"),
                    E2eFakeBridgeServer.JournalItem("m-b2", "assistant", "fresh two"),
                ),
                deliveryBase = 1,
                deliveryWatermark = 3,
                sessionStatus = "running",
            ),
        )

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO).also { scopes.add(it) }
        val cycle = scope.launch { runCatching { coordinator.onResyncRequired(SESSION) } }

        // Attempt 1 wrote its transaction (pending row, deliveryBase 0), then
        // the commit 410'd; attempt 2's begin is held at the gate, so the OLD
        // row still pins the ACK ceiling.
        awaitTrue { db.checkpointDao().getPendingCheckpoint() != null }
        awaitTrue { server.recordedCommits.any { it.httpStatus == 410 } }
        assertEquals(0L, db.checkpointDao().getPendingCheckpoint()!!.deliveryBase)
        assertFalse(runBlocking { coordinator.acknowledge(SESSION, 1L) })
        assertTrue(acks.isEmpty())
        // Live events still buffer instead of applying.
        val repository = SessionRepository(db = db, coordinator = coordinator)
        runBlocking {
            repository.handleEvent(
                ev(SESSION, EventType.ASSISTANT_MESSAGE_DELTA, deltaPayload("obsolete"), id = 1),
            )
        }
        assertEquals(1, db.pendingLiveEventDao().countForSession(SESSION))

        // Release the fresh cycle: new begin → REVISION REPLACE → commit 200.
        gateApi.releaseSecondBegin()
        awaitTrue { server.recordedCommits.any { it.httpStatus == 200 } }
        awaitTrue { !cycle.isActive }

        // Two commits, DIFFERENT idempotency keys (410 then fresh success).
        assertEquals(2, server.recordedCommits.size)
        assertEquals(410, server.recordedCommits[0].httpStatus)
        assertEquals(200, server.recordedCommits[1].httpStatus)
        assertNotEquals(server.recordedCommits[0].idempotencyKey, server.recordedCommits[1].idempotencyKey)

        // The stale projection was discarded for the fresh snapshot's…
        awaitTrue {
            db.messageDao().getForSession(SESSION).map { it.historyItemId } == listOf("m-b1", "m-b2")
        }
        // …the cursor equals the fresh watermark, the pending row is gone…
        assertEquals(3L, db.sessionDao().getBySessionId(SESSION)!!.lastAckEventId)
        awaitTrue { db.checkpointDao().getPendingCheckpoint() == null }
        // …and the buffered-below-watermark event was SUPERSEDED (§6.7:
        // dropped by the commit, never applied).
        assertTrue(db.messageDao().getForSession(SESSION).none { it.historyItemId == "streaming-assistant:$SESSION" })
        assertEquals(0, db.pendingLiveEventDao().countForSession(SESSION))
    }

    // -------------------------------------------------------------------
    // 8. Backgrounded → foregrounded round trip
    // -------------------------------------------------------------------

    @Test
    fun backgroundForegroundRoundTrip_preservesProjection_andStaysLive() {
        val graph = newGraph()
        seedStaticCredentials(graph)
        runBlocking { graph.deviceSessions.pairDevice(PAIRING_TOKEN, "E2E Device") }

        // Swap the REAL application's graph for the fake-bridge graph before
        // the activity exists (the production onCreate graph is shut down).
        val app = context.applicationContext as ClaudeRemoteApp
        app.replaceGraphForTesting(graph)
        awaitTrue { graph.coordinator.state.value == ConnectionState.CONNECTED }

        server.emitEvent(ev(SESSION, EventType.SESSION_STATE_CHANGED, statusPayload("idle")))
        server.emitEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_DELTA, deltaPayload("before-")))
        server.emitEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_COMPLETED, completedPayload("msg-live", "before recreation")))
        awaitTrue { server.ackWatermarks[SESSION] == 3L }

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            // Backgrounded, foregrounded, then a configuration-style recreate.
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.STARTED)
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            scenario.recreate()

            // The application (and therefore the graph, its scopes, the
            // socket, and the projection) survived the round trip.
            scenario.onActivity { activity ->
                assertSame(graph, (activity.application as ClaudeRemoteApp).graph)
            }
        }
        assertEquals(1, graph.sessionSnapshots().size)
        assertEquals(SESSION, graph.sessionSnapshots().single().sessionId)

        // Still live after the round trip: new contiguous events land and ack.
        server.emitEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_DELTA, deltaPayload("after-")))
        server.emitEvent(ev(SESSION, EventType.ASSISTANT_MESSAGE_COMPLETED, completedPayload("msg-post", "after recreation")))
        awaitTrue {
            graph.db.messageDao().getForSession(SESSION).any { it.historyItemId == "msg-post" && it.status == "complete" }
        }
        awaitTrue { server.ackWatermarks[SESSION] == 5L }

        // Restore the application's own (null) graph ownership for later tests.
        app.shutdownGraphForTesting()
    }

    // -------------------------------------------------------------------
    // Harness helpers
    // -------------------------------------------------------------------

    /** Builds a graph against the fake bridge with a fresh Room database. */
    private fun newGraph(): AppGraph {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO).also { scopes.add(it) }
        val graph = AppGraph.build(
            context = context,
            endpoints = BridgeEndpoints.of(server.baseUrl()),
            dbName = "e2e-flow-${UUID.randomUUID()}.db",
            applicationScope = scope,
        )
        graphs.add(graph)
        dbs.add(graph.db)
        return graph
    }

    /** Static opaque Access token + refresh token in the REAL encrypted store. */
    private fun seedStaticCredentials(graph: AppGraph) {
        graph.tokenStore.clearAll()
        graph.tokenStore.putAccessToken(STATIC_ACCESS, null)
        graph.tokenStore.putRefreshToken("e2e-refresh-token")
    }

    /** Graph paired, started, and CONNECTED to the fake bridge. */
    private fun startedGraph(): AppGraph {
        val graph = newGraph()
        seedStaticCredentials(graph)
        runBlocking { graph.deviceSessions.pairDevice(PAIRING_TOKEN, "E2E Device") }
        graph.start()
        awaitTrue { graph.coordinator.state.value == ConnectionState.CONNECTED }
        return graph
    }

    /** The ViewModel over the graph's real repository/command/expiry seams. */
    private fun newViewModel(graph: AppGraph): ConversationViewModel {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO).also { scopes.add(it) }
        return ConversationViewModel(
            sessionId = SESSION,
            repository = graph.conversationRepository,
            commandSender = graph.sendCommand,
            expirySource = graph.tokenExpirySource,
            scope = scope,
        )
    }

    /** Room over a fresh file, assembled manually for the crash-window tests. */
    private fun manualDb(): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, "e2e-flow-${UUID.randomUUID()}.db")
            .addMigrations(*Migrations.ALL)
            .allowMainThreadQueries()
            .build()
            .also { dbs.add(it) }

    /** Commands API with static credentials (auth is not these tests' subject). */
    private fun staticCredentialsApi(): HttpBridgeApi = HttpBridgeApi(
        baseUrl = server.baseUrl(),
        credentialsProvider = { BridgeCredentials(STATIC_ACCESS, server.deviceSessionToken) },
    )

    private fun awaitPendingCheckpoint(db: AppDatabase): dev.clauderemote.android.data.local.CheckpointCommitPendingEntity {
        awaitTrue { db.checkpointDao().getPendingCheckpoint() != null }
        return db.checkpointDao().getPendingCheckpoint()!!
    }

    private fun awaitCommandStatus(graph: AppGraph, requestId: String, status: String) {
        awaitTrue {
            graph.db.commandEventDao().getForSession(SESSION).any { it.requestId == requestId && it.status == status }
        }
    }

    private fun permissionResolveCount(permissionRequestId: String, decision: String): Int =
        (server.latestWs?.receivedCommands() ?: emptyList())
            .count { command ->
                command.isCommand("permission.resolve") &&
                    command["payload"]!!.jsonObject["permissionRequestId"]!!.jsonPrimitive.content == permissionRequestId &&
                    command["payload"]!!.jsonObject["decision"]!!.jsonPrimitive.content == decision
            }

    private fun commandTypeOf(command: JsonObject): String? =
        command["commandType"]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.isCommand(type: String): Boolean = commandTypeOf(this) == type

    /** Polls [condition] at 100 ms until it holds (default 20 s budget). */
    private fun awaitTrue(timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (runCatching(condition).getOrDefault(false)) return
            Thread.sleep(100)
        }
        throw AssertionError("condition not met within ${timeoutMs}ms")
    }

    // -------------------------------------------------------------------
    // Event/payload builders (§8.4 wire shapes)
    // -------------------------------------------------------------------

    private val eventIds = AtomicLong(0)

    private fun ev(sessionId: String, type: EventType, payload: JsonObject, id: Long = eventIds.incrementAndGet()) =
        ProtocolEvent(
            eventId = EventId(id),
            sessionId = sessionId,
            eventType = type,
            timestamp = Instant.now().toString(),
            payload = payload,
        )

    private fun statusPayload(status: String) = buildJsonObject { put("status", status) }

    private fun cmdStatusPayload(requestId: String, status: String) = buildJsonObject {
        put("requestId", requestId)
        put("idempotencyKey", requestId)
        put("commandType", "message.send")
        put("commandStatus", status)
    }

    private fun deltaPayload(text: String) = buildJsonObject {
        put(
            "frame",
            buildJsonObject {
                put("type", "content_block_delta")
                put(
                    "delta",
                    buildJsonObject {
                        put("type", "text_delta")
                        put("text", text)
                    },
                )
            },
        )
    }

    private fun completedPayload(messageUuid: String, text: String) = buildJsonObject {
        put("messageUuid", messageUuid)
        put(
            "message",
            buildJsonObject {
                put(
                    "content",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("type", "text")
                                put("text", text)
                            },
                        )
                    },
                )
            },
        )
    }

    private fun toolStartedPayload(toolUseId: String) = buildJsonObject {
        put("toolUseId", toolUseId)
        put("toolName", "Bash")
        put("input", buildJsonObject { put("command", "echo e2e") })
    }

    private fun toolOutputDeltaPayload(toolUseId: String, chunk: String) = buildJsonObject {
        put("toolUseId", toolUseId)
        put("delta", chunk)
    }

    private fun toolCompletedPayload(toolUseId: String, status: String, output: String) = buildJsonObject {
        put("toolUseId", toolUseId)
        put("status", status)
        put("output", output)
    }

    private fun permissionRequestedPayload(permissionRequestId: String, toolUseId: String) = buildJsonObject {
        put("permissionRequestId", permissionRequestId)
        put("toolName", "Bash")
        put("input", buildJsonObject { put("command", "echo e2e") })
        put("toolUseId", toolUseId)
        put("requestedAt", Instant.now().toString())
        put("expiresAt", Instant.now().plusSeconds(300).toString())
        put("displayCategory", "command")
    }

    private fun permissionResolvedPayload(permissionRequestId: String, behavior: String) = buildJsonObject {
        put("permissionRequestId", permissionRequestId)
        put("behavior", behavior)
    }

    // -------------------------------------------------------------------
    // Crash-window doubles
    // -------------------------------------------------------------------

    /** Thrown where the process would die: after the Room tx, mid-commit. */
    private class SimulatedProcessDeath :
        RuntimeException("simulated process death between the checkpoint transaction and the commit")

    /** [SnapshotApi] that dies on (the first) commit when armed. */
    private class CrashingCommitApi(private val inner: SnapshotApi) : SnapshotApi by inner {
        var crashOnCommit = false

        override suspend fun commit(
            sessionId: String,
            snapshotId: String,
            historyRevision: String,
            deliveryWatermark: Long,
            idempotencyKey: String,
        ): SnapshotCommitResult {
            if (crashOnCommit) throw SimulatedProcessDeath()
            return inner.commit(sessionId, snapshotId, historyRevision, deliveryWatermark, idempotencyKey)
        }
    }

    /**
     * [SnapshotApi] that suspends the SECOND begin until the test releases
     * it, holding the recovery between the 410 and the fresh cycle so the
     * retained ACK ceiling is observable.
     */
    private class SecondBeginGate(private val inner: SnapshotApi) : SnapshotApi by inner {
        private var begins = 0
        private val gate = CompletableDeferred<Unit>()

        override suspend fun begin(sessionId: String): dev.clauderemote.android.sync.SnapshotBeginResult {
            if (++begins == 2) gate.await()
            return inner.begin(sessionId)
        }

        fun releaseSecondBegin() {
            gate.complete(Unit)
        }
    }

    private companion object {
        const val SESSION = "e2e-session-1"
        const val PAIRING_TOKEN = "e2e-pairing-token"
        const val STATIC_ACCESS = "e2e-static-access-token"
    }
}
