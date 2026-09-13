package dev.clauderemote.android.auth

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.annotation.RequiresApi
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.openid.appauth.AppAuthConfiguration
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.GrantTypeValues
import net.openid.appauth.NoClientAuthentication
import net.openid.appauth.ResponseTypeValues
import net.openid.appauth.TokenRequest
import net.openid.appauth.connectivity.ConnectionBuilder
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * OAuth user agent for Cloudflare Access Managed OAuth (spec §10.2).
 *
 * Layering mirrors the quality-reviewed Cloudflare probe
 * (probes/cloudflare/android-probe OAuthCoordinator):
 *
 * - [OAuthFlows] is PURE JVM (PKCE, state, discovery/registration parsing,
 *   redirect parsing) and is covered by JVM unit tests;
 * - [OAuthManager] orchestrates the Access-token lifecycle (cache +
 *   mutex-serialized single-flight refresh) and is likewise JVM-testable via
 *   injected seams ([AppLinkVerifier], [AccessTokenStore], [TokenRefresher]);
 * - the AppAuth-Android glue ([AppAuthGateway], [AppAuthTokenRefresher],
 *   [PlatformAppLinkVerifier]) is thin, Android-bound, and exercised on
 *   device.
 *
 * SECURITY INVARIANTS (§10.2):
 *   * Authorization Code + PKCE S256 only — never "plain", and never the
 *     browser's `CF_Authorization` cookie (the app has no cookie access and
 *     no service-token fallback).
 *   * `state` carries 128 bits of [SecureRandom] entropy and is compared in
 *     constant time on the redirect.
 *   * Dynamic registration is a PUBLIC client
 *     (`token_endpoint_auth_method=none`): no client_secret is ever sent,
 *     stored, or surfaced.
 *   * The redirect URI is the verified HTTPS Android App Link; OAuth is
 *     refused for a host that is not domain-verified
 *     ([AppLinkUnverifiedError], mirroring the Phase 0 runner rule "browser
 *     fallback does not pass").
 */

/** Raised when the OAuth redirect host is not a verified Android App Link. */
class AppLinkUnverifiedError(val host: String) :
    Exception("refusing to start OAuth: \"$host\" is not a verified Android App Link")

/**
 * Raised when the user must re-authenticate: the refresh token is gone or
 * dead, or the bridge rejected the (re)established credentials. Callers
 * surface the re-login UI; there is no fallback credential source.
 */
class ReLoginRequiredError(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Answers whether [host] is a VERIFIED Android App Link of THIS app.
 * Unverified hosts must never start the OAuth flow.
 */
fun interface AppLinkVerifier {
    fun isVerified(host: String): Boolean
}

/**
 * Pure-JVM OAuth flow helpers (ported from the probe's OAuthCoordinator and
 * adapted to the bridge host / RFC 8414 metadata endpoint). No Android, no
 * I/O, no clock — fully covered by JVM unit tests.
 */
object OAuthFlows {

    /** PKCE code verifier length (within the RFC 7636 43..128 range). */
    private const val VERIFIER_LENGTH = 64

    /** `state` entropy: 128 bits (spec §10.2 step 3), hex-encoded to 32 chars. */
    private const val STATE_BYTES = 16

    private const val UNRESERVED =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

    const val DEFAULT_CLIENT_NAME = "Claude Remote Android"

    /** OAuth metadata is extensible (RFC 8414), so unknown keys are ignored. */
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Discovery URI of the OAuth authorization server fronting the bridge
     * (§10.2 step 1).
     */
    fun discoveryUri(host: String): String {
        require(host.isNotBlank()) { "host must not be blank" }
        return "https://$host/.well-known/oauth-authorization-server"
    }

    /**
     * OAuth redirect URI for this install: the HTTPS Android App Link of the
     * bridge host (§10.2 step 4). Custom schemes are forbidden — they bypass
     * domain verification.
     */
    fun redirectUri(host: String): String {
        require(host.isNotBlank()) { "host must not be blank" }
        return "https://$host/auth/callback"
    }

    /** Generates a fresh PKCE pair (verifier + S256 challenge, never "plain"). */
    fun generatePkce(): PkcePair {
        val verifier = randomUnreserved(VERIFIER_LENGTH)
        val challenge = sha256Base64Url(verifier)
        return PkcePair(verifier = verifier, challenge = challenge, method = "S256")
    }

    /** Generates a fresh opaque `state` (128 bits of entropy, lowercase hex). */
    fun generateState(): String {
        val bytes = ByteArray(STATE_BYTES)
        SecureRandom().nextBytes(bytes)
        return bytes.toHex()
    }

    /**
     * Everything a fresh authorization request needs: PKCE pair, state, and
     * the App Link redirect URI. Returned as one unit so callers cannot mix
     * pairs from different attempts.
     */
    fun prepareAuthorization(host: String): PreparedAuthorization =
        PreparedAuthorization(
            pkce = generatePkce(),
            state = generateState(),
            redirectUri = redirectUri(host),
        )

    /**
     * Validates an inbound redirect against the expected `state` and extracts
     * the authorization `code`. Throws on mismatch / OAuth error. Parsing uses
     * [java.net.URI] (Android API 26+, minSdk 28) so the logic is exercised
     * by plain JVM unit tests without Robolectric. The `state` comparison is
     * constant-time.
     */
    fun parseAuthorizationResponse(redirectUri: String, expectedState: String): AuthorizationResponse {
        val params = parseQueryParams(redirectUri)
        val state = params["state"]
            ?: throw IllegalStateException("redirect missing state")
        if (!constantTimeEquals(state, expectedState)) {
            throw IllegalStateException("state mismatch")
        }
        params["error"]?.let { error ->
            throw IllegalStateException("authorization error: $error")
        }
        val code = params["code"]
            ?: throw IllegalStateException("redirect missing code")
        return AuthorizationResponse(code = code, state = state)
    }

    /**
     * RFC 7591 dynamic-registration request body for a NATIVE PUBLIC client:
     * `token_endpoint_auth_method: "none"`, no `client_secret` — the
     * serialized JSON must not contain the string "client_secret" at all.
     */
    fun registrationRequestJson(
        redirectUri: String,
        clientName: String = DEFAULT_CLIENT_NAME,
    ): String {
        require(redirectUri.startsWith("https://")) {
            "registration redirect_uri must be an HTTPS App Link: \"$redirectUri\""
        }
        val body = JsonObject(
            mapOf(
                "client_name" to JsonPrimitive(clientName),
                "redirect_uris" to JsonArray(listOf(JsonPrimitive(redirectUri))),
                "response_types" to JsonArray(listOf(JsonPrimitive("code"))),
                "grant_types" to JsonArray(
                    listOf(
                        JsonPrimitive("authorization_code"),
                        JsonPrimitive("refresh_token"),
                    ),
                ),
                "token_endpoint_auth_method" to JsonPrimitive("none"),
            ),
        )
        val encoded = json.encodeToString(JsonObject.serializer(), body)
        require(!encoded.contains("client_secret")) {
            "public-client registration must never carry a client_secret"
        }
        return encoded
    }

    /**
     * Parses a registration response and returns the public client identity.
     * A `client_secret`, should the server issue one against the requested
     * auth method, is deliberately IGNORED — [RegisteredClient] has no field
     * that could hold it, and nothing downstream ever authenticates with a
     * secret.
     */
    fun parseRegistrationResponse(responseJson: String): RegisteredClient {
        val obj = json.parseToJsonElement(responseJson).jsonObject
        val clientId = obj["client_id"]?.jsonPrimitive?.contentOrNull
        require(!clientId.isNullOrBlank()) {
            "registration response is missing client_id"
        }
        return RegisteredClient(clientId = clientId)
    }

    /**
     * Extracts the endpoints the app needs from the RFC 8414 metadata
     * document. `registration_endpoint` is required: the app has no static
     * client_id and must dynamically register (§10.2 step 2).
     */
    fun parseDiscoveryDocument(metadataJson: String): DiscoveryEndpoints {
        val obj = json.parseToJsonElement(metadataJson).jsonObject

        fun requiredEndpoint(field: String): String {
            val value = obj[field]?.jsonPrimitive?.contentOrNull
            require(!value.isNullOrBlank()) { "discovery document is missing $field" }
            require(value.startsWith("https://")) { "$field must be an https URL: \"$value\"" }
            return value
        }

        return DiscoveryEndpoints(
            authorizationEndpoint = requiredEndpoint("authorization_endpoint"),
            tokenEndpoint = requiredEndpoint("token_endpoint"),
            registrationEndpoint = requiredEndpoint("registration_endpoint"),
        )
    }

    // -- internals -----------------------------------------------------------

    private fun randomUnreserved(length: Int): String {
        val random = SecureRandom()
        val sb = StringBuilder(length)
        repeat(length) {
            sb.append(UNRESERVED[random.nextInt(UNRESERVED.length)])
        }
        return sb.toString()
    }

    private fun sha256Base64Url(input: String): String =
        java.util.Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(
                MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.US_ASCII)),
            )

    private fun parseQueryParams(uriString: String): Map<String, String> {
        val raw = URI(uriString).rawQuery ?: return emptyMap()
        return raw.split('&')
            .filter { it.isNotEmpty() }
            .associate { pair ->
                val idx = pair.indexOf('=')
                if (idx < 0) {
                    URLDecoder.decode(pair, Charsets.UTF_8.name()) to ""
                } else {
                    URLDecoder.decode(pair.substring(0, idx), Charsets.UTF_8.name()) to
                        URLDecoder.decode(pair.substring(idx + 1), Charsets.UTF_8.name())
                }
            }
    }

    private fun ByteArray.toHex(): String {
        val sb = StringBuilder(size * 2)
        for (b in this) {
            sb.append(String.format(Locale.ROOT, "%02x", b))
        }
        return sb.toString()
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) {
            diff = diff or (a[i].code xor b[i].code)
        }
        return diff == 0
    }

    /** PKCE pair; S256 only — the constructor rejects every other method. */
    data class PkcePair(val verifier: String, val challenge: String, val method: String) {
        init {
            require(method == "S256") { "Only the S256 PKCE method is allowed; got $method" }
            require(verifier.length in 43..128) {
                "PKCE verifier must be 43-128 chars; got ${verifier.length}"
            }
            require(challenge.isNotBlank()) { "challenge must not be blank" }
        }
    }

    /** Inputs of one authorization attempt (kept atomic per attempt). */
    data class PreparedAuthorization(
        val pkce: PkcePair,
        val state: String,
        val redirectUri: String,
    )

    /** Parsed authorization redirect: the code plus the validated state. */
    data class AuthorizationResponse(val code: String, val state: String) {
        init {
            require(code.isNotBlank()) { "code must not be blank" }
            require(state.isNotBlank()) { "state must not be blank" }
        }
    }

    /**
     * A dynamically registered PUBLIC client. There is deliberately no
     * client_secret field — nothing in the app authenticates with a secret.
     */
    data class RegisteredClient(val clientId: String) {
        init {
            require(clientId.isNotBlank()) { "clientId must not be blank" }
        }
    }

    /** Endpoints extracted from the RFC 8414 metadata document. */
    data class DiscoveryEndpoints(
        val authorizationEndpoint: String,
        val tokenEndpoint: String,
        val registrationEndpoint: String,
    )
}

/** A stored Access token with its advertised expiry (null = opaque/no expiry). */
data class StoredAccessToken(val token: String, val expiresAtMs: Long?)

/** Result of a token refresh / exchange: new Access (+ rotated refresh). */
data class AccessTokens(
    val accessToken: String,
    val refreshToken: String?,
    val accessExpiresAtMs: Long?,
)

/**
 * Persistence seam for the OAuth token pair. The production implementation
 * ([EncryptedAccessTokenStore]) encrypts at rest with a Keystore-protected
 * AES key; JVM tests use an in-memory fake.
 */
interface AccessTokenStore {
    fun getAccess(): StoredAccessToken?

    fun getRefreshToken(): String?

    fun putAccess(token: String, expiresAtMs: Long?)

    fun putRefreshToken(token: String)

    /** Drops the (possibly stale) Access token; the refresh token survives. */
    fun clearAccess()
}

/**
 * Seam performing the refresh_token grant. The production implementation
 * ([AppAuthTokenRefresher]) goes through AppAuth as a public client
 * (`NoClientAuthentication`); JVM tests fake it.
 */
fun interface TokenRefresher {
    suspend fun refresh(refreshToken: String): AccessTokens
}

/**
 * Access-token lifecycle owner (JVM-pure by design; Android glue is injected).
 *
 * - [getValidAccessToken] returns an Access token with more than
 *   [minRemainingMs] of advertised life, refreshing through [TokenRefresher]
 *   when needed. Refresh is SERIALIZED through a [Mutex] and single-flight:
 *   concurrent callers wait on the lock and then reuse the fresh token the
 *   winner stored, so the token endpoint sees one request per expiry.
 * - Tokens without an advertised expiry (opaque Cloudflare Access tokens)
 *   are treated as valid; refresh then happens via [forceRefresh] when a
 *   401/4401 signals rejection downstream.
 * - Any refresh failure, or a missing refresh token, surfaces
 *   [ReLoginRequiredError] — there is no secondary credential source.
 */
class OAuthManager(
    private val appLinkVerifier: AppLinkVerifier,
    private val tokenStore: AccessTokenStore,
    private val tokenRefresher: TokenRefresher,
) {
    private val refreshMutex = Mutex()

    /**
     * Refuses to start OAuth unless [host] is a VERIFIED App Link of this
     * install (Phase 0 rule: a browser-fallback redirect cannot be trusted
     * with the authorization code).
     */
    fun requireVerifiedAppLink(host: String) {
        if (!appLinkVerifier.isVerified(host)) {
            throw AppLinkUnverifiedError(host)
        }
    }

    /** Preflight + one-shot authorization inputs (PKCE, state, redirect). */
    fun prepareAuthorization(host: String): OAuthFlows.PreparedAuthorization {
        requireVerifiedAppLink(host)
        return OAuthFlows.prepareAuthorization(host)
    }

    suspend fun getValidAccessToken(
        nowMs: Long = System.currentTimeMillis(),
        minRemainingMs: Long = DEFAULT_MIN_REMAINING_MS,
        forceRefresh: Boolean = false,
    ): String = refreshMutex.withLock {
        val cached = tokenStore.getAccess()
        val cachedIsUsable = !forceRefresh && cached != null &&
            (cached.expiresAtMs == null || cached.expiresAtMs - nowMs > minRemainingMs)
        if (cachedIsUsable) {
            return@withLock cached!!.token
        }

        val refreshToken = tokenStore.getRefreshToken()
            ?: throw ReLoginRequiredError("no stored refresh token; interactive login required")

        val fresh = try {
            tokenRefresher.refresh(refreshToken)
        } catch (e: ReLoginRequiredError) {
            tokenStore.clearAccess()
            throw e
        } catch (e: Exception) {
            tokenStore.clearAccess()
            throw ReLoginRequiredError("Access token refresh failed", e)
        }

        tokenStore.putAccess(fresh.accessToken, fresh.accessExpiresAtMs)
        fresh.refreshToken?.let { tokenStore.putRefreshToken(it) }
        fresh.accessToken
    }

    companion object {
        /**
         * Default Access-token safety window — matches the device-session
         * refresh window so a device-session refresh never races an Access
         * expiry.
         */
        const val DEFAULT_MIN_REMAINING_MS = 60_000L
    }
}

// ---------------------------------------------------------------------------
// Android glue (instrumented-only; not exercised by JVM unit tests)
// ---------------------------------------------------------------------------

/**
 * [ConnectionBuilder] that forbids edge compression on every AppAuth HTTP
 * call. Some OEM HttpURLConnection stacks (observed on MIUI behind Cloudflare)
 * end up handing gzipped bodies to the JSON parser, which surfaces as
 * `INVALID_DISCOVERY_DOCUMENT` / token-response parse failures; a request
 * that explicitly offers `identity` is never compressed, so no transparent
 * decompression is ever required of the platform stack.
 */
object NoCompressionConnectionBuilder : ConnectionBuilder {
    override fun openConnection(uri: Uri): HttpURLConnection {
        val connection = URL(uri.toString()).openConnection() as HttpURLConnection
        connection.setRequestProperty("Accept", "application/json")
        connection.setRequestProperty("Accept-Encoding", "identity")
        return connection
    }
}

/** [AppAuthConfiguration] routing all AppAuth HTTP through [NoCompressionConnectionBuilder]. */
val NO_COMPRESSION_APPAUTH_CONFIG: AppAuthConfiguration =
    AppAuthConfiguration.Builder()
        .setConnectionBuilder(NoCompressionConnectionBuilder)
        .build()

/**
 * [AppLinkVerifier] backed by the platform domain-verification state.
 *
 * - Android 12+ (API 31): the host must report
 *   [android.content.pm.verify.domain.DomainVerificationUserState.DOMAIN_STATE_VERIFIED]
 *   and link handling must be enabled for this app.
 * - Android 9-11: the platform verified App Links silently at install time
 *   and exposes no query API, so the best available preflight is that this
 *   app itself declares the browsable HTTPS intent-filter for the host;
 *   anything else refuses.
 */
class PlatformAppLinkVerifier(private val context: Context) : AppLinkVerifier {

    override fun isVerified(host: String): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            isVerifiedOnSPlus(host)
        } else {
            isDeclaredByThisApp(host)
        }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun isVerifiedOnSPlus(host: String): Boolean {
        val manager = context.getSystemService(
            android.content.pm.verify.domain.DomainVerificationManager::class.java,
        ) ?: return false
        val state = try {
            manager.getDomainVerificationUserState(context.packageName)
        } catch (e: PackageManager.NameNotFoundException) {
            null
        } ?: return false
        return state.isLinkHandlingAllowed &&
            state.hostToStateMap[host] ==
            android.content.pm.verify.domain.DomainVerificationUserState.DOMAIN_STATE_VERIFIED
    }

    /** Pre-S fallback: this app must declare the browsable HTTPS link itself. */
    private fun isDeclaredByThisApp(host: String): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://$host/auth/callback")).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
            setPackage(context.packageName)
        }
        return context.packageManager.queryIntentActivities(intent, 0).isNotEmpty()
    }
}

/**
 * Thin AppAuth-Android gateway: discovery fetch, dynamic public-client
 * registration, the PKCE authorization request, and the authorization-code
 * exchange. All pure decision logic lives in [OAuthFlows]/[OAuthManager].
 */
class AppAuthGateway(private val context: Context) {

    private val service: AuthorizationService by lazy {
        AuthorizationService(context, NO_COMPRESSION_APPAUTH_CONFIG)
    }

    /**
     * Fetches the RFC 8414 metadata of the OAuth server fronting [host].
     *
     * Deliberately NOT [AuthorizationServiceConfiguration.fetchFromUrl]:
     * AppAuth parses the document with its OIDC discovery parser
     * (`AuthorizationServiceDiscovery`), which mandates `jwks_uri` — a field
     * the bridge's RFC 8414 metadata does not carry. OkHttp handles edge
     * gzip transparently, and the document is validated by the unit-tested
     * [OAuthFlows.parseDiscoveryDocument] instead.
     */
    suspend fun fetchServiceConfiguration(
        host: String,
        client: OkHttpClient = OkHttpClient(),
    ): AuthorizationServiceConfiguration {
        val request = Request.Builder()
            .url(OAuthFlows.discoveryUri(host))
            .header("Accept", "application/json")
            .build()
        val body = client.newCall(request).await().use { response ->
            if (!response.isSuccessful) {
                throw IOException("OAuth discovery failed for \"$host\" (HTTP ${response.code})")
            }
            response.body?.string().orEmpty()
        }
        val endpoints = OAuthFlows.parseDiscoveryDocument(body)
        return AuthorizationServiceConfiguration(
            Uri.parse(endpoints.authorizationEndpoint),
            Uri.parse(endpoints.tokenEndpoint),
            Uri.parse(endpoints.registrationEndpoint),
        )
    }

    /**
     * Dynamically registers this install as a PUBLIC client (no client
     * secret anywhere) against the discovered `registration_endpoint`.
     */
    suspend fun registerPublicClient(
        configuration: AuthorizationServiceConfiguration,
        bridgeHost: String,
        client: OkHttpClient = OkHttpClient(),
    ): OAuthFlows.RegisteredClient {
        val endpoint = configuration.registrationEndpoint
            ?: throw ReLoginRequiredError("OAuth discovery document has no registration_endpoint")
        val body = OAuthFlows.registrationRequestJson(OAuthFlows.redirectUri(bridgeHost))
        val request = Request.Builder()
            .url(endpoint.toString())
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        val responseBody = client.newCall(request).await().use { response ->
            if (!response.isSuccessful) {
                throw ReLoginRequiredError(
                    "dynamic client registration failed (HTTP ${response.code})",
                )
            }
            response.body?.string().orEmpty()
        }
        return OAuthFlows.parseRegistrationResponse(responseBody)
    }

    /**
     * Builds the Custom Tab authorization intent after the App Link
     * preflight. Throws [AppLinkUnverifiedError] when [bridgeHost] is not a
     * verified link — OAuth never starts on an unverified host.
     */
    fun buildAuthorizationRequestIntent(
        oauth: OAuthManager,
        configuration: AuthorizationServiceConfiguration,
        clientId: String,
        bridgeHost: String,
        prepared: OAuthFlows.PreparedAuthorization = oauth.prepareAuthorization(bridgeHost),
    ): Intent {
        val request = AuthorizationRequest.Builder(
            configuration,
            clientId,
            ResponseTypeValues.CODE,
            Uri.parse(prepared.redirectUri),
        )
            .setState(prepared.state)
            .setCodeVerifier(prepared.pkce.verifier, prepared.pkce.challenge, prepared.pkce.method)
            .build()
        return service.getAuthorizationRequestIntent(request)
    }

    /** Exchanges the authorization code (PKCE verifier attached) for tokens. */
    suspend fun exchangeAuthorizationCode(
        configuration: AuthorizationServiceConfiguration,
        clientId: String,
        code: String,
        codeVerifier: String,
        redirectUri: String,
    ): AccessTokens = performTokenRequest(
        TokenRequest.Builder(configuration, configuration.tokenEndpoint.toString())
            .setClientId(clientId)
            .setGrantType(GrantTypeValues.AUTHORIZATION_CODE)
            .setRedirectUri(Uri.parse(redirectUri))
            .setAuthorizationCode(code)
            .setCodeVerifier(codeVerifier)
            .build(),
    )

    private suspend fun performTokenRequest(request: TokenRequest): AccessTokens =
        suspendCancellableCoroutine { continuation ->
            service.performTokenRequest(
                request,
                NoClientAuthentication.INSTANCE,
            ) { response, exception ->
                when {
                    exception != null ->
                        continuation.resumeWithException(
                            ReLoginRequiredError("token request failed", exception),
                        )
                    response?.accessToken.isNullOrBlank() ->
                        continuation.resumeWithException(
                            ReLoginRequiredError("token response carried no access token"),
                        )
                    else ->
                        continuation.resume(
                            AccessTokens(
                                accessToken = response!!.accessToken!!,
                                refreshToken = response.refreshToken,
                                accessExpiresAtMs = response.accessTokenExpirationTime,
                            ),
                        )
                }
            }
        }

    private companion object {
        val JSON_MEDIA_TYPE: MediaType = "application/json".toMediaType()
    }
}

/** [TokenRefresher] via AppAuth: the refresh_token grant as a public client. */
class AppAuthTokenRefresher(
    context: Context,
    private val configuration: AuthorizationServiceConfiguration,
    private val clientId: String,
) : TokenRefresher {

    private val service: AuthorizationService by lazy {
        AuthorizationService(context, NO_COMPRESSION_APPAUTH_CONFIG)
    }

    override suspend fun refresh(refreshToken: String): AccessTokens {
        val request = TokenRequest.Builder(configuration, configuration.tokenEndpoint.toString())
            .setClientId(clientId)
            .setGrantType(GrantTypeValues.REFRESH_TOKEN)
            .setRefreshToken(refreshToken)
            .build()
        return suspendCancellableCoroutine { continuation ->
            service.performTokenRequest(
                request,
                NoClientAuthentication.INSTANCE,
            ) { response, exception ->
                when {
                    exception != null ->
                        continuation.resumeWithException(
                            ReLoginRequiredError("Access token refresh failed", exception),
                        )
                    response?.accessToken.isNullOrBlank() ->
                        continuation.resumeWithException(
                            ReLoginRequiredError("refresh response carried no access token"),
                        )
                    else ->
                        continuation.resume(
                            AccessTokens(
                                accessToken = response!!.accessToken!!,
                                refreshToken = response.refreshToken,
                                accessExpiresAtMs = response.accessTokenExpirationTime,
                            ),
                        )
                }
            }
        }
    }
}

/** Suspends until the OkHttp [Call] completes; cancels the call on coroutine cancel. */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    enqueue(
        object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                continuation.resume(response)
            }
        },
    )
    continuation.invokeOnCancellation { runCatching { cancel() } }
}
