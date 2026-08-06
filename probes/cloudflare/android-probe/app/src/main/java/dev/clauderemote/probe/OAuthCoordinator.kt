package dev.clauderemote.probe

import android.net.Uri
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
     */
    fun parseAuthorizationResponse(
        redirectUri: Uri,
        expectedState: String
    ): AuthorizationResponse {
        val state = redirectUri.getQueryParameter("state")
            ?: throw IllegalStateException("redirect missing state")
        if (!constantTimeEquals(state, expectedState)) {
            throw IllegalStateException("state mismatch")
        }
        val error = redirectUri.getQueryParameter("error")
        if (error != null) {
            throw IllegalStateException("authorization error: $error")
        }
        val code = redirectUri.getQueryParameter("code")
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

    private fun base64UrlEncode(bytes: ByteArray): String {
        return android.util.Base64.encodeToString(
            bytes,
            android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
        )
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
