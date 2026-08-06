package dev.clauderemote.probe

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Entry-point Activity for the probe.
 *
 * Its job is minimal:
 *   1. Read the runtime inputs (base URL, OAuth resource, redirect URI,
 *      expected subject) from Intent extras.
 *   2. Generate PKCE + state and launch the Cloudflare Access authorization
 *      endpoint in a Custom Tab.
 *   3. Receive the App Link redirect in [onNewIntent], validate state, and
 *      hand the code to [OAuthCoordinator] for token exchange.
 *
 * The full flow (token refresh, HTTP/WS calls, LAN-refusal probe, barrier
 * file) lives in the instrumented test — MainActivity is intentionally thin.
 */
class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // No UI. The activity is a launch vehicle for the OAuth Custom Tab.
        startOAuth()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Hand off the App Link callback to the instrumented test's monitor
        // via a static handle. Production app (Chunk 4) replaces this.
        AppLinkCallbackRouter.dispatch(intent.data)
    }

    private fun startOAuth() {
        val teamDomain = intent.getStringExtra(EXTRA_TEAM_DOMAIN)
            ?: run { finish(); return }
        val authzEndpoint = "https://$teamDomain/authorize"
        val redirectUri = intent.getStringExtra(EXTRA_REDIRECT_URI)
            ?: run { finish(); return }
        val clientId = intent.getStringExtra(EXTRA_RESOURCE) ?: run { finish(); return }

        val pkce = OAuthCoordinator.generatePkce()
        val state = OAuthCoordinator.generateState()
        PendingAuthState.set(pkce, state, redirectUri)

        val url = Uri.parse(authzEndpoint).buildUpon()
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("client_id", clientId)
            .appendQueryParameter("redirect_uri", redirectUri)
            .appendQueryParameter("scope", "openid profile")
            .appendQueryParameter("state", state)
            .appendQueryParameter("code_challenge", pkce.challenge)
            .appendQueryParameter("code_challenge_method", pkce.method)
            .build()

        val tab = CustomTabsIntent.Builder().build()
        tab.intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
        tab.launchUrl(this, url)
    }

    companion object {
        const val EXTRA_TEAM_DOMAIN = "dev.clauderemote.probe.TEAM_DOMAIN"
        const val EXTRA_RESOURCE = "dev.clauderemote.probe.RESOURCE"
        const val EXTRA_REDIRECT_URI = "dev.clauderemote.probe.REDIRECT_URI"
    }
}
