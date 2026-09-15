package dev.clauderemote.android

import dev.clauderemote.android.auth.PairRequest
import dev.clauderemote.android.auth.VerifyRequest
import dev.clauderemote.android.protocol.v1.PROTOCOL_VERSION
import dev.clauderemote.android.protocol.v1.ProtocolEvent
import dev.clauderemote.android.protocol.v1.ProtocolJson
import dev.clauderemote.android.security.DeviceKeyManager
import dev.clauderemote.android.security.buildSigningBytes
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The embedded fake bridge for the E2E instrumented suite: a REAL HTTP+WS
 * server (MockWebServer) inside the test that speaks the actual bridge
 * protocol over the device loopback, so the app's REAL stack — transport,
 * connection coordinator, snapshot coordinator, reducer, Room, encrypted
 * store, Keystore device key — runs against it unchanged.
 *
 * What it implements:
 * - POST /api/v1/auth/pair|challenge|verify with REAL ECDSA P-256 signature
 *   verification against the enrolled SPKI public key (§10.3);
 * - POST /api/v1/commands: session.snapshot.begin/page/commit with the exact
 *   §8.3 wire shapes (decimal-string uint64 fields), scriptable 410
 *   SNAPSHOT_EXPIRED commits, and recorded idempotency keys;
 * - GET-upgraded /api/v1/ws: the §8.1 stream — answers every §8.2 command
 *   envelope with a command.status response, tracks events.ack watermarks,
 *   and REPLAYS journal entries above the watermark (the §8.5/§11.1
 *   redelivery contract); the test emits events and injects close codes
 *   (4410/4500) on demand.
 */
class E2eFakeBridgeServer {

    private val server = MockWebServer()
    private val json = Json { ignoreUnknownKeys = true }

    // -------------------------------------------------------------------
    // §10.3 auth surface
    // -------------------------------------------------------------------

    val pairRequests = CopyOnWriteArrayList<PairRequest>()

    /** Enrolled SPKI public key (from the pair request), for verify. */
    @Volatile
    private var enrolledPublicKey: PublicKey? = null

    @Volatile
    var enrolledDeviceId: String? = null
        private set

    /** Whether the server-recomputed deviceId matched the client's claim. */
    @Volatile
    var deviceIdMatched: Boolean? = null
        private set

    /** One (request, signature-verified) entry per /auth/verify call. */
    val verifyResults = CopyOnWriteArrayList<Pair<VerifyRequest, Boolean>>()

    /** (authorization, device-session) header pairs seen on HTTP endpoints. */
    val httpCredentialHeaders = CopyOnWriteArrayList<Pair<String?, String?>>()

    val challengeId: String = UUID.randomUUID().toString()
    val challengeRaw: ByteArray = ByteArray(32) { ((it * 7) + 3).toByte() }
    val hostAscii = "127.0.0.1"
    val accessSubject = "e2e-user-42"

    @Volatile
    var deviceSessionToken = "e2e-device-session-token"
        private set

    // -------------------------------------------------------------------
    // §6.7 snapshot surface
    // -------------------------------------------------------------------

    /** Script for the next snapshot.begin (set by the test). */
    @Volatile
    var nextSnapshot: SnapshotScript? = null

    /**
     * Ordered scripts for consecutive begins (drained first, before
     * [nextSnapshot]): models the §6.7 restart where the SECOND cycle of a
     * 410-recovery must serve a FRESH snapshot (new snapshotId/revision).
     */
    private val snapshotScriptQueue = java.util.concurrent.ConcurrentLinkedQueue<SnapshotScript>()

    fun enqueueScripts(vararg scripts: SnapshotScript) {
        scripts.forEach { snapshotScriptQueue.add(it) }
    }

    /** One entry per commit call (httpStatus 200 = accepted, 410 = expired). */
    val recordedCommits = CopyOnWriteArrayList<RecordedCommit>()

    /** Commits to fail with 410 SNAPSHOT_EXPIRED before succeeding. */
    val commitFailuresRemaining = AtomicInteger(0)

    class SnapshotScript(
        val snapshotId: String,
        val historyRevision: String,
        val items: List<JournalItem>,
        val deliveryBase: Long,
        val deliveryWatermark: Long,
        val sessionStatus: String,
    )

    /** One materialized history item of a scripted snapshot. */
    class JournalItem(
        val historyItemId: String,
        val role: String,
        val text: String,
    )

    data class RecordedCommit(
        val sessionId: String,
        val snapshotId: String,
        val historyRevision: String,
        val deliveryWatermark: Long,
        val idempotencyKey: String,
        val httpStatus: Int,
    )

    // -------------------------------------------------------------------
    // §8.1/§8.4 stream surface
    // -------------------------------------------------------------------

    class WsSession internal constructor(val socket: WebSocket) {
        internal val received = CopyOnWriteArrayList<JsonObject>()

        fun sendText(text: String): Boolean = socket.send(text)

        fun receivedCommands(): List<JsonObject> = received.toList()

        /** All events.ack payloads this socket received, in order. */
        fun receivedAcks(): List<Pair<String, Long>> = received
            .filter { it["commandType"]?.jsonPrimitive?.contentOrNull == "events.ack" }
            .map { cmd ->
                val payload = cmd["payload"]!!.jsonObject
                payload["sessionId"]!!.jsonPrimitive.content to
                    payload["lastEventId"]!!.jsonPrimitive.content.toLong()
            }
    }

    @Volatile
    var latestWs: WsSession? = null
        private set

    val wsConnections = AtomicInteger(0)

    /** Delivered-and-replayable event journal (eventId → envelope text). */
    class JournalEntry(val eventId: Long, val sessionId: String, val text: String)

    val journal = CopyOnWriteArrayList<JournalEntry>()

    /** Per-session acked watermark (what resume/replay is anchored to). */
    val ackWatermarks = ConcurrentHashMap<String, Long>()

    /** Optional per-commandType hooks installed by the test. */
    val wsCommandHooks = ConcurrentHashMap<String, (JsonObject) -> Unit>()

    // -------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------

    fun start() {
        server.dispatcher = bridgeDispatcher
        server.start()
    }

    fun shutdown() {
        runCatching { server.shutdown() }
    }

    /** Base URL the app's transport should be pointed at. */
    fun baseUrl(): String = server.url("/").toString().trimEnd('/')

    // -------------------------------------------------------------------
    // Test driving surface
    // -------------------------------------------------------------------

    /** Sends one event on the live socket AND records it in the journal. */
    fun emitEvent(event: ProtocolEvent) {
        val text = ProtocolJson.json.encodeToString(ProtocolEvent.serializer(), event)
        journal.add(JournalEntry(event.eventId.value, event.sessionId, text))
        latestWs?.sendText(text)
    }

    /** Records an event in the journal WITHOUT delivering it now (§8.5 backlog). */
    fun journalOnly(event: ProtocolEvent) {
        val text = ProtocolJson.json.encodeToString(ProtocolEvent.serializer(), event)
        journal.add(JournalEntry(event.eventId.value, event.sessionId, text))
    }

    fun closeLatestWs(code: Int, reason: String) {
        latestWs?.socket?.close(code, reason)
    }

    fun awaitWsCommand(timeoutMs: Long = 15_000, predicate: (JsonObject) -> Boolean): JsonObject {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val match = latestWs?.receivedCommands()?.lastOrNull(predicate)
            if (match != null) return match
            Thread.sleep(50)
        }
        throw AssertionError("no matching WS command within ${timeoutMs}ms")
    }

    // -------------------------------------------------------------------
    // Dispatcher
    // -------------------------------------------------------------------

    private val wsListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
            val session = WsSession(webSocket)
            latestWs = session
            wsConnections.incrementAndGet()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val command = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            val session = latestWs ?: return
            session.received.add(command)
            when (command["commandType"]?.jsonPrimitive?.contentOrNull) {
                "events.ack" -> handleAck(command)
                else -> {
                    respondCommandStatus(command, "accepted")
                    command["commandType"]?.jsonPrimitive?.contentOrNull
                        ?.let { wsCommandHooks[it]?.invoke(command) }
                }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }
    }

    private fun handleAck(command: JsonObject) {
        val payload = command["payload"]?.jsonObject ?: return
        val sessionId = payload["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
        val lastEventId = payload["lastEventId"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: return
        ackWatermarks.merge(sessionId, lastEventId, ::maxOf)
        replayAboveWatermark(sessionId)
    }

    /** §11.1/§8.5 redelivery: everything in the journal above the watermark. */
    private fun replayAboveWatermark(sessionId: String) {
        val watermark = ackWatermarks[sessionId] ?: 0L
        journal
            .filter { it.sessionId == sessionId && it.eventId > watermark }
            .sortedBy { it.eventId }
            .forEach { latestWs?.sendText(it.text) }
    }

    private fun respondCommandStatus(command: JsonObject, status: String) {
        val requestId = command["requestId"]?.jsonPrimitive?.contentOrNull ?: return
        val payload = buildJsonObject {
            put("protocolVersion", PROTOCOL_VERSION)
            put("requestId", requestId)
            put("responseType", "command.status")
            put("commandStatus", status)
        }
        latestWs?.sendText(payload.toString())
    }

    private val bridgeDispatcher = object : Dispatcher() {
        override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
            val path = request.requestUrl?.encodedPath ?: return notFound()
            httpCredentialHeaders.add(
                request.getHeader("Authorization") to request.getHeader("X-Claude-Remote-Device-Session"),
            )
            val body = request.body.readUtf8()
            return when (path) {
                "/api/v1/auth/pair" -> handlePair(body)
                "/api/v1/auth/challenge" -> handleChallenge()
                "/api/v1/auth/verify" -> handleVerify(body)
                "/api/v1/commands" -> handleCommand(body)
                "/api/v1/ws" -> MockResponse()
                    .setHeader("Sec-WebSocket-Protocol", PROTOCOL_VERSION)
                    .withWebSocketUpgrade(wsListener)
                else -> notFound()
            }
        }
    }

    private fun handlePair(body: String): MockResponse {
        val pair = json.decodeFromString(PairRequest.serializer(), body)
        pairRequests.add(pair)
        val spki = Base64.getUrlDecoder().decode(pair.publicKeySpkiB64u)
        enrolledPublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
        val recomputed = DeviceKeyManager.deviceIdFromSpki(spki)
        deviceIdMatched = recomputed == pair.deviceId
        enrolledDeviceId = recomputed
        return jsonResponse(
            buildJsonObject {
                put("deviceId", recomputed)
            }.toString(),
        )
    }

    private fun handleChallenge(): MockResponse = jsonResponse(
        buildJsonObject {
            put("challengeId", challengeId)
            put("challengeRawB64u", Base64.getUrlEncoder().withoutPadding().encodeToString(challengeRaw))
            put("accessSubject", accessSubject)
            put("hostAscii", hostAscii)
            put("expiresAt", System.currentTimeMillis() + 300_000L)
        }.toString(),
    )

    private fun handleVerify(body: String): MockResponse {
        val verify = json.decodeFromString(VerifyRequest.serializer(), body)
        val key = enrolledPublicKey
        val deviceId = enrolledDeviceId
        val verified = key != null && deviceId != null && runCatching {
            val content = buildSigningBytes(
                hostAscii = hostAscii,
                deviceId = deviceId,
                challengeId = challengeId,
                accessSubject = accessSubject,
                challengeRaw = challengeRaw,
            )
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initVerify(key)
            signature.update(content)
            signature.verify(Base64.getUrlDecoder().decode(verify.signatureB64u))
        }.getOrDefault(false)
        verifyResults.add(verify to verified)
        if (!verified) {
            return MockResponse().setResponseCode(401).setBody("unauthorized")
        }
        return jsonResponse(
            buildJsonObject {
                put("deviceSessionToken", deviceSessionToken)
                put("expiresAt", System.currentTimeMillis() + DEVICE_SESSION_TTL_MS)
            }.toString(),
        )
    }

    private fun handleCommand(body: String): MockResponse {
        val command = json.parseToJsonElement(body).jsonObject
        val requestId = command["requestId"]?.jsonPrimitive?.contentOrNull ?: ""
        return when (command["commandType"]?.jsonPrimitive?.contentOrNull) {
            "project.list" -> projectList(requestId)
            "session.snapshot.begin" -> snapshotBegin(requestId)
            "session.snapshot.page" -> snapshotPage(requestId)
            "session.snapshot.commit" -> snapshotCommit(requestId, command["payload"]?.jsonObject)
            else -> notFound()
        }
    }

    /** Projects the §7.2 picker lists; tests may replace the list. */
    @Volatile
    var projects: List<Pair<String, String>> = emptyList() // (projectId, displayName)

    private fun projectList(requestId: String): MockResponse = commandResult(
        requestId,
        buildJsonObject {
            put(
                "projects",
                kotlinx.serialization.json.JsonArray(
                    projects.map { (id, name) ->
                        buildJsonObject {
                            put("projectId", id)
                            put("displayName", name)
                        }
                    },
                ),
            )
        },
    )

    private fun snapshotBegin(requestId: String): MockResponse {
        val script = snapshotScriptQueue.poll() ?: nextSnapshot
            ?: return MockResponse().setResponseCode(500).setBody("no snapshot scripted")
        return commandResult(
            requestId,
            buildJsonObject {
                put("snapshotId", script.snapshotId)
                put("historyRevision", script.historyRevision)
                put(
                    "items",
                    kotlinx.serialization.json.JsonArray(
                        script.items.map { item ->
                            buildJsonObject {
                                put("historyItemId", item.historyItemId)
                                put("role", item.role)
                                put(
                                    "contentBlocks",
                                    kotlinx.serialization.json.JsonArray(
                                        listOf(
                                            buildJsonObject {
                                                put("kind", "text")
                                                put("text", item.text)
                                            },
                                        ),
                                    ),
                                )
                                put("createdAt", "2026-09-12T00:00:00Z")
                                put("sourceTranscriptOffset", 0)
                            }
                        },
                    ),
                )
                put("nextCursor", null as String?)
                put("deliveryBase", script.deliveryBase.toString())
                put("deliveryWatermark", script.deliveryWatermark.toString())
                put("sessionStatus", script.sessionStatus)
                put("commands", kotlinx.serialization.json.JsonArray(emptyList()))
                put("pendingPermission", null as String?)
                put("expiresAt", System.currentTimeMillis() + 300_000L)
            },
        )
    }

    private fun snapshotPage(requestId: String): MockResponse = commandResult(
        requestId,
        buildJsonObject {
            put("items", kotlinx.serialization.json.JsonArray(emptyList()))
            put("nextCursor", null as String?)
        },
    )

    private fun snapshotCommit(requestId: String, payload: JsonObject?): MockResponse {
        val snapshotId = payload?.get("snapshotId")?.jsonPrimitive?.contentOrNull ?: ""
        val historyRevision = payload?.get("historyRevision")?.jsonPrimitive?.contentOrNull ?: ""
        val watermark = payload?.get("deliveryWatermark")?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L
        val idempotencyKey = payload?.get("idempotencyKey")?.jsonPrimitive?.contentOrNull ?: ""
        val sessionId = payload?.get("sessionId")?.jsonPrimitive?.contentOrNull ?: ""
        val shouldFail = synchronized(this) {
            if (commitFailuresRemaining.get() > 0) {
                commitFailuresRemaining.decrementAndGet()
                true
            } else {
                false
            }
        }
        return if (shouldFail) {
            recordedCommits.add(RecordedCommit(sessionId, snapshotId, historyRevision, watermark, idempotencyKey, 410))
            MockResponse().setResponseCode(410).setBody(
                buildJsonObject {
                    put("protocolVersion", PROTOCOL_VERSION)
                    put("requestId", requestId)
                    put("responseType", "command.error")
                    put(
                        "error",
                        buildJsonObject {
                            put("code", "SNAPSHOT_EXPIRED")
                            put("message", "snapshot expired before commit")
                            put("retryable", true)
                        },
                    )
                }.toString(),
            )
        } else {
            recordedCommits.add(RecordedCommit(sessionId, snapshotId, historyRevision, watermark, idempotencyKey, 200))
            commandResult(
                requestId,
                buildJsonObject {
                    put("status", "committed")
                    put("snapshotId", snapshotId)
                    put("historyRevision", historyRevision)
                    put("deliveryWatermark", watermark.toString())
                    put("deliveryBase", (payload?.get("deliveryWatermark")?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: watermark).toString())
                    put("committedAt", System.currentTimeMillis())
                },
            )
        }
    }

    private fun commandResult(requestId: String, result: kotlinx.serialization.json.JsonElement): MockResponse =
        jsonResponse(
            buildJsonObject {
                put("protocolVersion", PROTOCOL_VERSION)
                put("requestId", requestId)
                put("responseType", "command.status")
                put("commandStatus", "completed")
                put("result", result)
            }.toString(),
        )

    private fun jsonResponse(body: String): MockResponse =
        MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)

    private fun notFound(): MockResponse = MockResponse().setResponseCode(404)

    private companion object {
        const val DEVICE_SESSION_TTL_MS = 900_000L
    }
}
