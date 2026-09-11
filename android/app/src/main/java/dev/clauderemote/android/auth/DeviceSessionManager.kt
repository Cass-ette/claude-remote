package dev.clauderemote.android.auth

import dev.clauderemote.android.security.DeviceSigner
import dev.clauderemote.android.security.buildSigningBytes
import java.util.Base64
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Device-session lifecycle (spec §10.3): pairing, challenge/verify, and the
 * 15-minute opaque device session token.
 *
 * Layering (mirrors the probe's JVM-pure coordinator pattern):
 *
 * - [BridgeAuthApi] is the injectable bridge surface; [HttpBridgeAuthApi]
 *   is the OkHttp implementation whose wire shape mirrors Task 24's
 *   http-routes.ts exactly;
 * - [DeviceSessionManager] is PURE orchestration (JVM-testable with a fake
 *   API and a fake [DeviceSigner]): cache window decisions, the
 *   sign-and-verify flow, Access-first refresh ordering, single-flight
 *   refresh, and re-login surfacing;
 * - the on-device wiring pairs it with the REAL [DeviceSigner]
 *   (Android Keystore) and the REAL encrypted token cache.
 *
 * SECURITY INVARIANTS (§10.3):
 *   * The signing bytes are built from the CHALLENGE RESPONSE's
 *     bridge-canonical `hostAscii` and its original `accessSubject` string,
 *     both used VERBATIM — the app never runs its own IDNA or Unicode
 *     normalization over them (known legitimate divergences between the
 *     implementations, e.g. UTS46 vs IDNA2003 on ß, make local normalization
 *     a signature-failure and a substitution hazard).
 *   * `accessSubject` is echoed back byte-for-byte in /auth/verify.
 *   * Refreshing a device session ALWAYS performs a fresh single-use
 *     challenge signature — the token is never minted from stale bytes.
 *   * Tokens and signatures are never logged.
 */

/**
 * Strict wire JSON for the bridge auth endpoints. Unknown keys are drift and
 * must fail decoding (the bridge's responses are exactly the Task 24 shapes).
 */
internal object BridgeAuthWire {
    val json: Json = Json {
        encodeDefaults = false
        explicitNulls = false
    }
}

// ---------------------------------------------------------------------------
// Wire models (mirror bridge/src/server/http-routes.ts, Task 24)
// ---------------------------------------------------------------------------

/** POST /api/v1/auth/pair body. */
@Serializable
data class PairRequest(
    val pairingToken: String,
    val publicKeySpkiB64u: String,
    val deviceId: String,
    val displayName: String? = null,
)

/** POST /api/v1/auth/challenge body. */
@Serializable
data class ChallengeRequest(val deviceId: String)

/**
 * POST /api/v1/auth/challenge response. `challengeRawB64u` is 32 random
 * bytes as unpadded base64url; `hostAscii` is BRIDGE-CANONICAL and must be
 * signed verbatim; `accessSubject` is the original Access `sub` string.
 */
@Serializable
data class ChallengeResponse(
    val challengeId: String,
    val challengeRawB64u: String,
    val accessSubject: String,
    val hostAscii: String,
    val expiresAt: Long,
)

/** POST /api/v1/auth/verify body. `accessSubjectEcho` is byte-for-byte. */
@Serializable
data class VerifyRequest(
    val challengeId: String,
    val accessSubjectEcho: String,
    val signatureB64u: String,
)

/** POST /api/v1/auth/verify response. */
@Serializable
data class VerifyResponse(
    val deviceSessionToken: String,
    val expiresAt: Long,
)

/**
 * The bridge auth endpoints as an injectable seam. Production:
 * [HttpBridgeAuthApi]; tests: in-process fakes (JVM) or a cryptographically
 * verifying fake bridge (instrumented).
 */
interface BridgeAuthApi {
    /** POST /api/v1/auth/pair — returns the server-recomputed deviceId. */
    suspend fun pair(request: PairRequest, accessToken: String): String

    suspend fun requestChallenge(deviceId: String, accessToken: String): ChallengeResponse

    suspend fun verifySignature(request: VerifyRequest, accessToken: String): VerifyResponse
}

/** A cached device session: the opaque token plus its epoch-ms expiry. */
data class CachedDeviceSession(val token: String, val expiresAtMs: Long)

/**
 * Persistence seam for the current device session. Production:
 * [EncryptedDeviceSessionCache] over the Keystore-encrypted store; tests:
 * in-memory fakes.
 */
interface DeviceSessionCache {
    fun get(): CachedDeviceSession?

    fun put(token: String, expiresAtMs: Long)

    fun clear()
}

/**
 * Owns the device session against the bridge (§10.3):
 *
 * - [getValidDeviceSessionToken] always returns a token with more than
 *   [REFRESH_WINDOW_MS] of remaining life, taking the cached one when it is
 *   still comfortably valid;
 * - refresh (cache empty, expiring within the window, or after rejection)
 *   re-runs the full challenge → sign → verify round trip: a still-valid
 *   Access token is required, and when Access itself expires within the
 *   same window it is refreshed FIRST (Access refresh → fresh challenge
 *   signature → /auth/verify, in that order);
 * - refresh runs single-flight under a [Mutex];
 * - any rejection surfaces [ReLoginRequiredError] (re-login/re-pair UI) and
 *   clears the cached session — uniform and detail-free, as the bridge's own
 *   401/403 responses are.
 */
class DeviceSessionManager(
    private val authApi: BridgeAuthApi,
    private val oauth: OAuthManager,
    private val signer: DeviceSigner,
    private val sessionCache: DeviceSessionCache,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val refreshMutex = Mutex()

    /**
     * Enrolls this device with a one-time pairing token (§10.3 pairing
     * flow). Requires an already-established Access token. Returns the
     * server-recomputed deviceId.
     */
    suspend fun pairDevice(pairingToken: String, displayName: String? = null): String =
        authApi.pair(
            PairRequest(
                pairingToken = pairingToken,
                publicKeySpkiB64u = base64UrlNoPad(signer.publicKeySpkiDer()),
                deviceId = signer.deviceId(),
                displayName = displayName,
            ),
            oauth.getValidAccessToken(now()),
        )

    suspend fun getValidDeviceSessionToken(): String {
        cachedTokenIfValid(now())?.let { return it }
        return refreshMutex.withLock {
            cachedTokenIfValid(now())?.let { return@withLock it }
            establishDeviceSession()
        }
    }

    private suspend fun establishDeviceSession(): String {
        // Refresh Access FIRST when it expires inside the same window: the
        // challenge/verify round trip must complete on a still-valid Access
        // token (the bridge checks subject match against the CURRENT
        // assertion).
        val accessToken = oauth.getValidAccessToken(now(), minRemainingMs = REFRESH_WINDOW_MS)
        val deviceId = signer.deviceId()

        val challenge = authApi.requestChallenge(deviceId, accessToken)
        // hostAscii and accessSubject are used VERBATIM (bridge-canonical);
        // no local normalization of either, ever.
        val signingBytes = buildSigningBytes(
            hostAscii = challenge.hostAscii,
            deviceId = deviceId,
            challengeId = challenge.challengeId,
            accessSubject = challenge.accessSubject,
            challengeRaw = Base64.getUrlDecoder().decode(challenge.challengeRawB64u),
        )
        val signatureB64u = base64UrlNoPad(signer.sign(signingBytes))

        val session = try {
            authApi.verifySignature(
                VerifyRequest(
                    challengeId = challenge.challengeId,
                    accessSubjectEcho = challenge.accessSubject,
                    signatureB64u = signatureB64u,
                ),
                accessToken,
            )
        } catch (e: ReLoginRequiredError) {
            sessionCache.clear()
            throw e
        }
        sessionCache.put(session.deviceSessionToken, session.expiresAt)
        return session.deviceSessionToken
    }

    private fun cachedTokenIfValid(nowMs: Long): String? {
        val cached = sessionCache.get() ?: return null
        return if (nowMs < cached.expiresAtMs - REFRESH_WINDOW_MS) cached.token else null
    }

    companion object {
        /**
         * Device-session refresh window: refresh when less than 60 s of
         * token life remains (must stay shorter than the Access remaining
         * lifetime, else Access is refreshed first inside the same window).
         */
        const val REFRESH_WINDOW_MS = 60_000L

        /** Spec §10.3: device session tokens live fifteen minutes. */
        const val DEVICE_SESSION_TTL_MS = 900_000L
    }
}

/** Generic transport failure on a bridge auth endpoint (non-auth statuses). */
class BridgeApiError(message: String) : Exception(message)

/**
 * OkHttp [BridgeAuthApi] against the bridge public host. The request/response
 * bodies mirror Task 24's http-routes.ts exactly; every call carries
 * `Authorization: Bearer <access>`; 401/403 (the uniform §10.3 auth
 * failures) surface [ReLoginRequiredError].
 */
class HttpBridgeAuthApi(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient(),
) : BridgeAuthApi {

    override suspend fun pair(request: PairRequest, accessToken: String): String =
        post(PATH_PAIR, request, PairRequest.serializer(), PairResponse.serializer(), accessToken).deviceId

    override suspend fun requestChallenge(deviceId: String, accessToken: String): ChallengeResponse =
        post(
            PATH_CHALLENGE,
            ChallengeRequest(deviceId),
            ChallengeRequest.serializer(),
            ChallengeResponse.serializer(),
            accessToken,
        )

    override suspend fun verifySignature(request: VerifyRequest, accessToken: String): VerifyResponse =
        post(
            PATH_VERIFY,
            request,
            VerifyRequest.serializer(),
            VerifyResponse.serializer(),
            accessToken,
        )

    @Serializable
    private data class PairResponse(val deviceId: String)

    private suspend fun <Req : Any, Res : Any> post(
        path: String,
        request: Req,
        requestSerializer: KSerializer<Req>,
        responseSerializer: KSerializer<Res>,
        accessToken: String,
    ): Res {
        val body = BridgeAuthWire.json.encodeToString(requestSerializer, request)
        val httpRequest = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header(HEADER_AUTHORIZATION, "Bearer $accessToken")
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        val responseText = client.newCall(httpRequest).await().use { response ->
            if (response.code == 401 || response.code == 403) {
                // Uniform, detail-free auth failure (§10.3) — the body never
                // says which check failed, and neither do we.
                throw ReLoginRequiredError(
                    "bridge rejected authentication (HTTP ${response.code})",
                )
            }
            if (!response.isSuccessful) {
                throw BridgeApiError("bridge auth endpoint $path failed (HTTP ${response.code})")
            }
            response.body?.string().orEmpty()
        }
        return BridgeAuthWire.json.decodeFromString(responseSerializer, responseText)
    }

    private companion object {
        const val PATH_PAIR = "/api/v1/auth/pair"
        const val PATH_CHALLENGE = "/api/v1/auth/challenge"
        const val PATH_VERIFY = "/api/v1/auth/verify"
        const val HEADER_AUTHORIZATION = "Authorization"
        val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }
}

private fun base64UrlNoPad(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

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
