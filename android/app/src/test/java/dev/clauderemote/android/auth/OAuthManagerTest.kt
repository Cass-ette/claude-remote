package dev.clauderemote.android.auth

import java.security.MessageDigest
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
 * JVM unit tests for the OAuth user agent (spec §10.2), ported from the
 * quality-reviewed Cloudflare probe pattern
 * (probes/cloudflare/android-probe OAuthCoordinator + OAuthConfigTest) and
 * extended for the production app:
 *
 * - PKCE S256 derivation (never "plain");
 * - `state` carries 128 bits of entropy;
 * - discovery URI targets `/.well-known/oauth-authorization-server`;
 * - dynamic registration is a PUBLIC client: token_endpoint_auth_method
 *   "none", no client_secret in the request, and no secret ever surfaced
 *   from the parsed response;
 * - the redirect URI is the verified HTTPS App Link;
 * - Access-token refresh serializes through a mutex (single-flight);
 * - refresh failure / a missing refresh token surface re-login instead of
 *   any fallback;
 * - the App Link preflight refuses to start OAuth for an unverified host.
 *
 * No Robolectric, no network, no instrumentation: the pure logic only.
 */
class OAuthManagerTest {

    // -------------------------------------------------------------------
    // Discovery URI (§10.2 step 1)
    // -------------------------------------------------------------------

    @Test
    fun discoveryUri_targetsOAuthAuthorizationServerMetadata() {
        assertEquals(
            "https://bridge.example.com/.well-known/oauth-authorization-server",
            OAuthFlows.discoveryUri("bridge.example.com"),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun discoveryUri_rejectsBlankHost() {
        OAuthFlows.discoveryUri("   ")
    }

    @Test
    fun parseDiscoveryDocument_extractsRequiredEndpoints() {
        val doc = """
            {
              "issuer": "https://bridge.example.com",
              "authorization_endpoint": "https://bridge.example.com/cdn-cgi/access/sso/authorize",
              "token_endpoint": "https://bridge.example.com/cdn-cgi/access/sso/token",
              "registration_endpoint": "https://bridge.example.com/cdn-cgi/access/sso/reg",
              "response_types_supported": ["code"]
            }
        """.trimIndent()
        val endpoints = OAuthFlows.parseDiscoveryDocument(doc)
        assertEquals("https://bridge.example.com/cdn-cgi/access/sso/authorize", endpoints.authorizationEndpoint)
        assertEquals("https://bridge.example.com/cdn-cgi/access/sso/token", endpoints.tokenEndpoint)
        assertEquals("https://bridge.example.com/cdn-cgi/access/sso/reg", endpoints.registrationEndpoint)
    }

    @Test
    fun parseDiscoveryDocument_rejectsMissingRegistrationEndpoint() {
        // §10.2 step 2: the app dynamically registers as a public client, so a
        // discovery document without registration_endpoint is unusable.
        val doc = """
            {
              "issuer": "https://bridge.example.com",
              "authorization_endpoint": "https://bridge.example.com/authorize",
              "token_endpoint": "https://bridge.example.com/token"
            }
        """.trimIndent()
        try {
            OAuthFlows.parseDiscoveryDocument(doc)
            fail("expected failure for a discovery document without registration_endpoint")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message!!.contains("registration_endpoint"))
        }
    }

    // -------------------------------------------------------------------
    // Redirect URI — the verified App Link (§10.2 step 4)
    // -------------------------------------------------------------------

    @Test
    fun redirectUri_isHttpsAppLinkWithAuthCallbackPath() {
        val uri = OAuthFlows.redirectUri("bridge.example.com")
        assertEquals("https://bridge.example.com/auth/callback", uri)
        // HTTPS App Link only — custom schemes bypass domain verification and
        // are forbidden.
        assertTrue(uri.startsWith("https://"))
        assertTrue(uri.endsWith("/auth/callback"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun redirectUri_rejectsBlankHost() {
        OAuthFlows.redirectUri(" ")
    }

    // -------------------------------------------------------------------
    // PKCE S256 (§10.2 step 3/5)
    // -------------------------------------------------------------------

    @Test
    fun pkce_verifierIsUnreservedAlphabetOfCorrectLength() {
        val (verifier, _, _) = OAuthFlows.generatePkce()
        assertTrue("verifier length in 43..128", verifier.length in 43..128)
        assertTrue(
            "verifier only unreserved",
            verifier.all { it in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~" },
        )
    }

    @Test
    fun pkce_challengeMethodIsS256NeverPlain() {
        val (_, _, method) = OAuthFlows.generatePkce()
        assertEquals("S256", method)
    }

    @Test
    fun pkce_challengeIsBase64UrlSha256OfVerifier() {
        val (verifier, challenge, _) = OAuthFlows.generatePkce()
        // Independent recompute of BASE64URL(SHA256(verifier)) without padding.
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        val expected = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
        assertEquals(expected, challenge)
    }

    @Test
    fun pkce_eachCallProducesFreshPair() {
        val a = OAuthFlows.generatePkce()
        val b = OAuthFlows.generatePkce()
        assertNotEquals(a.verifier, b.verifier)
        assertNotEquals(a.challenge, b.challenge)
    }

    @Test(expected = IllegalArgumentException::class)
    fun pkce_pairRejectsPlainMethod() {
        OAuthFlows.PkcePair(verifier = "x".repeat(64), challenge = "abc", method = "plain")
    }

    // -------------------------------------------------------------------
    // state — 128 bits of entropy (§10.2 step 3)
    // -------------------------------------------------------------------

    @Test
    fun state_is128BitsOfHexEntropy() {
        val state = OAuthFlows.generateState()
        assertEquals("32 hex chars = 128 bits", 32, state.length)
        assertTrue("state is lowercase hex", state.all { it in "0123456789abcdef" })
    }

    @Test
    fun state_isFreshPerCall() {
        assertNotEquals(OAuthFlows.generateState(), OAuthFlows.generateState())
    }

    // -------------------------------------------------------------------
    // Dynamic registration as a public client (§10.2 step 2)
    // -------------------------------------------------------------------

    @Test
    fun registrationRequest_isPublicClientWithoutClientSecret() {
        val json = OAuthFlows.registrationRequestJson(
            redirectUri = "https://bridge.example.com/auth/callback",
            clientName = "Claude Remote Android",
        )
        // Parse back and assert structure rather than exact formatting.
        val parsed = kotlinx.serialization.json.Json.parseToJsonElement(json).let {
            it as kotlinx.serialization.json.JsonObject
        }
        assertEquals(
            "none",
            (parsed["token_endpoint_auth_method"] as kotlinx.serialization.json.JsonPrimitive).content,
        )
        assertEquals(
            listOf("https://bridge.example.com/auth/callback"),
            (parsed["redirect_uris"] as kotlinx.serialization.json.JsonArray)
                .map { (it as kotlinx.serialization.json.JsonPrimitive).content },
        )
        assertEquals(
            listOf("code"),
            (parsed["response_types"] as kotlinx.serialization.json.JsonArray)
                .map { (it as kotlinx.serialization.json.JsonPrimitive).content },
        )
        // The public-client invariant: no client_secret is EVER sent.
        assertTrue("no client_secret in registration request", !json.contains("client_secret"))
        assertNull(parsed["client_secret"])
    }

    @Test
    fun registrationResponse_exposesClientIdAndNeverSurfacesASecret() {
        // Some authorization servers issue a secret even to public clients;
        // the app ignores it — nothing in the parsed client holds a secret.
        val json = """
            {
              "client_id": "public-client-1",
              "client_secret": "must-be-ignored",
              "client_id_issued_at": 1700000000,
              "client_secret_expires_at": 0
            }
        """.trimIndent()
        val client = OAuthFlows.parseRegistrationResponse(json)
        assertEquals("public-client-1", client.clientId)
        // RegisteredClient has no field that could hold a secret, and the
        // ignored value does not surface anywhere in the parsed object.
        val fieldNames = OAuthFlows.RegisteredClient::class.java.declaredFields.map { it.name }
        assertTrue(
            "no secret-like field on RegisteredClient: $fieldNames",
            fieldNames.none { it.contains("secret", ignoreCase = true) },
        )
        assertTrue("must-be-ignored" !in client.toString())
    }

    @Test
    fun registrationResponse_requiresClientId() {
        try {
            OAuthFlows.parseRegistrationResponse("""{"client_name":"x"}""")
            fail("expected failure for a registration response without client_id")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message!!.contains("client_id"))
        }
    }

    // -------------------------------------------------------------------
    // Authorization-redirect parsing (§10.2 step 5)
    // -------------------------------------------------------------------

    @Test(expected = IllegalStateException::class)
    fun parseResponse_rejectsMissingState() {
        OAuthFlows.parseAuthorizationResponse(
            "https://bridge.example.com/auth/callback?code=abc",
            "expected-state",
        )
    }

    @Test(expected = IllegalStateException::class)
    fun parseResponse_rejectsStateMismatch() {
        OAuthFlows.parseAuthorizationResponse(
            "https://bridge.example.com/auth/callback?code=abc&state=wrong",
            "expected-state",
        )
    }

    @Test(expected = IllegalStateException::class)
    fun parseResponse_propagatesOAuthError() {
        OAuthFlows.parseAuthorizationResponse(
            "https://bridge.example.com/auth/callback?error=access_denied&state=st",
            "st",
        )
    }

    @Test
    fun parseResponse_returnsCodeWhenStateMatches() {
        val response = OAuthFlows.parseAuthorizationResponse(
            "https://bridge.example.com/auth/callback?code=AUTHCODE&state=st",
            "st",
        )
        assertEquals("AUTHCODE", response.code)
        assertEquals("st", response.state)
    }

    // -------------------------------------------------------------------
    // App Link preflight (Phase 0 rule: browser fallback does not pass)
    // -------------------------------------------------------------------

    @Test
    fun prepareAuthorization_refusesUnverifiedAppLinkHost() {
        val manager = OAuthManager(
            appLinkVerifier = { host -> host != "unverified.example.com" },
            tokenStore = FakeAccessTokenStore(),
            tokenRefresher = FakeTokenRefresher(),
        )
        try {
            manager.prepareAuthorization("unverified.example.com")
            fail("expected AppLinkUnverifiedError")
        } catch (expected: AppLinkUnverifiedError) {
            assertEquals("unverified.example.com", expected.host)
        }
    }

    @Test
    fun prepareAuthorization_onVerifiedHostReturnsPkceStateAndAppLinkRedirect() {
        val manager = OAuthManager(
            appLinkVerifier = { true },
            tokenStore = FakeAccessTokenStore(),
            tokenRefresher = FakeTokenRefresher(),
        )
        val prepared = manager.prepareAuthorization("bridge.example.com")
        assertEquals(OAuthFlows.redirectUri("bridge.example.com"), prepared.redirectUri)
        assertEquals(32, prepared.state.length)
        assertEquals("S256", prepared.pkce.method)
        assertEquals(64, prepared.pkce.verifier.length)
    }

    // -------------------------------------------------------------------
    // Access-token lifecycle: caching, single-flight refresh, re-login
    // -------------------------------------------------------------------

    @Test
    fun getValidAccessToken_returnsCachedTokenWithoutRefresh() = runBlocking {
        val store = FakeAccessTokenStore().apply {
            putAccess("cached-access", expiresAtMs = NOW + 600_000)
        }
        val refresher = FakeTokenRefresher()
        val manager = OAuthManager({ true }, store, refresher)

        assertEquals("cached-access", manager.getValidAccessToken(NOW))
        assertEquals(0, refresher.calls)
    }

    @Test
    fun getValidAccessToken_nullExpiryIsTreatedAsValid() = runBlocking {
        val store = FakeAccessTokenStore().apply { putAccess("opaque-access", expiresAtMs = null) }
        val refresher = FakeTokenRefresher()
        val manager = OAuthManager({ true }, store, refresher)

        assertEquals("opaque-access", manager.getValidAccessToken(NOW))
        assertEquals(0, refresher.calls)
    }

    @Test
    fun getValidAccessToken_refreshesWhenInsideWindowAndStoresResult() = runBlocking {
        val store = FakeAccessTokenStore().apply {
            putAccess("stale-access", expiresAtMs = NOW + 59_900)
            putRefreshToken("refresh-1")
        }
        val refresher = FakeTokenRefresher().apply {
            next = AccessTokens("fresh-access", "refresh-2", NOW + 1_800_000)
        }
        val manager = OAuthManager({ true }, store, refresher)

        assertEquals("fresh-access", manager.getValidAccessToken(NOW))
        assertEquals(listOf("refresh-1"), refresher.refreshTokensSeen)
        assertEquals("fresh-access", store.getAccess()!!.token)
        assertEquals(NOW + 1_800_000, store.getAccess()!!.expiresAtMs)
        assertEquals("refresh-2", store.getRefreshToken())

        // Cached now: a follow-up call performs no second refresh.
        assertEquals("fresh-access", manager.getValidAccessToken(NOW))
        assertEquals(1, refresher.calls)
    }

    @Test
    fun getValidAccessToken_concurrentCallsRefreshExactlyOnceThroughMutex() = runBlocking {
        val store = FakeAccessTokenStore().apply {
            putAccess("stale-access", expiresAtMs = NOW - 1)
            putRefreshToken("refresh-1")
        }
        val refresher = SlowCountingRefresher()
        val manager = OAuthManager({ true }, store, refresher)

        val tokens = (1..8).map { async { manager.getValidAccessToken(NOW) } }.awaitAll()

        assertEquals(1, refresher.calls)
        assertEquals(8, tokens.size)
        assertTrue(tokens.all { it == "fresh-access" })
    }

    @Test
    fun getValidAccessToken_forceRefreshBypassesTheCachedToken() = runBlocking {
        val store = FakeAccessTokenStore().apply {
            putAccess("cached-access", expiresAtMs = NOW + 600_000)
            putRefreshToken("refresh-1")
        }
        val refresher = FakeTokenRefresher().apply { next = AccessTokens("forced-access", null, NOW + 600_000) }
        val manager = OAuthManager({ true }, store, refresher)

        assertEquals("forced-access", manager.getValidAccessToken(NOW, forceRefresh = true))
        assertEquals(1, refresher.calls)
        // A null refresh token in the response keeps the previous one.
        assertEquals("refresh-1", store.getRefreshToken())
    }

    @Test
    fun getValidAccessToken_refreshFailureSurfacesReLoginAndClearsAccess() = runBlocking {
        val store = FakeAccessTokenStore().apply {
            putAccess("stale-access", expiresAtMs = NOW - 1)
            putRefreshToken("refresh-1")
        }
        val refresher = FakeTokenRefresher().apply { failWith = IllegalStateException("token endpoint 400") }
        val manager = OAuthManager({ true }, store, refresher)

        try {
            manager.getValidAccessToken(NOW)
            fail("expected ReLoginRequiredError")
        } catch (expected: ReLoginRequiredError) {
            assertEquals("token endpoint 400", expected.cause!!.message)
        }
        assertNull(store.getAccess())

        // Recovery: a later refresh that succeeds re-establishes access.
        refresher.failWith = null
        refresher.next = AccessTokens("recovered-access", "refresh-2", NOW + 600_000)
        assertEquals("recovered-access", manager.getValidAccessToken(NOW))
    }

    @Test
    fun getValidAccessToken_withoutRefreshTokenSurfacesReLogin() = runBlocking {
        val store = FakeAccessTokenStore()
        val manager = OAuthManager({ true }, store, FakeTokenRefresher())

        try {
            manager.getValidAccessToken(NOW)
            fail("expected ReLoginRequiredError")
        } catch (expected: ReLoginRequiredError) {
            // no fallback token source exists — by design
        }
    }

    // -------------------------------------------------------------------
    // Fakes
    // -------------------------------------------------------------------

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

    private class FakeTokenRefresher : TokenRefresher {
        var next: AccessTokens = AccessTokens("fresh-access", "refresh-2", Long.MAX_VALUE)
        var failWith: Throwable? = null
        var calls = 0
        val refreshTokensSeen = mutableListOf<String>()

        override suspend fun refresh(refreshToken: String): AccessTokens {
            calls++
            refreshTokensSeen += refreshToken
            failWith?.let { throw it }
            return next
        }
    }

    /** Serializes refresh attempts with a delay to prove mutex single-flight. */
    private class SlowCountingRefresher : TokenRefresher {
        var calls = 0

        override suspend fun refresh(refreshToken: String): AccessTokens {
            calls++
            delay(100)
            return AccessTokens("fresh-access", refreshToken, Long.MAX_VALUE)
        }
    }

    private companion object {
        const val NOW = 1_700_000_000_000L
    }
}
