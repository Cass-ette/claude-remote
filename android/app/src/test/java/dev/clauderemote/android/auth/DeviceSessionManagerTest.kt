package dev.clauderemote.android.auth

import dev.clauderemote.android.security.DeviceSigner
import dev.clauderemote.android.security.buildSigningBytes
import java.util.Base64
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * JVM unit tests for the pure orchestration of the device-session flow
 * (spec §10.3) against an in-process fake [BridgeAuthApi]:
 *
 * - /auth/challenge returns `{challengeId, challengeRawB64u, accessSubject,
 *   hostAscii, expiresAt}` exactly as the bridge sends it (Task 24 wire
 *   shape);
 * - the device signs EXACTLY the received bytes, with the bridge-canonical
 *   `hostAscii` used VERBATIM (never locally normalized) and the challenge's
 *   `accessSubject` UTF-8 encoded as received (never Unicode-normalized);
 * - `accessSubject` is echoed back byte-for-byte;
 * - a cached device session inside the 60 s refresh window is refreshed with
 *   a FRESH challenge + signature (single-use challenges make any signature
 *   replay useless);
 * - refresh requires a still-valid Access token: if Access also expires
 *   within the window, Access is refreshed FIRST, then the challenge is
 *   requested, then /auth/verify;
 * - refresh failure surfaces re-login ([ReLoginRequiredError]) — no
 *   fallbacks, no swallowing;
 * - concurrent calls are single-flight through a mutex;
 * - pairing submits the pairing token, the SPKI, and the recomputed
 *   deviceId.
 *
 * The on-device variant (androidTest) reruns the critical paths against the
 * REAL Android Keystore key and the REAL EncryptedTokenStore, with a fake
 * bridge that cryptographically verifies the signature.
 */
class DeviceSessionManagerTest {

    // -------------------------------------------------------------------
    // Wire shape (mirror of bridge/src/server/http-routes.ts, Task 24)
    // -------------------------------------------------------------------

    @Test
    fun challengeResponse_decodesTheExactBridgeWireShape() {
        val wire = """
            {
              "challengeId": "4b3d0fd9-765d-4065-be00-6fc7ff075b05",
              "challengeRawB64u": "c2Vsb2RvbS1jaGFsbGVuZ2UtcmF3LTMyLWJ5dGVz",
              "accessSubject": "user@example.com",
              "hostAscii": "bridge.example.com",
              "expiresAt": 1700000060000
            }
        """.trimIndent()
        val response = BridgeAuthWire.json.decodeFromString(ChallengeResponse.serializer(), wire)
        assertEquals("4b3d0fd9-765d-4065-be00-6fc7ff075b05", response.challengeId)
        assertEquals("user@example.com", response.accessSubject)
        assertEquals("bridge.example.com", response.hostAscii)
        assertEquals(1700000060000L, response.expiresAt)
    }

    @Test
    fun verifyResponse_decodesTheExactBridgeWireShape() {
        val wire = """{"deviceSessionToken": "abc123", "expiresAt": 1700000900000}"""
        val response = BridgeAuthWire.json.decodeFromString(VerifyResponse.serializer(), wire)
        assertEquals("abc123", response.deviceSessionToken)
        assertEquals(1700000900000L, response.expiresAt)
    }

    @Test
    fun pairRequest_omitsNullDisplayNameOnTheWire() {
        val wire = BridgeAuthWire.json.encodeToString(
            PairRequest.serializer(),
            PairRequest(pairingToken = "pt", publicKeySpkiB64u = "spki", deviceId = "dev"),
        )
        assertTrue(wire.contains("pairingToken"))
        assertTrue(!wire.contains("displayName"))
    }

    // -------------------------------------------------------------------
    // Sign-and-verify flow
    // -------------------------------------------------------------------

    @Test
    fun challengeRequestCarriesDeviceIdAndBearerAccessToken() = runBlocking {
        val fixture = Fixture()
        fixture.manager.getValidDeviceSessionToken()

        assertEquals(listOf(DEVICE_ID), fixture.api.challengeDeviceIdsSeen)
        // Both the challenge and the verify call ride the same Bearer Access.
        assertEquals(listOf("valid-access", "valid-access"), fixture.api.bearerTokensSeen)
    }

    @Test
    fun signsExactlyTheBridgeCanonicalBytes_hostAsciiAndSubjectUsedVerbatim() = runBlocking {
        val fixture = Fixture(challengeHostAscii = "BRIDGE.example.com")
        fixture.manager.getValidDeviceSessionToken()

        val signed = fixture.signer.signedBytes.single()
        // Independently reconstructed from the CHALLENGE RESPONSE fields:
        // hostAscii verbatim (NOT normalizeHost("BRIDGE.example.com")),
        // accessSubject UTF-8 verbatim (NOT Unicode-normalized).
        val expected = buildSigningBytes(
            hostAscii = "BRIDGE.example.com",
            deviceId = DEVICE_ID,
            challengeId = fixture.api.lastChallenge!!.challengeId,
            accessSubject = "user-éλ@example.com",
            challengeRaw = Base64.getUrlDecoder()
                .decode(fixture.api.lastChallenge!!.challengeRawB64u),
        )
        assertTrue(java.util.Arrays.equals(expected, signed))
    }

    @Test
    fun accessSubjectIsEchoedBackByteForByte() = runBlocking {
        val fixture = Fixture()
        fixture.manager.getValidDeviceSessionToken()

        val verify = fixture.api.verifyRequests.single()
        assertEquals(fixture.api.lastChallenge!!.accessSubject, verify.accessSubjectEcho)
        assertEquals(fixture.api.lastChallenge!!.challengeId, verify.challengeId)
        // signatureB64u is unpadded base64url of exactly the signer's output.
        assertTrue(
            java.util.Arrays.equals(
                SIGNATURE_DER,
                Base64.getUrlDecoder().decode(verify.signatureB64u),
            ),
        )
    }

    @Test
    fun sessionTokenIsCachedWithTheBridgeExpiry() = runBlocking {
        val fixture = Fixture()
        val token = fixture.manager.getValidDeviceSessionToken()

        assertEquals("session-token-1", token)
        assertEquals("session-token-1", fixture.cache.cached?.token)
        assertEquals(NOW + 900_000, fixture.cache.cached?.expiresAtMs)
    }

    @Test
    fun cachedTokenOutsideTheRefreshWindowIsReturnedWithoutBridgeCalls() = runBlocking {
        val fixture = Fixture()
        fixture.cache.cached = CachedDeviceSession("warm-token", expiresAtMs = NOW + 60_001)

        assertEquals("warm-token", fixture.manager.getValidDeviceSessionToken())
        assertEquals(0, fixture.api.challengeCount)
    }

    @Test
    fun cachedTokenInsideTheRefreshWindowTriggersFreshChallengeAndSignature() = runBlocking {
        val fixture = Fixture()
        fixture.cache.cached = CachedDeviceSession("cooling-token", expiresAtMs = NOW + 59_999)

        assertEquals("session-token-1", fixture.manager.getValidDeviceSessionToken())
        assertEquals(1, fixture.api.challengeCount)
        assertEquals(1, fixture.api.verifyRequests.size)
        // The expiring token was replaced in the cache.
        assertEquals("session-token-1", fixture.cache.cached?.token)
    }

    @Test
    fun expiredTokenTriggersRefreshWithAFreshSignatureOverFreshBytes() = runBlocking {
        val fixture = Fixture()
        fixture.cache.cached = CachedDeviceSession("expired-token", expiresAtMs = NOW - 1)
        fixture.manager.getValidDeviceSessionToken()

        val firstChallenge = fixture.api.challengeId(0)
        // Advance the clock until the minted 15-minute token is itself
        // inside the 60 s refresh window (Access stays valid — margin left).
        fixture.nowMs = NOW + DEVICE_SESSION_TTL_MS - 30_000
        fixture.manager.getValidDeviceSessionToken() // second refresh

        // Two distinct single-use challenges, two distinct signed contents —
        // refresh ALWAYS requires a fresh signature (spec §10.3).
        assertEquals(2, fixture.api.challengeCount)
        assertNotEquals(firstChallenge, fixture.api.challengeId(1))
        assertEquals(2, fixture.signer.signedBytes.size)
        assertTrue(
            !java.util.Arrays.equals(fixture.signer.signedBytes[0], fixture.signer.signedBytes[1]),
        )
    }

    @Test
    fun accessRefreshHappensBeforeChallengeWhenAccessAlsoExpiring() = runBlocking {
        val fixture = Fixture(accessExpiresAtMs = NOW + 30_000) // inside the same 60 s window
        fixture.manager.getValidDeviceSessionToken()

        assertEquals(
            listOf("access-refresh", "challenge", "sign", "verify"),
            fixture.events,
        )
    }

    @Test
    fun deadAccessRefreshSurfacesReLoginWithoutTouchingTheBridge() = runBlocking {
        val fixture = Fixture(accessExpiresAtMs = NOW - 1)
        fixture.oauthRefresher.failWith = IllegalStateException("refresh_token is invalid")

        try {
            fixture.manager.getValidDeviceSessionToken()
            fail("expected ReLoginRequiredError")
        } catch (expected: ReLoginRequiredError) {
            assertEquals("refresh_token is invalid", expected.cause!!.message)
        }
        assertEquals(0, fixture.api.challengeCount)
        assertEquals(0, fixture.api.verifyRequests.size)
    }

    @Test
    fun verifyRejectionSurfacesReLoginAndClearsTheSessionCache() = runBlocking {
        val fixture = Fixture(verifyOutcome = VerifyOutcome.REJECT)
        fixture.cache.cached = CachedDeviceSession("stale-session", expiresAtMs = NOW - 1)

        try {
            fixture.manager.getValidDeviceSessionToken()
            fail("expected ReLoginRequiredError")
        } catch (expected: ReLoginRequiredError) {
            // uniform, detail-free — the bridge never says which check failed
        }
        assertNull("session cache must be cleared for re-login", fixture.cache.cached)
    }

    @Test
    fun concurrentCallsAreSingleFlightOverOneChallenge() = runBlocking {
        val fixture = Fixture()
        fixture.api.challengeDelayMs = 100

        val tokens = listOf(
            async { fixture.manager.getValidDeviceSessionToken() },
            async { fixture.manager.getValidDeviceSessionToken() },
        ).awaitAll()

        assertEquals(1, fixture.api.challengeCount)
        assertEquals(listOf("session-token-1", "session-token-1"), tokens)
    }

    @Test
    fun pairDeviceSubmitsPairingTokenSpkiAndDeviceId() = runBlocking {
        val fixture = Fixture()
        val returnedDeviceId = fixture.manager.pairDevice(
            pairingToken = "pair-token-1",
            displayName = "Pixel 9",
        )

        val request = fixture.api.pairRequests.single()
        assertEquals("pair-token-1", request.pairingToken)
        assertEquals(DEVICE_ID, request.deviceId)
        assertEquals(b64u(SPKI_DER), request.publicKeySpkiB64u)
        assertEquals("Pixel 9", request.displayName)
        assertEquals(DEVICE_ID, returnedDeviceId)
        assertEquals(listOf("valid-access"), fixture.api.bearerTokensSeen)
    }

    // -------------------------------------------------------------------
    // Fixture: fakes wired to the REAL OAuthManager orchestrator
    // -------------------------------------------------------------------

    private enum class VerifyOutcome { OK, REJECT }

    private class FakeAccessTokenStore : AccessTokenStore {
        private var access: StoredAccessToken? = null
        private var refresh: String? = null

        override fun getAccess(): StoredAccessToken? = access

        override fun getRefreshToken(): String? = refresh

        override fun putAccess(token: String, expiresAtMs: Long?) {
            access = StoredAccessToken(token, expiresAtMs)
        }

        override fun putRefreshToken(token: String) {
            refresh = token
        }

        override fun clearAccess() {
            access = null
        }
    }

    private class RecordingTokenRefresher(val events: MutableList<String>) : TokenRefresher {
        var failWith: Throwable? = null
        var calls = 0

        override suspend fun refresh(refreshToken: String): AccessTokens {
            calls++
            events += "access-refresh"
            failWith?.let { throw it }
            return AccessTokens("refreshed-access", refreshToken, Long.MAX_VALUE)
        }
    }

    /** Records the exact bytes it was asked to sign; returns a fixed blob. */
    private class RecordingSigner(private val events: MutableList<String>) : DeviceSigner {
        val signedBytes = mutableListOf<ByteArray>()

        override fun deviceId(): String = DEVICE_ID

        override fun publicKeySpkiDer(): ByteArray = SPKI_DER

        override fun sign(bytes: ByteArray): ByteArray {
            events += "sign"
            signedBytes += bytes
            return SIGNATURE_DER
        }
    }

    /** In-process bridge implementing the Task 24 surface. */
    private class FakeBridgeAuthApi(
        private val events: MutableList<String>,
        var challengeHostAscii: String,
        var verifyOutcome: VerifyOutcome,
        var challengeDelayMs: Long = 0,
    ) : BridgeAuthApi {
        val challengeDeviceIdsSeen = mutableListOf<String>()
        val bearerTokensSeen = mutableListOf<String>()
        val verifyRequests = mutableListOf<VerifyRequest>()
        val pairRequests = mutableListOf<PairRequest>()
        val challengeIds = mutableListOf<String>()
        var challengeCount = 0
        var lastChallenge: ChallengeResponse? = null
        private var sessionCounter = 0

        override suspend fun pair(request: PairRequest, accessToken: String): String {
            events += "pair"
            pairRequests += request
            bearerTokensSeen += accessToken
            return request.deviceId
        }

        override suspend fun requestChallenge(deviceId: String, accessToken: String): ChallengeResponse {
            challengeCount++
            events += "challenge"
            challengeDeviceIdsSeen += deviceId
            bearerTokensSeen += accessToken
            if (challengeDelayMs > 0) delay(challengeDelayMs)
            val challengeId = "00000000-0000-4000-8000-%012d".format(challengeCount)
            challengeIds += challengeId
            val response = ChallengeResponse(
                challengeId = challengeId,
                challengeRawB64u = b64u(ByteArray(32) { (it * challengeCount).toByte() }),
                accessSubject = SUBJECT,
                hostAscii = challengeHostAscii,
                expiresAt = NOW + 60_000,
            )
            lastChallenge = response
            return response
        }

        override suspend fun verifySignature(request: VerifyRequest, accessToken: String): VerifyResponse {
            events += "verify"
            verifyRequests += request
            bearerTokensSeen += accessToken
            if (verifyOutcome == VerifyOutcome.REJECT) {
                throw ReLoginRequiredError("bridge rejected the device signature (HTTP 401)")
            }
            sessionCounter++
            return VerifyResponse(
                deviceSessionToken = "session-token-$sessionCounter",
                expiresAt = NOW + DEVICE_SESSION_TTL_MS,
            )
        }

        fun challengeId(index: Int): String = challengeIds[index]
    }

    private class FakeSessionCache : DeviceSessionCache {
        var cached: CachedDeviceSession? = null

        override fun get(): CachedDeviceSession? = cached

        override fun put(token: String, expiresAtMs: Long) {
            cached = CachedDeviceSession(token, expiresAtMs)
        }

        override fun clear() {
            cached = null
        }
    }

    /**
     * One fully-wired manager over fakes. The OAuthManager is the REAL
     * orchestrator (only its store/refresher seams are faked), exactly as in
     * production.
     */
    private inner class Fixture(
        challengeHostAscii: String = "bridge.example.com",
        verifyOutcome: VerifyOutcome = VerifyOutcome.OK,
        accessExpiresAtMs: Long = NOW + 3_600_000,
    ) {
        val events = mutableListOf<String>()
        val api = FakeBridgeAuthApi(events, challengeHostAscii, verifyOutcome)
        val signer = RecordingSigner(events)
        val cache = FakeSessionCache()
        val oauthStore = FakeAccessTokenStore().apply {
            putAccess("valid-access", expiresAtMs = accessExpiresAtMs)
            putRefreshToken("refresh-1")
        }
        val oauthRefresher = RecordingTokenRefresher(events)
        private val oauth = OAuthManager({ true }, oauthStore, oauthRefresher)
        var nowMs: Long = NOW

        val manager = DeviceSessionManager(
            authApi = api,
            oauth = oauth,
            signer = signer,
            sessionCache = cache,
            now = { nowMs },
        )
    }

    private companion object {
        const val NOW = 1_700_000_000_000L
        const val DEVICE_ID = "device-id-b64u"
        const val SUBJECT = "user-éλ@example.com"
        val SPKI_DER = byteArrayOf(0x30, 0x59, 0x30, 0x13, 0x06, 0x07)
        val SIGNATURE_DER = byteArrayOf(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02)

        /** Bridge default: 15-minute device sessions (§10.3). */
        const val DEVICE_SESSION_TTL_MS = 900_000L

        fun b64u(bytes: ByteArray): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
