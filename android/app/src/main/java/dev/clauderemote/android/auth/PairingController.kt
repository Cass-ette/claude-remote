package dev.clauderemote.android.auth

import android.content.Context
import android.content.Intent
import android.net.Uri
import dev.clauderemote.android.AppGraph
import dev.clauderemote.android.StoredTokenRefresher
import net.openid.appauth.AuthorizationServiceConfiguration

/**
 * Interactive login + pairing orchestrator (revised spec §10.2/§10.3).
 *
 * Owns the ONE in-flight browser authorization:
 *
 *  1. [begin] — discovery → dynamic public-client registration → persist the
 *     login (so refresh survives a process death right after the redirect) →
 *     PKCE preparation (refuses unverified App Link hosts) → returns the
 *     Custom Tab intent. The caller launches it and the human completes the
 *     Cloudflare Access email One-time PIN in the browser.
 *  2. [onRedirect] — the https://<host>/auth/callback App Link lands on the
 *     singleTask MainActivity, which forwards the Uri here: state check,
 *     PKCE code exchange, token persistence, then (when a pairing token was
 *     stashed) device enrollment + the challenge/verify session round trip.
 *
 * SECURITY INVARIANTS:
 *   * The pending state is dropped BEFORE any fallible step of the redirect
 *     completes; a code replay across two redirects cannot work (and the
 *     bridge rejects code reuse anyway).
 *   * The PKCE verifier and state exist only in memory for the duration of
 *     the browser trip; tokens go straight into [EncryptedTokenStore].
 *   * [parsePairLink] merely PREFILLS the UI — the pairing token is only
 *     ever consumed by the bridge's single-use, five-minute check.
 */
class PairingController(
    context: Context,
    private val graphProvider: () -> AppGraph?,
) {

    private val appContext = context.applicationContext

    /** Prefill extracted from a claude-remote://pair?host=…&token=… link. */
    data class PairPrefill(val host: String, val pairingToken: String)

    /** Result of a completed redirect. */
    sealed interface Outcome {
        data class Paired(val deviceId: String) : Outcome

        /** Login completed without a pairing token (re-login path). */
        data object LoggedIn : Outcome
    }

    class PairingFlowException(message: String, cause: Throwable? = null) :
        Exception(message, cause)

    private class PendingLogin(
        val host: String,
        val configuration: AuthorizationServiceConfiguration,
        val clientId: String,
        val prepared: OAuthFlows.PreparedAuthorization,
        val pairingToken: String?,
    )

    private var pending: PendingLogin? = null

    /** claude-remote://pair link → UI prefill; null for anything else. */
    fun parsePairLink(uri: Uri): PairPrefill? {
        if (uri.scheme != PAIR_SCHEME || uri.host != PAIR_HOST) return null
        val host = uri.getQueryParameter("host")?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val token = uri.getQueryParameter("token")?.trim()?.takeIf { it.isNotBlank() } ?: return null
        return PairPrefill(host, token)
    }

    /** True for the OAuth redirect this controller can complete. */
    fun isOAuthRedirect(uri: Uri): Boolean =
        uri.scheme == "https" && uri.path == REDIRECT_PATH

    /**
     * Starts the interactive login against [hostInput] (bare host or https
     * URL). Returns the browser intent the caller must start. [pairingToken]
     * is stashed for the redirect; null means a plain re-login.
     */
    suspend fun begin(hostInput: String, pairingToken: String?): Intent {
        val host = bareHost(hostInput)
            ?: throw PairingFlowException("无效的 Bridge 主机：\"$hostInput\"")
        val graph = graphProvider() ?: throw PairingFlowException("应用图不可用")
        val gateway = AppAuthGateway(appContext)
        val configuration = gateway.fetchServiceConfiguration(host)
        val client = gateway.registerPublicClient(configuration, host)
        // Persist endpoints + client id BEFORE the browser trip: a refresh
        // after a process death must not depend on in-memory state.
        StoredTokenRefresher(appContext).storeLogin(configuration, client.clientId)
        // Throws AppLinkUnverifiedError for a host this install cannot
        // receive the redirect from — OAuth never starts on such a host.
        val prepared = graph.oauth.prepareAuthorization(host)
        pending = PendingLogin(host, configuration, client.clientId, prepared, pairingToken)
        return gateway.buildAuthorizationRequestIntent(
            graph.oauth,
            configuration,
            client.clientId,
            host,
            prepared,
        )
    }

    /**
     * Completes the redirected authorization: state check → PKCE exchange →
     * token persistence → (optional) pairing + device-session round trip →
     * restart the connect loop.
     */
    suspend fun onRedirect(uri: Uri): Outcome {
        val login = pending ?: throw PairingFlowException("没有进行中的登录")
        pending = null
        val parsed = try {
            OAuthFlows.parseAuthorizationResponse(uri.toString(), login.prepared.state)
        } catch (e: Exception) {
            throw PairingFlowException("登录回调校验失败", e)
        }
        val graph = graphProvider() ?: throw PairingFlowException("应用图不可用")
        val tokens = try {
            AppAuthGateway(appContext).exchangeAuthorizationCode(
                configuration = login.configuration,
                clientId = login.clientId,
                code = parsed.code,
                codeVerifier = login.prepared.pkce.verifier,
                redirectUri = login.prepared.redirectUri,
            )
        } catch (e: Exception) {
            throw PairingFlowException("令牌交换失败", e)
        }
        graph.tokenStore.putAccessToken(tokens.accessToken, tokens.accessExpiresAtMs)
        tokens.refreshToken?.let { graph.tokenStore.putRefreshToken(it) }
        return if (login.pairingToken != null) {
            val deviceId = try {
                graph.deviceSessions.pairDevice(login.pairingToken)
            } catch (e: Exception) {
                throw PairingFlowException(
                    "登录成功，但设备配对失败（令牌无效/过期，或已有配对设备）",
                    e,
                )
            }
            // Establish the first device session right away so the connect
            // loop has both credential layers.
            runCatching { graph.deviceSessions.getValidDeviceSessionToken() }
            graph.coordinator.start()
            Outcome.Paired(deviceId)
        } else {
            graph.coordinator.start()
            Outcome.LoggedIn
        }
    }

    private fun bareHost(input: String): String? {
        val trimmed = input.trim().removeSuffix("/")
        val bare = when {
            trimmed.startsWith("https://") -> trimmed.removePrefix("https://")
            trimmed.startsWith("http://") -> trimmed.removePrefix("http://")
            else -> trimmed
        }
        val host = bare.substringBefore('/').substringBefore(':')
        return host.takeIf { it.isNotBlank() && host.contains('.') }
    }

    private companion object {
        const val PAIR_SCHEME = "claude-remote"
        const val PAIR_HOST = "pair"
        const val REDIRECT_PATH = "/auth/callback"
    }
}
