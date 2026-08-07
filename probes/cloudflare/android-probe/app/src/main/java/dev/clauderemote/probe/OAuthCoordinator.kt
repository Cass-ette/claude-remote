package dev.clauderemote.probe

import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale

/**
 * Pure-PKCE + URI helpers used by [MainActivity] and the JVM unit tests.
 *
 * This object intentionally has no Android-only dependencies beyond [Uri]
 * (which is robolectric-friendly). The PKCE / state / discovery-URI logic is
 * testable on the JVM.
 *
 * SECURITY INVARIANTS enforced here:
 *   * PKCE code verifier is 43-128 chars from the unreserved-URI alphabet.
 *   * Code challenge is BASE64URL(SHA256(verifier)) with no padding — never
 *     S256's plaintext fallback ("plain").
 *   * `state` is 256 bits of entropy from [SecureRandom].
 *   * We NEVER read CF_Authorization cookies, and the probe has no
 *     fallback to a service token or shared cookie. Authorization Code +
 *     PKCE + `Authorization: Bearer` is the ONLY authentication path.
 */
object OAuthCoordinator {

    private const val VERIFIER_LENGTH = 64
    private const val STATE_BYTES = 32
    private const val UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

    /** Build the Cloudflare Access OIDC discovery URI for a team domain. */
    fun discoveryUri(teamDomain: String): String {
        require(teamDomain.isNotBlank()) { "teamDomain must not be blank" }
        return "https://$teamDomain/.well-known/openid-configuration"
    }

    /**
     * Build the OAuth redirect URI for this package. Must be an HTTPS App Link
     * (no custom scheme) — `/auth/callback` is the conventional path.
     */
    fun redirectUri(probeHost: String): String {
        require(probeHost.isNotBlank()) { "probeHost must not be blank" }
        return "https://$probeHost/auth/callback"
    }

    /** Generate a fresh PKCE pair (verifier + S256 challenge). */
    fun generatePkce(): PkcePair {
        val verifier = randomUnreserved(VERIFIER_LENGTH)
        val challenge = sha256Base64Url(verifier)
        return PkcePair(verifier = verifier, challenge = challenge, method = "S256")
    }

    /** Generate a fresh opaque `state` value (256 bits of entropy, hex). */
    fun generateState(): String {
        val bytes = ByteArray(STATE_BYTES)
        SecureRandom().nextBytes(bytes)
        return bytes.toHex()
    }

    /**
     * Validate that an inbound redirect matches the expected `state` and
     * carries a `code` query parameter. Throws on mismatch / failure.
     *
     * Accepts the redirect URI as a [String] (rather than `android.net.Uri`)
     * so the parsing logic is exercised by plain JVM unit tests without
     * Robolectric. Query parsing uses [java.net.URI], which is available on
     * Android API 26+ (`minSdk = 28`) and on the JVM.
     */
    fun parseAuthorizationResponse(
        redirectUri: String,
        expectedState: String
    ): AuthorizationResponse {
        val params = parseQueryParams(redirectUri)
        val state = params["state"]
            ?: throw IllegalStateException("redirect missing state")
        if (!constantTimeEquals(state, expectedState)) {
            throw IllegalStateException("state mismatch")
        }
        val error = params["error"]
        if (error != null) {
            throw IllegalStateException("authorization error: $error")
        }
        val code = params["code"]
            ?: throw IllegalStateException("redirect missing code")
        return AuthorizationResponse(code = code, state = state)
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

    private fun sha256Base64Url(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.US_ASCII))
        return base64UrlEncode(digest)
    }

    /**
     * Parse the query string of [uriString] into a key->value map. Uses
     * [java.net.URI] (not `android.net.Uri`) so this is JVM-test friendly.
     * Values are URL-decoded.
     */
    private fun parseQueryParams(uriString: String): Map<String, String> {
        val raw = URI(uriString).rawQuery ?: return emptyMap()
        return raw.split('&')
            .filter { it.isNotEmpty() }
            .associate { pair ->
                val idx = pair.indexOf('=')
                if (idx < 0) {
                    java.net.URLDecoder.decode(pair, Charsets.UTF_8.name()) to ""
                } else {
                    java.net.URLDecoder.decode(pair.substring(0, idx), Charsets.UTF_8.name()) to
                        java.net.URLDecoder.decode(pair.substring(idx + 1), Charsets.UTF_8.name())
                }
            }
    }

    private fun base64UrlEncode(bytes: ByteArray): String {
        // java.util.Base64 is available on API 26+ (minSdk = 28), and unlike
        // android.util.Base64 it is usable from JVM unit tests without
        // Robolectric or returnDefaultValues mocking.
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
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

    data class PkcePair(val verifier: String, val challenge: String, val method: String) {
        init {
            require(method == "S256") { "Only S256 PKCE method is allowed; got $method" }
            require(verifier.length in 43..128) {
                "PKCE verifier must be 43-128 chars; got ${verifier.length}"
            }
            require(challenge.isNotBlank()) { "challenge must not be blank" }
        }
    }

    data class AuthorizationResponse(val code: String, val state: String) {
        init {
            require(code.isNotBlank()) { "code must not be blank" }
            require(state.isNotBlank()) { "state must not be blank" }
        }
    }
}
