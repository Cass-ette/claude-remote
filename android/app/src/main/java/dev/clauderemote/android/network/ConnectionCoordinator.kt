package dev.clauderemote.android.network

import dev.clauderemote.android.auth.DeviceSessionCache
import dev.clauderemote.android.auth.DeviceSessionManager
import dev.clauderemote.android.auth.OAuthManager
import dev.clauderemote.android.auth.ReLoginRequiredError
import dev.clauderemote.android.protocol.v1.EventsAckCommand
import dev.clauderemote.android.protocol.v1.EventsAckPayload
import dev.clauderemote.android.protocol.v1.ProtocolCommand
import dev.clauderemote.android.protocol.v1.ProtocolEvent
import dev.clauderemote.android.protocol.v1.ProtocolJson
import dev.clauderemote.android.protocol.v1.ProtocolResponse
import java.time.Instant
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.coroutineContext
import kotlin.random.Random
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/**
 * Connection lifecycle owner for the bridge stream (spec §8.1, §11.1).
 *
 * The coordinator is the single point that owns the active socket:
 *
 * - `start()` runs the connect loop; [send] serializes a §8.2 command onto
 *   the current socket; [events]/[responses] expose the parsed §8.4/§8.3
 *   inbound stream; [signals] surfaces the §8.1 close-code outcomes that UI
 *   layers must act on;
 * - reconnect uses exponential backoff with jitter, capped at
 *   [MAX_BACKOFF_MS] (§11.1);
 * - the §8.1 close-code policy:
 *   - 4401 → ONE [Mutex]-protected critical section: OAuth Access refresh →
 *     fresh device session (challenge → sign → verify) → NEW socket, in that
 *     order, with no `send()` and no event consumption proceeding
 *     concurrently (§11.1 — the token is never swapped inside the old
 *     socket);
 *   - 4403 → stop reconnecting, surface re-pair/re-login;
 *   - 4409 → surface the conflict (the conflicting command is NOT retried);
 *   - 4410 → park reconnect and never ACK past the resync point; the
 *     SnapshotCoordinator (§6.7) owns begin/page/commit and re-enters via
 *     `start()`;
 *   - 4426 → surface upgrade-required, stop reconnecting;
 *   - 4500 / transport failures → exponential backoff, capped;
 * - every (re)connect posts the last continuously consumed eventId per
 *   session as an events.ack (the §11.1 resume-from marker): the bridge
 *   replays its journal from the device watermark, and re-deliveries above
 *   the marker are deduped downstream by eventId.
 *
 * All transport/auth/time seams are injectable so the JVM tests drive the
 * state machine deterministically with fakes; the OkHttp layer is a thin
 * shell (integration coverage lands with the runtime wiring task).
 */
class ConnectionCoordinator(
    private val transport: BridgeTransport,
    private val credentialSource: BridgeCredentialSource,
    private val ackPositions: AckPositionSource,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val delayer: suspend (Long) -> Unit = { delay(it) },
    private val jitterFraction: () -> Double = { Random.nextDouble() },
    private val now: () -> Long = System::currentTimeMillis,
    private val newRequestId: () -> String = { UUID.randomUUID().toString() },
) {

    /** Serializes socket transitions, sends, and event processing. */
    private val connectionMutex = Mutex()

    /** Ordered, non-blocking hand-off from socket threads to the pump. */
    private val inbound = Channel<String>(Channel.UNLIMITED)
    private val eventChannel = Channel<ProtocolEvent>(Channel.UNLIMITED)
    private val responseChannel = Channel<ProtocolResponse>(Channel.UNLIMITED)
    private val signalFlow = MutableSharedFlow<CoordinatorSignal>(extraBufferCapacity = SIGNAL_BUFFER)

    private val stateFlow = MutableStateFlow(ConnectionState.DISCONNECTED)

    @Volatile
    private var currentSocket: BridgeSocket? = null

    @Volatile
    private var currentListener: SocketListener? = null

    private var loopJob: Job? = null
    private var pumpJob: Job? = null

    /** Consecutive connection attempts that did not yield a stable connection. */
    private var reconnectAttempts = 0

    val state: StateFlow<ConnectionState> get() = stateFlow
    val signals: SharedFlow<CoordinatorSignal> = signalFlow
    val events: Flow<ProtocolEvent> = eventChannel.receiveAsFlow()
    val responses: Flow<ProtocolResponse> = responseChannel.receiveAsFlow()

    /**
     * Starts (or restarts) the connect loop. Re-entrant after a parked
     * resync (4410) or [stop]; a no-op while the loop is already running.
     */
    fun start() {
        if (loopJob?.isActive == true) return
        reconnectAttempts = 0
        if (pumpJob?.isActive != true) {
            pumpJob = scope.launch { pumpInbound() }
        }
        loopJob = scope.launch { runForever() }
    }

    /** User-initiated stop: closes the socket gracefully and halts the loop. */
    fun stop() {
        loopJob?.cancel()
        loopJob = null
        currentSocket?.close(1000, "client stopped")
        markCurrentSocketClosed()
        stateFlow.value = ConnectionState.STOPPED
    }

    /**
     * Sends one §8.2 command envelope over the current socket. Blocks while
     * a refresh/reconnect critical section is in flight (the mutex is the
     * same one the 4401 path holds), so a command can never race the socket
     * swap; throws [NotConnectedError] when there is no live socket.
     */
    suspend fun send(command: ProtocolCommand) {
        val text = ProtocolJson.json.encodeToString(ProtocolCommand.serializer(), command)
        connectionMutex.withLock {
            val socket = currentSocket ?: throw NotConnectedError("not connected to the bridge")
            if (!socket.sendText(text)) {
                throw NotConnectedError("the bridge socket rejected the send")
            }
        }
    }

    /**
     * ACKs the last continuously consumed eventId of a session (§8.5): the
     * consumer (reducer pipeline) calls this after applying events, which
     * advances the bridge's device watermark and frees pending events.
     */
    suspend fun acknowledge(sessionId: String, lastEventId: Long) {
        send(
            EventsAckCommand(
                requestId = newRequestId(),
                idempotencyKey = newRequestId(),
                sentAt = rfc3339Now(),
                payload = EventsAckPayload(sessionId = sessionId, lastEventId = lastEventId),
            ),
        )
    }

    // -------------------------------------------------------------------
    // Connect loop and §8.1 close-code policy
    // -------------------------------------------------------------------

    private suspend fun runForever() {
        var listener = connectWithBackoff() ?: return
        while (true) {
            val close = listener.closed.await()
            // A connection that stayed up past the stability window resets
            // the backoff ladder; an instantly-closed one keeps climbing.
            val stable = now() - listener.openedAtMs >= CONNECT_STABILITY_MS
            if (stable) {
                reconnectAttempts = 0
            }
            markDisconnected(listener)
            listener = when (close.code) {
                BridgeCloseCode.AUTH_INVALID -> recoverAfterAuthRejection() ?: return
                BridgeCloseCode.FORBIDDEN -> {
                    // Device/project not authorized: no retry loop can fix
                    // this; the UI must re-pair / re-login.
                    emitSignal(CoordinatorSignal.ReAuthenticationRequired)
                    stateFlow.value = ConnectionState.STOPPED
                    return
                }
                BridgeCloseCode.SESSION_CONFLICT -> {
                    // The conflicting command must not be retried (§11.2);
                    // the repository reacts to the signal. The socket itself
                    // reconnects so delivery for other sessions continues.
                    emitSignal(CoordinatorSignal.SessionConflict(close.reason))
                    delayedReconnect() ?: return
                }
                BridgeCloseCode.RESYNC_REQUIRED -> {
                    // §8.1/§6.7: local state must resynchronize. The
                    // SnapshotCoordinator owns begin/page/commit and the
                    // re-entry via start(); until then nothing reconnects
                    // and no events.ack may advance past this point.
                    emitSignal(CoordinatorSignal.ResyncRequired)
                    stateFlow.value = ConnectionState.DISCONNECTED
                    return
                }
                BridgeCloseCode.PROTOCOL_INCOMPATIBLE -> {
                    emitSignal(CoordinatorSignal.UpgradeRequired)
                    stateFlow.value = ConnectionState.STOPPED
                    return
                }
                else -> delayedReconnect() ?: return
            }
        }
    }

    /**
     * Connects, retrying with §11.1 exponential backoff. Returns null only
     * when the loop was cancelled/stopped or re-login became unavoidable.
     */
    private suspend fun connectWithBackoff(): SocketListener? {
        while (coroutineContext.isActive) {
            val listener = SocketListener()
            try {
                connectionMutex.withLock {
                    connectLocked(credentialSource.currentCredentials(), listener)
                }
                postResumeAcks()
                return listener
            } catch (e: CancellationException) {
                throw e
            } catch (e: ReLoginRequiredError) {
                // No secondary credential source exists (§10.2): surface
                // re-login instead of spinning the backoff loop.
                emitSignal(CoordinatorSignal.ReAuthenticationRequired)
                stateFlow.value = ConnectionState.STOPPED
                return null
            } catch (e: Exception) {
                val delayMs = backoffDelayMs(reconnectAttempts, jitterFraction())
                reconnectAttempts += 1
                delayer(delayMs)
            }
        }
        return null
    }

    /** Waits one backoff slot, then [connectWithBackoff]. */
    private suspend fun delayedReconnect(): SocketListener? {
        val delayMs = backoffDelayMs(reconnectAttempts, jitterFraction())
        reconnectAttempts += 1
        delayer(delayMs)
        return connectWithBackoff()
    }

    /**
     * §11.1 4401 recovery — the ONE critical section: OAuth Access refresh,
     * then a FRESH device session (the token is never swapped inside the old
     * socket), then the new socket. While it runs, the connection mutex is
     * held, so no [send] and no event consumption proceeds concurrently.
     * Falls back to the generic backoff loop when the refresh or the new
     * socket fails.
     */
    private suspend fun recoverAfterAuthRejection(): SocketListener? {
        val listener = SocketListener()
        try {
            connectionMutex.withLock {
                val access = credentialSource.refreshAccessToken()
                val deviceSession = credentialSource.establishDeviceSession()
                connectLocked(BridgeCredentials(access, deviceSession), listener)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ReLoginRequiredError) {
            emitSignal(CoordinatorSignal.ReAuthenticationRequired)
            stateFlow.value = ConnectionState.STOPPED
            return null
        } catch (e: Exception) {
            return delayedReconnect()
        }
        reconnectAttempts = 0
        try {
            postResumeAcks()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The socket died between the Upgrade and the resume ACKs; degrade
            // to the normal close-driven backoff path instead of killing the
            // reconnect loop (mirrors the guarded call in connectWithBackoff).
            return delayedReconnect()
        }
        return listener
    }

    /** Mutex MUST be held: performs the Upgrade and the state transition. */
    private suspend fun connectLocked(credentials: BridgeCredentials, listener: SocketListener) {
        stateFlow.value = ConnectionState.CONNECTING
        currentListener = listener
        val socket = transport.connect(credentials, listener)
        // Suspends (still under the mutex) until the Upgrade completes; a
        // handshake rejection/failure completes this exceptionally.
        listener.openResult.await()
        listener.openedAtMs = now()
        currentSocket = socket
        stateFlow.value = ConnectionState.CONNECTED
    }

    /** Drops the closed socket unless a newer one already superseded it. */
    private suspend fun markDisconnected(listener: SocketListener) {
        connectionMutex.withLock {
            if (currentListener === listener) {
                markCurrentSocketClosed()
                if (stateFlow.value != ConnectionState.STOPPED) {
                    stateFlow.value = ConnectionState.DISCONNECTED
                }
            }
        }
    }

    private fun markCurrentSocketClosed() {
        currentSocket = null
        currentListener = null
    }

    /**
     * §11.1 resume-from: on every (re)connect, submit the last continuously
     * consumed eventId per session. The bridge advances its device watermark
     * and skips replaying at/below the marker; re-deliveries above it are
     * deduped downstream by eventId.
     */
    private suspend fun postResumeAcks() {
        for ((sessionId, lastEventId) in ackPositions.lastAckedEventIds()) {
            acknowledge(sessionId, lastEventId)
        }
    }

    // -------------------------------------------------------------------
    // Inbound pump
    // -------------------------------------------------------------------

    /**
     * Single consumer preserving arrival order. Each message takes the
     * connection mutex, so inbound processing never interleaves with a
     * refresh/reconnect critical section.
     */
    private suspend fun pumpInbound() {
        for (text in inbound) {
            connectionMutex.withLock { dispatchInboundLocked(text) }
        }
    }

    private fun dispatchInboundLocked(text: String) {
        val element = runCatching { ProtocolJson.json.parseToJsonElement(text) }.getOrNull() ?: return
        val obj = element as? JsonObject ?: return
        when {
            EVENT_TYPE_KEY in obj -> {
                val event = runCatching {
                    ProtocolJson.json.decodeFromJsonElement(ProtocolEvent.serializer(), element)
                }.getOrNull() ?: return
                eventChannel.trySend(event)
            }
            RESPONSE_TYPE_KEY in obj -> {
                val response = runCatching {
                    ProtocolJson.json.decodeFromJsonElement(ProtocolResponse.serializer(), element)
                }.getOrNull() ?: return
                responseChannel.trySend(response)
            }
            // The bridge only sends §8.3 responses and §8.4 events; anything
            // else is drift and is dropped rather than crashing the pump.
        }
    }

    private fun emitSignal(signal: CoordinatorSignal) {
        signalFlow.tryEmit(signal)
    }

    private fun rfc3339Now(): String = Instant.ofEpochMilli(now()).toString()

    /** Socket callbacks marshalled into deferreds the loop awaits. */
    private inner class SocketListener : BridgeSocketListener {
        val openResult = CompletableDeferred<Unit>()
        val closed = CompletableDeferred<SocketClose>()
        var openedAtMs: Long = Long.MIN_VALUE

        override fun onSocketOpen() {
            openResult.complete(Unit)
        }

        override fun onSocketMessage(text: String) {
            inbound.trySend(text)
        }

        override fun onSocketClosed(code: Int, reason: String) {
            if (openResult.isActive) {
                // The bridge only closes with a §8.1 code AFTER a successful
                // upgrade (an unupgradable request fails the handshake), so
                // a pre-open close is treated as a plain connect failure.
                openResult.completeExceptionally(SocketClosedDuringHandshakeException(code, reason))
            }
            if (closed.isActive) {
                closed.complete(SocketClose(code, reason))
            }
        }

        override fun onSocketFailure(cause: Throwable) {
            if (openResult.isActive) {
                openResult.completeExceptionally(cause)
            }
            if (closed.isActive) {
                closed.complete(SocketClose(ABNORMAL_CLOSE_CODE, cause.message ?: "transport failure"))
            }
        }
    }

    private data class SocketClose(val code: Int, val reason: String)

    private class SocketClosedDuringHandshakeException(code: Int, reason: String) :
        Exception("bridge closed during the handshake (code $code): $reason")

    companion object {
        /** §11.1 backoff: 1s base, doubling per attempt, capped at 60s. */
        const val BASE_BACKOFF_MS = 1_000L
        const val MAX_BACKOFF_MS = 60_000L

        /**
         * A connection open at least this long counts as stable and resets
         * the backoff ladder on the next reconnect.
         */
        const val CONNECT_STABILITY_MS = 30_000L

        /** RFC 6455 reserved code for an abnormal (non-close-frame) shutdown. */
        internal const val ABNORMAL_CLOSE_CODE = 1006

        private const val EVENT_TYPE_KEY = "eventType"
        private const val RESPONSE_TYPE_KEY = "responseType"
        private const val SIGNAL_BUFFER = 64

        /**
         * §11.1 reconnect delay: `min(base × 2^attempt + jitter, cap)` where
         * the jitter is a fraction in [0, 1) of the exponential term. Pure
         * and injectable so the ladder and its cap are directly testable.
         */
        fun backoffDelayMs(attempt: Int, jitterFraction: Double): Long {
            require(attempt >= 0) { "attempt must be non-negative, got $attempt" }
            val fraction = jitterFraction.coerceIn(0.0, 1.0)
            val exponential = if (attempt >= CAP_ATTEMPT) {
                MAX_BACKOFF_MS
            } else {
                minOf(BASE_BACKOFF_MS shl attempt, MAX_BACKOFF_MS)
            }
            val jitter = (exponential * fraction).toLong()
            return minOf(exponential + jitter, MAX_BACKOFF_MS)
        }

        /** 2^20 ms already overshoots the cap; stop shifting beyond this. */
        private const val CAP_ATTEMPT = 20
    }
}

/** Coordinator-visible connection state (§12 connection banner). */
enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    STOPPED,
}

/**
 * §8.1 close-code outcomes UI layers must act on (delivered via
 * [ConnectionCoordinator.signals]).
 */
sealed class CoordinatorSignal {

    /** 4403 / dead refresh token: re-pair or re-login; no auto-retry. */
    object ReAuthenticationRequired : CoordinatorSignal()

    /** 4409: the conflicting command must not be retried; surface the conflict. */
    data class SessionConflict(val reason: String) : CoordinatorSignal()

    /**
     * 4410: local state must resynchronize; the SnapshotCoordinator (§6.7)
     * runs snapshot begin/page/commit and re-enters via start().
     */
    object ResyncRequired : CoordinatorSignal()

    /** 4426: protocol version incompatible; the app must be upgraded. */
    object UpgradeRequired : CoordinatorSignal()
}

/** The current socket is gone; the caller waits for CONNECTED or retries. */
class NotConnectedError(message: String) : IllegalStateException(message)

/**
 * Credential seam the coordinator drives. The two refresh steps are
 * SEPARATE methods so the §11.1 ordering (Access first, then the device
 * session) is enforced by the coordinator itself.
 */
interface BridgeCredentialSource {

    /** Credentials for a fresh connection; managers refresh within their windows. */
    suspend fun currentCredentials(): BridgeCredentials

    /** Force-refreshes the OAuth Access token (§11.1 step 1). */
    suspend fun refreshAccessToken(): String

    /**
     * Establishes a FRESH device session — a full challenge → sign → verify
     * round trip on top of a valid Access token (§10.3/§11.1 step 2), not a
     * possibly-rejected cached token.
     */
    suspend fun establishDeviceSession(): String
}

/**
 * Production [BridgeCredentialSource] over the Task 29 managers. A 4401
 * means the bridge rejected the CURRENT tokens, so the cached device
 * session is dropped before re-establishing — otherwise the manager would
 * happily return the just-rejected value.
 */
class ManagerCredentialSource(
    private val oauth: OAuthManager,
    private val deviceSessions: DeviceSessionManager,
    private val sessionCache: DeviceSessionCache,
) : BridgeCredentialSource {

    override suspend fun currentCredentials(): BridgeCredentials = BridgeCredentials(
        accessToken = oauth.getValidAccessToken(),
        deviceSessionToken = deviceSessions.getValidDeviceSessionToken(),
    )

    override suspend fun refreshAccessToken(): String = oauth.getValidAccessToken(forceRefresh = true)

    override suspend fun establishDeviceSession(): String {
        sessionCache.clear()
        return deviceSessions.getValidDeviceSessionToken()
    }
}

/**
 * Last continuously consumed eventId per session (§8.5 resume-from). The
 * coordinator posts these as events.ack markers on every (re)connect.
 * Production: over `SessionDao` (`sessions.lastAckEventId`); JVM tests use
 * a static map.
 */
fun interface AckPositionSource {
    fun lastAckedEventIds(): Map<String, Long>
}
