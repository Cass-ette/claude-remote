package dev.clauderemote.android.network

import dev.clauderemote.android.auth.ReLoginRequiredError
import dev.clauderemote.android.protocol.v1.EventId
import dev.clauderemote.android.protocol.v1.EventsAckCommand
import dev.clauderemote.android.protocol.v1.PROTOCOL_VERSION
import dev.clauderemote.android.protocol.v1.ProtocolCommand
import dev.clauderemote.android.protocol.v1.ProtocolEvent
import dev.clauderemote.android.protocol.v1.ProtocolJson
import dev.clauderemote.android.protocol.v1.ResponseType
import dev.clauderemote.android.protocol.v1.SessionListCommand
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * JVM unit tests for the App<->Bridge transport layer (spec §8.1, §11.1):
 *
 * - every HTTP request and every WebSocket Upgrade carries BOTH credentials
 *   (`Authorization: Bearer <access>` plus the device-session header), and
 *   the Upgrade negotiates the `claude-remote.v1` subprotocol;
 * - §8.3 response parsing maps the typed error outcomes (409
 *   IDEMPOTENCY_CONFLICT, 410 SNAPSHOT_EXPIRED, 503 STORAGE_PRESSURE, 401/403
 *   auth) instead of leaking raw HTTP;
 * - the ConnectionCoordinator policy per §8.1 close code: 4401 refreshes
 *   Access THEN the device session THEN opens a new socket inside ONE mutex
 *   (nothing sends or consumes events meanwhile); 4403/4426 stop reconnecting
 *   and surface the re-pair/upgrade UI signals; 4409 surfaces the conflict;
 *   4410 parks reconnect and never ACKs past the resync point; 4500 and
 *   connect failures back off exponentially with jitter, capped;
 * - every (re)connect posts the last continuously consumed eventId per
 *   session (the §11.1 resume-from marker) as an events.ack command.
 *
 * The coordinator is driven entirely through fakes (transport, credential
 * source, delayer, jitter, clock); the OkHttp layer is exercised only through
 * its pure request/response builder seams (Task 33 covers the live wire).
 */
class ConnectionCoordinatorTest {

    // -------------------------------------------------------------------
    // HTTP request shape (§10.2: both headers on every request)
    // -------------------------------------------------------------------

    @Test
    fun httpCommandRequest_carriesBothAuthHeaders() {
        val request = buildCommandHttpRequest(
            baseUrl = "https://bridge.example.com",
            command = sessionListCommand(),
            credentials = BridgeCredentials(accessToken = "access-1", deviceSessionToken = "session-1"),
        )

        assertEquals("POST", request.method)
        assertEquals("https://bridge.example.com/api/v1/commands", request.url.toString())
        assertEquals("Bearer access-1", request.header(BridgeHeaders.AUTHORIZATION))
        assertEquals("session-1", request.header(BridgeHeaders.DEVICE_SESSION))
        // OkHttp canonicalizes the JSON media type with charset=utf-8.
        assertEquals("application/json", request.body!!.contentType()!!.let { "${it.type}/${it.subtype}" })
        val body = okio.Buffer().apply { request.body!!.writeTo(this) }.readUtf8()
        assertEquals(
            ProtocolJson.json.encodeToString(ProtocolCommand.serializer(), sessionListCommand()),
            body,
        )
    }

    @Test
    fun webSocketUpgradeRequest_carriesBothAuthHeadersAndSubprotocol() {
        val request = buildUpgradeRequest(
            wsUrl = "wss://bridge.example.com/api/v1/ws",
            credentials = BridgeCredentials(accessToken = "access-1", deviceSessionToken = "session-1"),
        )

        // OkHttp normalizes ws/wss to http/https internally; the Upgrade rides it.
        assertEquals("https://bridge.example.com/api/v1/ws", request.url.toString())
        assertEquals("Bearer access-1", request.header(BridgeHeaders.AUTHORIZATION))
        assertEquals("session-1", request.header(BridgeHeaders.DEVICE_SESSION))
        assertEquals(PROTOCOL_VERSION, request.header(BridgeHeaders.WEBSOCKET_PROTOCOL))
    }

    // -------------------------------------------------------------------
    // §8.3 response parsing / typed error mapping
    // -------------------------------------------------------------------

    @Test
    fun parseCommandResponse_successEnvelopeDecodesFields() {
        val body = """
            {
              "protocolVersion": "claude-remote.v1",
              "requestId": "00000000-0000-4000-8000-000000000009",
              "responseType": "command.status",
              "commandStatus": "accepted"
            }
        """.trimIndent()
        val response = parseCommandResponse(200, body)

        assertEquals("00000000-0000-4000-8000-000000000009", response.requestId)
        assertEquals(ResponseType.COMMAND_STATUS, response.responseType)
        assertEquals(dev.clauderemote.android.protocol.v1.CommandStatus.ACCEPTED, response.commandStatus)
    }

    @Test
    fun parseCommandResponse_auth401IsUniformAndTyped() {
        // §10.3: the 401 body never says which check failed; neither do we.
        try {
            parseCommandResponse(401, """{"error": "unauthorized"}""")
            fail("expected AuthExpiredError")
        } catch (expected: AuthExpiredError) {
            // typed auth-expiry — the caller refreshes and retries once
        }
    }

    @Test
    fun parseCommandResponse_forbidden403IsTyped() {
        try {
            parseCommandResponse(403, """{"error": "forbidden"}""")
            fail("expected ForbiddenError")
        } catch (expected: ForbiddenError) {
            // re-pair / re-login territory
        }
    }

    @Test
    fun parseCommandResponse_idempotencyConflictIsTyped() {
        val body = """
            {
              "protocolVersion": "claude-remote.v1",
              "requestId": "00000000-0000-4000-8000-000000000010",
              "responseType": "command.error",
              "error": {
                "code": "IDEMPOTENCY_CONFLICT",
                "message": "idempotencyKey k was used with a different payload",
                "retryable": false
              }
            }
        """.trimIndent()
        try {
            parseCommandResponse(409, body)
            fail("expected IdempotencyConflictError")
        } catch (expected: IdempotencyConflictError) {
            // the conflicting command must NOT be retried
        }
    }

    @Test
    fun parseCommandResponse_snapshotExpiredCarriesRetryable() {
        val body = """
            {
              "protocolVersion": "claude-remote.v1",
              "requestId": "00000000-0000-4000-8000-000000000011",
              "responseType": "command.error",
              "error": { "code": "SNAPSHOT_EXPIRED", "message": "snapshot ttl exceeded", "retryable": true }
            }
        """.trimIndent()
        try {
            parseCommandResponse(410, body)
            fail("expected SnapshotExpiredError")
        } catch (expected: SnapshotExpiredError) {
            assertTrue("a fresh begin is always possible", expected.retryable)
        }
    }

    @Test
    fun parseCommandResponse_storagePressureCarriesRetryable() {
        val body = """
            {
              "protocolVersion": "claude-remote.v1",
              "requestId": "00000000-0000-4000-8000-000000000012",
              "responseType": "command.error",
              "error": {
                "code": "STORAGE_PRESSURE",
                "message": "pending events are at the storage budget",
                "retryable": true
              }
            }
        """.trimIndent()
        try {
            parseCommandResponse(503, body)
            fail("expected StoragePressureError")
        } catch (expected: StoragePressureError) {
            assertTrue("retryable once the consumer ACKs and the sweep frees bytes", expected.retryable)
        }
    }

    @Test
    fun parseCommandResponse_otherStructuredErrorsKeepCodeAndRetryable() {
        val body = """
            {
              "protocolVersion": "claude-remote.v1",
              "requestId": "00000000-0000-4000-8000-000000000013",
              "responseType": "command.error",
              "error": { "code": "CHECKPOINT_COMMIT_REQUIRED", "message": "commit first", "retryable": false }
            }
        """.trimIndent()
        try {
            parseCommandResponse(409, body)
            fail("expected BridgeCommandError")
        } catch (expected: BridgeCommandError) {
            assertEquals("CHECKPOINT_COMMIT_REQUIRED", expected.code)
            assertEquals(409, expected.httpStatus)
            assertEquals(false, expected.retryable)
        }
    }

    @Test
    fun parseCommandResponse_unparseableBodySurfacesHttpStatus() {
        try {
            parseCommandResponse(502, "<html>bad gateway</html>")
            fail("expected BridgeHttpException")
        } catch (expected: BridgeHttpException) {
            assertEquals(502, expected.httpStatus)
        }
    }

    // -------------------------------------------------------------------
    // Backoff (§11.1: exponential with jitter, capped)
    // -------------------------------------------------------------------

    @Test
    fun backoffDelayMs_doublesFromOneSecondAndCapsAtSixty() {
        assertEquals(1_000L, ConnectionCoordinator.backoffDelayMs(0, jitterFraction = 0.0))
        assertEquals(2_000L, ConnectionCoordinator.backoffDelayMs(1, jitterFraction = 0.0))
        assertEquals(4_000L, ConnectionCoordinator.backoffDelayMs(2, jitterFraction = 0.0))
        assertEquals(32_000L, ConnectionCoordinator.backoffDelayMs(5, jitterFraction = 0.0))
        assertEquals(ConnectionCoordinator.MAX_BACKOFF_MS, ConnectionCoordinator.backoffDelayMs(6, jitterFraction = 0.0))
        assertEquals(ConnectionCoordinator.MAX_BACKOFF_MS, ConnectionCoordinator.backoffDelayMs(20, jitterFraction = 0.0))
    }

    @Test
    fun backoffDelayMs_jitterIsBoundedFractionOfTheExponentialTerm() {
        // jitter adds at most a fraction of the exponential delay and can
        // never push the result past the cap.
        assertEquals(1_900L, ConnectionCoordinator.backoffDelayMs(0, jitterFraction = 0.9))
        assertEquals(7_600L, ConnectionCoordinator.backoffDelayMs(2, jitterFraction = 0.9))
        assertEquals(ConnectionCoordinator.MAX_BACKOFF_MS, ConnectionCoordinator.backoffDelayMs(20, jitterFraction = 0.99))
        assertEquals(1_000L, ConnectionCoordinator.backoffDelayMs(0, jitterFraction = 0.0))
    }

    @Test
    fun connectFailuresBackOffExponentiallyThenStayCapped() = runBlocking {
        val fixture = Fixture()
        fixture.transport.failNextConnects = 8

        fixture.coordinator.start()

        // 1s, 2s, 4s, 8s, 16s, 32s, then the 64s term is capped to 60s.
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L),
            fixture.delays,
        )
        assertEquals(ConnectionState.CONNECTED, fixture.coordinator.state.value)
        // Only the successful 9th attempt produced a socket.
        assertEquals(1, fixture.transport.sockets.size)
        fixture.shutdown()
    }

    @Test
    fun close4500OnUnstableConnectionsBacksOffExponentially() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()

        // Each 4500 close happens immediately after the (re)connect, i.e.
        // before CONNECT_STABILITY_MS elapses, so the delay grows.
        repeat(3) { fixture.transport.serverClose(BridgeCloseCode.INTERNAL_ERROR, "internal error") }

        assertEquals(listOf(1_000L, 2_000L, 4_000L), fixture.delays)
        assertEquals(4, fixture.transport.sockets.size)
        assertEquals(ConnectionState.CONNECTED, fixture.coordinator.state.value)
        fixture.shutdown()
    }

    @Test
    fun stableConnectionResetsTheBackoffCounter() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()

        // A connection that stayed up for minutes is "stable": the next
        // reconnect starts the ladder from 1s again, not from the top.
        fixture.nowMs += 5 * 60_000
        fixture.transport.serverClose(BridgeCloseCode.INTERNAL_ERROR, "internal error")
        fixture.nowMs += 5 * 60_000
        fixture.transport.serverClose(BridgeCloseCode.INTERNAL_ERROR, "internal error")

        assertEquals(listOf(1_000L, 1_000L), fixture.delays)
        fixture.shutdown()
    }

    // -------------------------------------------------------------------
    // §8.1 close-code policy
    // -------------------------------------------------------------------

    @Test
    fun start_connectsWithCurrentCredentialsAndReachesConnected() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()

        assertEquals(ConnectionState.CONNECTED, fixture.coordinator.state.value)
        assertEquals(1, fixture.transport.sockets.size)
        assertEquals(
            BridgeCredentials(accessToken = "access-1", deviceSessionToken = "session-1"),
            fixture.transport.lastCredentials,
        )
        fixture.shutdown()
    }

    @Test
    fun close4401_refreshesAccessThenDeviceSessionThenOpensNewSocketInThatOrder() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()

        fixture.transport.serverClose(BridgeCloseCode.AUTH_INVALID, "device session expired")

        // §11.1, strictly sequential, one critical section: OAuth refresh →
        // fresh device session (challenge → sign → verify) → NEW socket.
        assertEquals(
            listOf("current", "connect", "access-refresh", "device-session", "connect"),
            fixture.log,
        )
        assertEquals(2, fixture.transport.sockets.size)
        assertEquals(
            BridgeCredentials(accessToken = "access-2", deviceSessionToken = "session-2"),
            fixture.transport.lastCredentials,
        )
        assertEquals(ConnectionState.CONNECTED, fixture.coordinator.state.value)
        // No backoff delay — the reconnect is immediate on fresh credentials.
        assertTrue(fixture.delays.isEmpty())
        fixture.shutdown()
    }

    @Test
    fun close4401_criticalSectionExcludesSendsAndEventConsumption() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()
        val oldListener = fixture.transport.listener!!

        // Park the Access refresh mid-critical-section.
        fixture.source.accessRefreshGate = CompletableDeferred()
        fixture.transport.serverClose(BridgeCloseCode.AUTH_INVALID, "device session expired")
        assertEquals(
            listOf("current", "connect", "access-refresh"),
            fixture.log,
        )

        // A concurrent send must NOT proceed on the dying/old socket...
        val command = sessionListCommand()
        val sendJob = fixture.scope.async { fixture.coordinator.send(command) }
        assertTrue("send() must block while the refresh critical section runs", sendJob.isActive)
        // ...and an inbound event from the old socket must not be consumed...
        oldListener.onSocketMessage(eventJson(eventId = 7))
        assertTrue("event processing must block while the refresh critical section runs", fixture.eventsSeen.isEmpty())

        // Release the gate: refresh finishes, the new socket opens, THEN the
        // queued send and the queued event proceed (in mutex order).
        fixture.source.accessRefreshGate!!.complete(Unit)

        assertTrue(sendJob.isCompleted)
        assertEquals(
            listOf("current", "connect", "access-refresh", "device-session", "connect", "send:1"),
            fixture.log,
        )
        // The send landed on the NEW socket, serialized after the reconnect.
        assertEquals(
            listOf(ProtocolJson.json.encodeToString(ProtocolCommand.serializer(), command)),
            fixture.transport.sockets[1].sentTexts,
        )
        // The old socket's event was consumed only after the critical section.
        assertEquals(listOf(EventId(7)), fixture.eventsSeen.map { it.eventId })
        assertEquals(ConnectionState.CONNECTED, fixture.coordinator.state.value)
        fixture.shutdown()
    }

    @Test
    fun close4403_stopsReconnectingAndSurfacesRePair() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()

        fixture.transport.serverClose(BridgeCloseCode.FORBIDDEN, "another device is already connected")

        assertEquals(listOf<CoordinatorSignal>(CoordinatorSignal.ReAuthenticationRequired), fixture.signalsSeen)
        assertEquals(ConnectionState.STOPPED, fixture.coordinator.state.value)
        assertEquals("no reconnect may be attempted", 1, fixture.transport.sockets.size)
        assertTrue(fixture.delays.isEmpty())
        fixture.shutdown()
    }

    @Test
    fun close4409_surfacesTheConflictAndReconnects() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()

        fixture.transport.serverClose(BridgeCloseCode.SESSION_CONFLICT, "session write conflict")

        val conflict = fixture.signalsSeen.filterIsInstance<CoordinatorSignal.SessionConflict>().single()
        assertEquals("session write conflict", conflict.reason)
        // The conflicting COMMAND is not retried here (the repository reacts to
        // the signal); the socket itself reconnects to keep other delivery going.
        assertEquals(2, fixture.transport.sockets.size)
        assertEquals(ConnectionState.CONNECTED, fixture.coordinator.state.value)
        fixture.shutdown()
    }

    @Test
    fun close4410_parksReconnectAndNeverAcksPastTheResyncPoint() = runBlocking {
        val fixture = Fixture(ackPositions = mapOf(SESSION_ID to 5L))
        fixture.coordinator.start()
        // The initial connect posted exactly the one resume ACK.
        assertEquals(1, fixture.transport.sockets[0].sentTexts.size)

        fixture.transport.serverClose(BridgeCloseCode.RESYNC_REQUIRED, "event protocol version is incompatible")

        assertTrue(fixture.signalsSeen.contains(CoordinatorSignal.ResyncRequired))
        // No auto-reconnect and, critically, no events.ack past the resync:
        // the SnapshotCoordinator (Task 31) owns begin/page/commit and the
        // re-entry via start().
        assertEquals(1, fixture.transport.sockets.size)
        assertEquals("no ACK may be posted after a 4410", 1, fixture.transport.sockets[0].sentTexts.size)
        assertEquals(ConnectionState.DISCONNECTED, fixture.coordinator.state.value)

        // Resync done (Task 31): re-entry reconnects and re-posts the marker.
        fixture.coordinator.start()
        assertEquals(2, fixture.transport.sockets.size)
        assertEquals(1, fixture.transport.sockets[1].sentTexts.size)
        fixture.shutdown()
    }

    @Test
    fun close4426_surfacesUpgradeRequiredAndStops() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()

        fixture.transport.serverClose(BridgeCloseCode.PROTOCOL_INCOMPATIBLE, "unsupported protocol version")

        assertEquals(listOf<CoordinatorSignal>(CoordinatorSignal.UpgradeRequired), fixture.signalsSeen)
        assertEquals(ConnectionState.STOPPED, fixture.coordinator.state.value)
        assertEquals("no reconnect may be attempted", 1, fixture.transport.sockets.size)
        fixture.shutdown()
    }

    @Test
    fun deadRefreshToken_surfacesReLoginInsteadOfLooping() = runBlocking {
        val fixture = Fixture()
        fixture.source.failCurrentCredentialsWith = ReLoginRequiredError("no stored refresh token")

        fixture.coordinator.start()

        assertEquals(listOf<CoordinatorSignal>(CoordinatorSignal.ReAuthenticationRequired), fixture.signalsSeen)
        assertEquals(ConnectionState.STOPPED, fixture.coordinator.state.value)
        assertTrue("a dead credential source must not enter the backoff loop", fixture.delays.isEmpty())
        fixture.shutdown()
    }

    // -------------------------------------------------------------------
    // Resume-from (§11.1: reconnect posts the last continuous eventId)
    // -------------------------------------------------------------------

    @Test
    fun everyConnectPostsResumeAcksForEachSessionAsDecimalStrings() = runBlocking {
        val otherSession = "22222222-2222-4222-8222-222222222222"
        val fixture = Fixture(ackPositions = mapOf(SESSION_ID to 5L, otherSession to 42L))
        fixture.coordinator.start()

        val firstAcks = decodeAckCommands(fixture.transport.sockets[0].sentTexts)
        assertEquals(2, firstAcks.size)
        assertTrue(firstAcks.any { it.payload.sessionId == SESSION_ID && it.payload.lastEventId == 5L })
        assertTrue(firstAcks.any { it.payload.sessionId == otherSession && it.payload.lastEventId == 42L })
        // eventId rides the wire as a decimal string (§8.4).
        assertTrue(fixture.transport.sockets[0].sentTexts.any { it.contains("\"lastEventId\":\"5\"") })
        assertTrue(fixture.transport.sockets[0].sentTexts.any { it.contains("\"lastEventId\":\"42\"") })

        // Reconnect (stable normal close): both markers are posted again so
        // the bridge's device watermark skips at/below them on replay.
        fixture.nowMs += 5 * 60_000
        fixture.transport.serverClose(1000, "server restart")
        assertEquals(2, fixture.transport.sockets.size)
        assertEquals(2, decodeAckCommands(fixture.transport.sockets[1].sentTexts).size)
        fixture.shutdown()
    }

    // -------------------------------------------------------------------
    // send / inbound parsing / lifecycle
    // -------------------------------------------------------------------

    @Test
    fun send_serializesTheCommandWithProtocolJson() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()
        val command = sessionListCommand(requestId = "00000000-0000-4000-8000-000000000021")

        fixture.coordinator.send(command)

        assertEquals(
            listOf(ProtocolJson.json.encodeToString(ProtocolCommand.serializer(), command)),
            fixture.transport.sockets[0].sentTexts,
        )
        fixture.shutdown()
    }

    @Test
    fun send_whenDisconnectedThrowsNotConnected() = runBlocking {
        val fixture = Fixture()
        try {
            fixture.coordinator.send(sessionListCommand())
            fail("expected NotConnectedError")
        } catch (expected: NotConnectedError) {
            // callers wait for state CONNECTED (or retry after reconnect)
        }
        fixture.shutdown()
    }

    @Test
    fun inboundMessages_areParsedIntoEventAndResponseFlows() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()

        fixture.transport.deliver(eventJson(eventId = 7))
        fixture.transport.deliver(
            """
            {
              "protocolVersion": "claude-remote.v1",
              "requestId": "00000000-0000-4000-8000-000000000030",
              "responseType": "command.status",
              "commandStatus": "accepted"
            }
            """.trimIndent(),
        )

        val event: ProtocolEvent = fixture.eventsSeen.single()
        assertEquals(EventId(7), event.eventId)
        assertEquals(SESSION_ID, event.sessionId)
        assertEquals(dev.clauderemote.android.protocol.v1.EventType.SESSION_STATE_CHANGED, event.eventType)

        // §8.3 responses ride the same socket; callers correlate by requestId.
        val response = fixture.responsesSeen.single()
        assertEquals("00000000-0000-4000-8000-000000000030", response.requestId)
        assertEquals(ResponseType.COMMAND_STATUS, response.responseType)
        fixture.shutdown()
    }

    @Test
    fun stop_closesTheSocketGracefullyAndStops() = runBlocking {
        val fixture = Fixture()
        fixture.coordinator.start()

        fixture.coordinator.stop()

        assertEquals(ConnectionState.STOPPED, fixture.coordinator.state.value)
        assertEquals(1000, fixture.transport.sockets[0].closeCode)
        fixture.shutdown()
    }

    // -------------------------------------------------------------------
    // Fixture: fakes wired to the REAL coordinator state machine
    // -------------------------------------------------------------------

    private class FakeSocket(val index: Int, private val log: MutableList<String>) : BridgeSocket {
        val sentTexts = mutableListOf<String>()
        var closeCode: Int? = null

        override fun sendText(text: String): Boolean {
            log += "send:$index"
            sentTexts += text
            return true
        }

        override fun close(code: Int, reason: String): Boolean {
            closeCode = code
            return true
        }
    }

    private class FakeTransport(private val log: MutableList<String>) : BridgeTransport {
        val sockets = mutableListOf<FakeSocket>()
        var listener: BridgeSocketListener? = null
            private set
        var lastCredentials: BridgeCredentials? = null
            private set
        var failNextConnects = 0

        override fun connect(credentials: BridgeCredentials, listener: BridgeSocketListener): BridgeSocket {
            log += "connect"
            if (failNextConnects > 0) {
                failNextConnects -= 1
                throw IOException("connection refused")
            }
            val socket = FakeSocket(sockets.size, log)
            sockets += socket
            this.listener = listener
            lastCredentials = credentials
            listener.onSocketOpen()
            return socket
        }

        fun deliver(text: String) {
            listener?.onSocketMessage(text)
        }

        fun serverClose(code: Int, reason: String) {
            listener?.onSocketClosed(code, reason)
        }
    }

    private class FakeCredentialSource(private val log: MutableList<String>) : BridgeCredentialSource {
        var accessGeneration = 1
            private set
        var sessionGeneration = 1
            private set
        var accessRefreshGate: CompletableDeferred<Unit>? = null
        var failCurrentCredentialsWith: Throwable? = null

        override suspend fun currentCredentials(): BridgeCredentials {
            failCurrentCredentialsWith?.let { throw it }
            log += "current"
            return BridgeCredentials("access-$accessGeneration", "session-$sessionGeneration")
        }

        override suspend fun refreshAccessToken(): String {
            log += "access-refresh"
            accessRefreshGate?.await()
            accessGeneration += 1
            return "access-$accessGeneration"
        }

        override suspend fun establishDeviceSession(): String {
            log += "device-session"
            sessionGeneration += 1
            return "session-$sessionGeneration"
        }
    }

    /**
     * One fully-wired coordinator over synchronous fakes. The scope runs
     * UNCONFINED so start()/close()/deliver() drive the state machine
     * deterministically on the test thread.
     */
    private inner class Fixture(ackPositions: Map<String, Long> = emptyMap()) {
        val log = mutableListOf<String>()
        val delays = mutableListOf<Long>()
        val transport = FakeTransport(log)
        val source = FakeCredentialSource(log)
        val eventsSeen = mutableListOf<ProtocolEvent>()
        val responsesSeen = mutableListOf<dev.clauderemote.android.protocol.v1.ProtocolResponse>()
        val signalsSeen = mutableListOf<CoordinatorSignal>()
        var nowMs = NOW
        private var requestIdCounter = 1L

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

        val coordinator = ConnectionCoordinator(
            transport = transport,
            credentialSource = source,
            ackPositions = { ackPositions },
            scope = scope,
            delayer = { delays += it },
            jitterFraction = { 0.0 },
            now = { nowMs },
            newRequestId = { "00000000-0000-4000-8000-%012d".format(requestIdCounter++) },
        )

        init {
            scope.launch { coordinator.events.collect { eventsSeen += it } }
            scope.launch { coordinator.responses.collect { responsesSeen += it } }
            scope.launch { coordinator.signals.collect { signalsSeen += it } }
        }

        fun shutdown() = scope.cancel()
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    private fun sessionListCommand(
        requestId: String = "00000000-0000-4000-8000-000000000001",
    ) = SessionListCommand(
        requestId = requestId,
        idempotencyKey = "idem-list-1",
        sentAt = SENT_AT,
    )

    private fun eventJson(
        eventId: Long,
        sessionId: String = SESSION_ID,
        eventType: String = "session.state.changed",
    ) = """
        {
          "protocolVersion": "$PROTOCOL_VERSION",
          "eventId": "$eventId",
          "sessionId": "$sessionId",
          "eventType": "$eventType",
          "timestamp": "$SENT_AT",
          "payload": { "state": "running" }
        }
    """.trimIndent()

    private fun decodeAckCommands(texts: List<String>): List<EventsAckCommand> =
        texts
            .map { ProtocolJson.json.decodeFromString(ProtocolCommand.serializer(), it) }
            .filterIsInstance<EventsAckCommand>()

    private companion object {
        const val NOW = 1_700_000_000_000L
        const val SESSION_ID = "11111111-1111-4111-8111-111111111111"
        const val SENT_AT = "2023-11-14T22:13:20Z"
    }
}
