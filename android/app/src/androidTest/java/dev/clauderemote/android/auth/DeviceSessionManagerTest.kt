package dev.clauderemote.android.auth

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.clauderemote.android.security.DeviceKeyManager
import dev.clauderemote.android.security.buildSigningBytes
import java.io.File
import java.security.KeyFactory
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device tests for the device-session flow (spec §10.3) exercising the
 * REAL pieces end to end:
 *
 * - the REAL Android Keystore P-256 key ([DeviceKeyManager], test alias):
 *   every signature is produced by the non-exportable hardware key;
 * - the REAL [EncryptedTokenStore] (MasterKey AES-256-GCM
 *   EncryptedSharedPreferences): the 15-minute session token is cached there
 *   and never appears in plaintext at rest;
 * - the REAL [OAuthManager] orchestrator over the encrypted access store;
 * - the REAL platform App Link verifier through the package manager.
 *
 * The bridge is an in-process fake that behaves like
 * bridge/src/auth/device-auth.ts: single-use challenges, byte-for-byte
 * `accessSubject` echo enforcement, and full server-side reconstruction of
 * the signing bytes from ITS OWN record (bridge-canonical `hostAscii`,
 * verbatim subject) followed by real ECDSA verification against the device's
 * SPKI — so a client that normalizes either field fails loudly.
 */
@RunWith(AndroidJUnit4::class)
class DeviceSessionManagerTest {

    /** Distinct from DeviceKeyManager.DEFAULT_ALIAS — never touches the real pairing key. */
    private val alias = "device-session-manager-test"

    /** Distinct encrypted prefs file — never touches production tokens. */
    private val storeFileName = "device_session_manager_test_tokens"

    private val ctx: Context get() = ApplicationProvider.getApplicationContext()

    private lateinit var keyManager: DeviceKeyManager
    private lateinit var store: EncryptedTokenStore
    private lateinit var fakeBridge: FakeBridge
    private lateinit var events: MutableList<String>
    private lateinit var refresher: RecordingRefresher
    private lateinit var manager: DeviceSessionManager

    /** Mutable fake clock shared by the manager, the OAuth seed, and the fake bridge. */
    private var nowMs: Long = 0L

    @Before
    fun setUp() {
        nowMs = System.currentTimeMillis()
        keyManager = DeviceKeyManager(alias)
        keyManager.deleteKey()
        store = EncryptedTokenStore(ctx, storeFileName)
        store.clearAll()
        events = mutableListOf()
        refresher = RecordingRefresher(events) { nowMs }
        fakeBridge = FakeBridge(events, keyManager, { nowMs })
        manager = DeviceSessionManager(
            authApi = fakeBridge,
            oauth = OAuthManager(
                appLinkVerifier = { true },
                tokenStore = EncryptedAccessTokenStore(store),
                tokenRefresher = refresher,
            ),
            signer = keyManager,
            sessionCache = EncryptedDeviceSessionCache(store),
            now = { nowMs },
        )
    }

    @After
    fun tearDown() {
        runCatching { keyManager.deleteKey() }
        runCatching { store.clearAll() }
    }

    // -------------------------------------------------------------------
    // Full challenge → sign → verify flow on the real key
    // -------------------------------------------------------------------

    @Test
    fun fullFlowSignsBridgeCanonicalBytesVerbatimAndCachesTheSession() = runBlocking {
        seedValidAccess()

        val token = manager.getValidDeviceSessionToken()

        // The fake bridge verified a REAL Keystore ECDSA signature over the
        // bytes IT reconstructed (hostAscii "BRIDGE.example.com" verbatim,
        // non-ASCII subject verbatim); any local normalization would have
        // failed inside the fake and thrown here.
        assertEquals(1, fakeBridge.challengeCount)
        assertEquals(1, fakeBridge.verifyCount)

        // 15-minute token cached in the REAL encrypted store.
        val cached = store.getDeviceSessionToken()
        assertEquals(token, cached?.token)
        assertEquals(nowMs + FakeBridge.SESSION_TTL_MS, cached?.expiresAtMs)

        // The opaque token never exists in plaintext at rest.
        val prefsFile = File(File(ctx.filesDir.parentFile, "shared_prefs"), "$storeFileName.xml")
        assertTrue("encrypted prefs file exists", prefsFile.isFile)
        val atRest = prefsFile.readBytes().toString(Charsets.ISO_8859_1)
        assertTrue(
            "device session token must not appear in plaintext at rest",
            token !in atRest,
        )
    }

    @Test
    fun cachedSessionIsReusedWithinTheWindowWithoutAnotherChallenge() = runBlocking {
        seedValidAccess()
        val first = manager.getValidDeviceSessionToken()
        nowMs += FakeBridge.SESSION_TTL_MS - 60_001

        val second = manager.getValidDeviceSessionToken()

        assertEquals(first, second)
        assertEquals(1, fakeBridge.challengeCount)
        assertEquals(1, fakeBridge.verifyCount)
    }

    @Test
    fun sessionInsideTheRefreshWindowIsRefreshedWithAFreshChallengeAndSignature() = runBlocking {
        seedValidAccess()
        val first = manager.getValidDeviceSessionToken()
        val firstSignature = fakeBridge.verifyRequests[0].signatureB64u
        nowMs += FakeBridge.SESSION_TTL_MS - 30_000 // inside the 60 s window

        val second = manager.getValidDeviceSessionToken()

        // A fresh single-use challenge + a fresh signature from the REAL key;
        // the previous token is replaced.
        assertEquals(2, fakeBridge.challengeCount)
        assertEquals(2, fakeBridge.verifyCount)
        assertNotEquals(first, second)
        assertNotEquals(
            fakeBridge.verifyRequests[0].challengeId,
            fakeBridge.verifyRequests[1].challengeId,
        )
        assertNotEquals(firstSignature, fakeBridge.verifyRequests[1].signatureB64u)
        assertEquals(second, store.getDeviceSessionToken()?.token)
    }

    // -------------------------------------------------------------------
    // Refresh ordering and failure surfacing
    // -------------------------------------------------------------------

    @Test
    fun accessRefreshRunsBeforeTheChallengeWhenAccessAlsoExpiring() = runBlocking {
        // Access expires inside the same 60 s window as the session refresh.
        store.putAccessToken("short-access", nowMs + 30_000)
        store.putRefreshToken("refresh-1")

        val token = manager.getValidDeviceSessionToken()

        assertEquals(listOf("access-refresh", "challenge", "verify"), events)
        assertEquals("refreshed-access", store.getAccessToken()?.token)
        assertEquals(token, store.getDeviceSessionToken()?.token)
    }

    @Test
    fun deadAccessRefreshSurfacesReLoginWithoutTouchingTheBridge() = runBlocking {
        store.putAccessToken("stale-access", nowMs - 1)
        store.putRefreshToken("refresh-1")
        refresher.failWith = IllegalStateException("refresh_token grant rejected")

        try {
            manager.getValidDeviceSessionToken()
            fail("expected ReLoginRequiredError")
        } catch (expected: ReLoginRequiredError) {
            assertEquals("refresh_token grant rejected", expected.cause!!.message)
        }
        assertEquals(0, fakeBridge.challengeCount)
        assertEquals(0, fakeBridge.verifyCount)
        assertNull(store.getDeviceSessionToken())
    }

    @Test
    fun verifyRejectionSurfacesReLoginAndClearsTheEncryptedCache() = runBlocking {
        seedValidAccess()
        manager.getValidDeviceSessionToken()
        fakeBridge.rejectVerify = true
        nowMs += FakeBridge.SESSION_TTL_MS - 30_000 // force a refresh

        try {
            manager.getValidDeviceSessionToken()
            fail("expected ReLoginRequiredError")
        } catch (expected: ReLoginRequiredError) {
            // uniform, detail-free — re-login UI
        }
        assertNull("encrypted session cache must be cleared for re-login", store.getDeviceSessionToken())
    }

    // -------------------------------------------------------------------
    // Pairing against the real key
    // -------------------------------------------------------------------

    @Test
    fun pairDeviceSubmitsTheRealSpkiAndDeviceId() = runBlocking {
        seedValidAccess()

        val returned = manager.pairDevice("pair-token-1", displayName = "Redmi test")

        val request = fakeBridge.pairRequests.single()
        assertEquals(keyManager.deviceId(), request.deviceId)
        assertEquals(b64u(keyManager.publicKeySpkiDer()), request.publicKeySpkiB64u)
        assertEquals("pair-token-1", request.pairingToken)
        assertEquals("Redmi test", request.displayName)
        assertEquals(keyManager.deviceId(), returned)
    }

    // -------------------------------------------------------------------
    // App Link preflight through the REAL package manager
    // -------------------------------------------------------------------

    @Test
    fun preflightRefusesAHostThatIsNotAVerifiedAppLink() {
        // This test APK declares no verified https App Link domain, so the
        // platform verifier must report the bridge host as unverified and
        // OAuth must refuse to start (Phase 0 rule: browser fallback does
        // not pass).
        val verifier = PlatformAppLinkVerifier(ctx)
        assertTrue(!verifier.isVerified("bridge.example.com"))

        val oauth = OAuthManager(verifier, EncryptedAccessTokenStore(store), refresher)
        try {
            oauth.prepareAuthorization("bridge.example.com")
            fail("expected AppLinkUnverifiedError")
        } catch (expected: AppLinkUnverifiedError) {
            assertEquals("bridge.example.com", expected.host)
        }
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    private fun seedValidAccess() {
        store.putAccessToken("valid-access", nowMs + 3_600_000)
        store.putRefreshToken("refresh-1")
    }

    private class RecordingRefresher(
        private val events: MutableList<String>,
        private val clock: () -> Long,
    ) : TokenRefresher {
        var failWith: Throwable? = null

        override suspend fun refresh(refreshToken: String): AccessTokens {
            events += "access-refresh"
            failWith?.let { throw it }
            return AccessTokens("refreshed-access", refreshToken, clock() + 3_600_000)
        }
    }

    /**
     * In-process bridge mirroring bridge/src/auth/device-auth.ts: single-use
     * challenges (record removed on consume), enforced byte-for-byte subject
     * echo, server-side reconstruction of the signing bytes from its own
     * record, and real ECDSA verification against the device SPKI.
     */
    private class FakeBridge(
        private val events: MutableList<String>,
        private val keyManager: DeviceKeyManager,
        private val clock: () -> Long,
    ) : BridgeAuthApi {
        var rejectVerify = false
        var challengeCount = 0
        var verifyCount = 0
        val verifyRequests = mutableListOf<VerifyRequest>()
        val pairRequests = mutableListOf<PairRequest>()
        private val challenges = HashMap<String, ChallengeRecord>()

        override suspend fun pair(request: PairRequest, accessToken: String): String {
            events += "pair"
            pairRequests += request
            return request.deviceId
        }

        override suspend fun requestChallenge(deviceId: String, accessToken: String): ChallengeResponse {
            events += "challenge"
            challengeCount++
            assertEquals(keyManager.deviceId(), deviceId)
            val challengeId = UUID.randomUUID().toString()
            val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
            challenges[challengeId] = ChallengeRecord(raw, SUBJECT, HOST_ASCII)
            return ChallengeResponse(
                challengeId = challengeId,
                challengeRawB64u = b64u(raw),
                accessSubject = SUBJECT,
                hostAscii = HOST_ASCII,
                expiresAt = clock() + 60_000,
            )
        }

        override suspend fun verifySignature(request: VerifyRequest, accessToken: String): VerifyResponse {
            events += "verify"
            verifyCount++
            verifyRequests += request
            if (rejectVerify) {
                throw ReLoginRequiredError("bridge rejected authentication (HTTP 401)")
            }
            val record = challenges.remove(request.challengeId)
                ?: throw ReLoginRequiredError("challenge unknown, expired, or already used")
            assertEquals(
                "accessSubject must be echoed back byte-for-byte",
                record.accessSubject,
                request.accessSubjectEcho,
            )
            // Reconstruct the signed content from THIS record: hostAscii and
            // subject verbatim (never client-normalized), deviceId
            // server-side recomputed, challengeRaw stored raw.
            val signingBytes = buildSigningBytes(
                hostAscii = record.hostAscii,
                deviceId = keyManager.deviceId(),
                challengeId = request.challengeId,
                accessSubject = record.accessSubject,
                challengeRaw = record.challengeRaw,
            )
            val signatureDer = Base64.getUrlDecoder().decode(request.signatureB64u)
            val publicKey = KeyFactory.getInstance("EC")
                .generatePublic(X509EncodedKeySpec(keyManager.publicKeySpkiDer()))
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(publicKey)
            verifier.update(signingBytes)
            assertTrue(
                "REAL Keystore signature did not verify over the bridge-canonical bytes " +
                    "(hostAscii/accessSubject not used verbatim?)",
                verifier.verify(signatureDer),
            )
            val token = b64u(ByteArray(32).also { SecureRandom().nextBytes(it) })
            return VerifyResponse(token, clock() + SESSION_TTL_MS)
        }

        private data class ChallengeRecord(
            val challengeRaw: ByteArray,
            val accessSubject: String,
            val hostAscii: String,
        )

        companion object {
            /**
             * Bridge-canonical host that the client's local normalizeHost
             * would CHANGE (lowercase): signing locally-normalized bytes
             * fails verification, proving the response value is used
             * VERBATIM (§10.3 spec amendment).
             */
            const val HOST_ASCII = "BRIDGE.example.com"

            /** Non-ASCII subject — proves no Unicode normalization either. */
            const val SUBJECT = "user-设备-β@example.com"

            /** Spec §10.3: fifteen-minute device sessions. */
            const val SESSION_TTL_MS = 900_000L
        }
    }

    private companion object {
        fun b64u(bytes: ByteArray): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
