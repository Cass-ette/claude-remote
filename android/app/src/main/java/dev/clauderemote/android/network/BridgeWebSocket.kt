package dev.clauderemote.android.network

import dev.clauderemote.android.protocol.v1.PROTOCOL_VERSION
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * WebSocket transport seams for the App<->Bridge stream (spec §8.1).
 *
 * The Upgrade carries the SAME two credential headers as every HTTP request
 * (§10.2) plus `Sec-WebSocket-Protocol: claude-remote.v1`; the server must
 * explicitly select the subprotocol or the Upgrade is rejected.
 *
 * [BridgeTransport]/[BridgeSocket]/[BridgeSocketListener] are the
 * transport-agnostic seam the ConnectionCoordinator drives (JVM tests inject
 * fakes with close-code injection); [OkHttpBridgeTransport] is the thin
 * OkHttp implementation. The pure Upgrade-request builder
 * ([buildUpgradeRequest]) is shared by production and the JVM tests.
 */

/** §8.1 application close codes (4xxx private-use range), mirroring the bridge. */
object BridgeCloseCode {
    /** Access or device authentication invalid. */
    const val AUTH_INVALID = 4401

    /** Device or project not authorized. */
    const val FORBIDDEN = 4403

    /** Session write conflict. */
    const val SESSION_CONFLICT = 4409

    /** Client state must resynchronize. */
    const val RESYNC_REQUIRED = 4410

    /** Protocol version incompatible. */
    const val PROTOCOL_INCOMPATIBLE = 4426

    /** Bridge internal error. */
    const val INTERNAL_ERROR = 4500
}

/** One open bridge socket; all methods are non-blocking best-effort sends. */
interface BridgeSocket {
    /** Enqueues one text frame; false when the socket is already closing. */
    fun sendText(text: String): Boolean

    /** Initiates a graceful close with a §8.1 code. */
    fun close(code: Int, reason: String): Boolean
}

/** Callbacks of one socket attempt, invoked on the transport's threads. */
interface BridgeSocketListener {
    /** The Upgrade succeeded and the subprotocol was selected. */
    fun onSocketOpen()

    /** One inbound text frame (a §8.3 response or a §8.4 event). */
    fun onSocketMessage(text: String)

    /** The peer (or transport) closed with the given code. */
    fun onSocketClosed(code: Int, reason: String)

    /** The connection failed (handshake rejection, network error, ...). */
    fun onSocketFailure(cause: Throwable)
}

/**
 * Opens sockets to the bridge. The coordinator owns the lifecycle: each
 * [connect] produces exactly one listener pairing; a previous socket must
 * have closed before the coordinator opens the next.
 */
interface BridgeTransport {
    fun connect(credentials: BridgeCredentials, listener: BridgeSocketListener): BridgeSocket
}

/**
 * Builds the WebSocket Upgrade request: the ws(s) endpoint URL, BOTH
 * credential headers, and the `claude-remote.v1` subprotocol offer. Pure;
 * shared by [OkHttpBridgeTransport] and the JVM tests. OkHttp normalizes
 * ws/wss URLs to http/https internally — the Upgrade rides them unchanged.
 */
internal fun buildUpgradeRequest(wsUrl: String, credentials: BridgeCredentials): Request =
    Request.Builder()
        .url(wsUrl)
        .header(BridgeHeaders.AUTHORIZATION, "Bearer ${credentials.accessToken}")
        .header(BridgeHeaders.DEVICE_SESSION, credentials.deviceSessionToken)
        .header(BridgeHeaders.WEBSOCKET_PROTOCOL, PROTOCOL_VERSION)
        .build()

/** OkHttp [BridgeTransport] against the bridge WebSocket endpoint (§8.1). */
class OkHttpBridgeTransport(
    private val wsUrl: String,
    private val client: OkHttpClient = OkHttpClient(),
) : BridgeTransport {

    override fun connect(credentials: BridgeCredentials, listener: BridgeSocketListener): BridgeSocket {
        val webSocket = client.newWebSocket(
            buildUpgradeRequest(wsUrl, credentials),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = listener.onSocketOpen()

                override fun onMessage(webSocket: WebSocket, text: String) = listener.onSocketMessage(text)

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // Complete the closing handshake so the code is delivered
                    // via onClosed instead of a stalled-connection onFailure.
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
                    listener.onSocketClosed(code, reason)

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                    listener.onSocketFailure(t)
            },
        )
        return object : BridgeSocket {
            override fun sendText(text: String): Boolean = webSocket.send(text)

            override fun close(code: Int, reason: String): Boolean = webSocket.close(code, reason)
        }
    }
}
