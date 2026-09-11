package dev.clauderemote.android.network

import dev.clauderemote.android.protocol.v1.ProtocolCommand
import dev.clauderemote.android.protocol.v1.ProtocolJson
import dev.clauderemote.android.protocol.v1.ProtocolResponse
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.SerializationException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * HTTP command transport for the bridge public API (spec §8.2/§8.3, §10.2).
 *
 * Layering mirrors the auth stack (Task 29):
 *
 * - [buildCommandHttpRequest] and [parseCommandResponse] are PURE seams that
 *   carry the wire contract — the two credential headers on EVERY request
 *   (§10.2: `Authorization: Bearer <access>` for the Cloudflare Access
 *   assertion, plus the device-session header for the second auth layer) and
 *   the typed mapping of §8.3 error outcomes — and are covered by JVM unit
 *   tests;
 * - [HttpBridgeApi] is the thin OkHttp shell over those seams (integration
 *   coverage lands with the runtime wiring task).
 *
 * SECURITY INVARIANT (§10.2/§10.3): the device-session token and Access
 * token are attached to every request by the SAME code path; no caller ever
 * builds a bridge request by hand.
 */

/** Header names every bridge request carries (§10.2, §10.3). */
object BridgeHeaders {
    const val AUTHORIZATION = "Authorization"

    /** Opaque device-session token (the second auth layer of §10.3). */
    const val DEVICE_SESSION = "X-Claude-Remote-Device-Session"

    /** WebSocket subprotocol negotiation (§8.1). */
    const val WEBSOCKET_PROTOCOL = "Sec-WebSocket-Protocol"
}

/**
 * The two credentials every request/Upgrade carries. Fetched fresh per
 * request from the owning managers so a mid-flight refresh is never stale.
 */
data class BridgeCredentials(val accessToken: String, val deviceSessionToken: String)

/** §10.3 uniform auth failure: the Access assertion was rejected (HTTP 401). */
class AuthExpiredError(message: String) : Exception(message)

/** §10.3 authorization failure: the device/project is not allowed (HTTP 403). */
class ForbiddenError(message: String) : Exception(message)

/**
 * §8.2 idempotency conflict: the same (deviceId, idempotencyKey) was used
 * with a DIFFERENT payload. The conflicting command must never be retried.
 */
class IdempotencyConflictError(message: String) : Exception(message)

/**
 * §6.7 snapshot expiry (HTTP 410 SNAPSHOT_EXPIRED): recovery is always a
 * fresh snapshot.begin, hence retryable.
 */
class SnapshotExpiredError(val retryable: Boolean, message: String) : Exception(message)

/**
 * §11.6 storage pressure (HTTP 503 STORAGE_PRESSURE): the journal refuses
 * new user messages until the consumer ACKs and the sweep frees bytes.
 */
class StoragePressureError(val retryable: Boolean, message: String) : Exception(message)

/** Any other structured §8.3 command.error (code/message/retryable kept verbatim). */
class BridgeCommandError(
    val code: String,
    message: String,
    val retryable: Boolean,
    val httpStatus: Int,
) : Exception(message)

/** Non-protocol HTTP failure (unparseable body, gateway error, ...). */
class BridgeHttpException(val httpStatus: Int, val body: String) :
    Exception("bridge returned HTTP $httpStatus")

/** The synchronous HTTP command endpoint (§8.2 POST /api/v1/commands). */
interface BridgeCommandApi {
    suspend fun postCommand(command: ProtocolCommand): ProtocolResponse
}

/**
 * Builds the POST /api/v1/commands request with BOTH credential headers and
 * the ProtocolJson-encoded §8.2 envelope as the body. Pure; the production
 * [HttpBridgeApi] and the JVM tests share this exact code path.
 */
internal fun buildCommandHttpRequest(
    baseUrl: String,
    command: ProtocolCommand,
    credentials: BridgeCredentials,
): Request {
    val body = ProtocolJson.json.encodeToString(ProtocolCommand.serializer(), command)
    return Request.Builder()
        .url(baseUrl.trimEnd('/') + COMMANDS_PATH)
        .header(BridgeHeaders.AUTHORIZATION, "Bearer ${credentials.accessToken}")
        .header(BridgeHeaders.DEVICE_SESSION, credentials.deviceSessionToken)
        .post(body.toRequestBody(JSON_MEDIA_TYPE))
        .build()
}

/**
 * Maps an HTTP status + body to a typed outcome (§8.3):
 *
 * - 200..299 with no error block → the decoded [ProtocolResponse];
 * - 401/403 → uniform, detail-free auth errors (§10.3);
 * - 409 IDEMPOTENCY_CONFLICT → [IdempotencyConflictError] (no retry);
 * - 410 SNAPSHOT_EXPIRED → [SnapshotExpiredError] (retryable: re-begin);
 * - 503 STORAGE_PRESSURE → [StoragePressureError] (retryable after ACK/sweep);
 * - any other structured error → [BridgeCommandError] with the stable code;
 * - an unparseable body → [BridgeHttpException].
 */
internal fun parseCommandResponse(httpStatus: Int, bodyText: String): ProtocolResponse {
    if (httpStatus == 401) {
        throw AuthExpiredError("bridge rejected the Access assertion (HTTP 401)")
    }
    if (httpStatus == 403) {
        throw ForbiddenError("bridge rejected the device or project (HTTP 403)")
    }
    val response = try {
        ProtocolJson.json.decodeFromString(ProtocolResponse.serializer(), bodyText)
    } catch (e: SerializationException) {
        throw BridgeHttpException(httpStatus, bodyText)
    } catch (e: IllegalArgumentException) {
        throw BridgeHttpException(httpStatus, bodyText)
    }
    val error = response.error ?: return response
    when {
        httpStatus == 409 && error.code == CODE_IDEMPOTENCY_CONFLICT ->
            throw IdempotencyConflictError(error.message)
        httpStatus == 410 && error.code == CODE_SNAPSHOT_EXPIRED ->
            throw SnapshotExpiredError(error.retryable ?: true, error.message)
        httpStatus == 503 && error.code == CODE_STORAGE_PRESSURE ->
            throw StoragePressureError(error.retryable ?: true, error.message)
        else ->
            throw BridgeCommandError(error.code, error.message, error.retryable ?: false, httpStatus)
    }
}

/** OkHttp [BridgeCommandApi] against the bridge public host. */
class HttpBridgeApi(
    private val baseUrl: String,
    private val credentialsProvider: suspend () -> BridgeCredentials,
    private val client: OkHttpClient = OkHttpClient(),
) : BridgeCommandApi {

    override suspend fun postCommand(command: ProtocolCommand): ProtocolResponse {
        val request = buildCommandHttpRequest(baseUrl, command, credentialsProvider())
        val status: Int
        val body: String
        client.newCall(request).await().use { response ->
            status = response.code
            body = response.body?.string().orEmpty()
        }
        return parseCommandResponse(status, body)
    }
}

private const val COMMANDS_PATH = "/api/v1/commands"
private val JSON_MEDIA_TYPE = "application/json".toMediaType()

/** Stable error codes shared with bridge/src/commands/command-dispatcher.ts. */
private const val CODE_IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
private const val CODE_SNAPSHOT_EXPIRED = "SNAPSHOT_EXPIRED"
private const val CODE_STORAGE_PRESSURE = "STORAGE_PRESSURE"

/** Suspends until the OkHttp [Call] completes; cancels the call on coroutine cancel. */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    enqueue(
        object : Callback {
            override fun onFailure(call: Call, e: java.io.IOException) {
                continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                continuation.resume(response)
            }
        },
    )
    continuation.invokeOnCancellation { runCatching { cancel() } }
}
