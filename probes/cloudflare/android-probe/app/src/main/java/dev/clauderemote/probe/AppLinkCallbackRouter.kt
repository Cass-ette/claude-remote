package dev.clauderemote.probe

import android.net.Uri
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Process-wide router for App Link callbacks. The instrumented test
 * registers a listener here so it can receive the OAuth redirect that the
 * system delivers to [MainActivity.onNewIntent] asynchronously.
 *
 * Production (Chunk 4) will replace this with a proper ViewModel / Flow.
 */
object AppLinkCallbackRouter {
    private val listeners = ConcurrentLinkedQueue<(Uri?) -> Unit>()
    private var lastUri: Uri? = null

    fun register(listener: (Uri?) -> Unit) {
        listeners.add(listener)
        lastUri?.let { listener(it) }
    }

    fun unregister(listener: (Uri?) -> Unit) {
        listeners.remove(listener)
    }

    fun dispatch(uri: Uri?) {
        lastUri = uri
        listeners.forEach { runCatching { it(uri) } }
    }

    /** Test-only reset. */
    fun reset() {
        listeners.clear()
        lastUri = null
    }
}

/**
 * Holder for the in-flight PKCE verifier + state. The Activity sets it before
 * launching the Custom Tab; the instrumented test reads it to validate the
 * callback.
 */
object PendingAuthState {
    @Volatile
    private var current: Current? = null

    fun set(pkce: OAuthCoordinator.PkcePair, state: String, redirectUri: String) {
        current = Current(pkce, state, redirectUri)
    }

    fun get(): Current? = current

    fun clear() {
        current = null
    }

    data class Current(
        val pkce: OAuthCoordinator.PkcePair,
        val state: String,
        val redirectUri: String
    )
}
