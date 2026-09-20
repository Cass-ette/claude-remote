package dev.clauderemote.android

import android.app.Application
import dev.clauderemote.android.auth.PairingController

/**
 * Application entry point and graph owner. [onCreate] builds the real
 * dependency graph ([AppGraph]) against the configured bridge host — the
 * BuildConfig debug default (emulator loopback) until the user enters a host
 * on the ConnectionScreen — and starts the runtime loops (event pipeline,
 * §6.7 recovery, connect loop).
 */
class ClaudeRemoteApp : Application() {

    lateinit var hostStore: BridgeHostStore
        private set

    var graph: AppGraph? = null
        private set

    /** Interactive login + pairing (revised §10.2); survives graph rebuilds. */
    lateinit var pairingController: PairingController
        private set

    override fun onCreate() {
        super.onCreate()
        hostStore = BridgeHostStore(this)
        graph = AppGraph.build(this, BridgeEndpoints.of(resolveBaseUrl(hostStore.bridgeHost())))
        graph?.start()
        pairingController = PairingController(this) { graph }
    }

    /**
     * Saves the user-entered bridge host and re-wires the graph against it:
     * the old coordinator is stopped (graceful socket close, no further
     * reconnects) and a fresh graph starts from the persisted projection.
     */
    fun saveBridgeHost(host: String) {
        hostStore.save(host)
        graph?.shutdown()
        graph = AppGraph.build(this, BridgeEndpoints.of(resolveBaseUrl(hostStore.bridgeHost())))
        graph?.start()
    }

    /**
     * Test seam for the instrumented E2E suite: swaps in a graph pointed at
     * the embedded fake bridge (loopback MockWebServer) so ActivityScenario
     * lifecycle driving exercises the real wiring.
     */
    fun replaceGraphForTesting(replacement: AppGraph) {
        graph?.shutdown()
        graph = replacement
        replacement.start()
    }

    /** Test seam counterpart: shuts the swapped-in graph down after the test. */
    fun shutdownGraphForTesting() {
        graph?.shutdown()
        graph = null
    }

    companion object {
        private const val TAG = "ClaudeRemoteApp"

        /**
         * Resolves the bridge base URL: a full http(s) URL is used verbatim,
         * a bare host gets the http scheme (for testing with reverse proxy),
         * and no configured host falls back to the debug default (BuildConfig).
         */
        fun resolveBaseUrl(hostInput: String?): String {
            android.util.Log.d(TAG, "resolveBaseUrl: input='$hostInput'")
            val result = when {
                hostInput.isNullOrBlank() -> BuildConfig.DEFAULT_BRIDGE_BASE_URL
                hostInput.startsWith("http://") || hostInput.startsWith("https://") ->
                    hostInput.trim().trimEnd('/')
                else -> "http://" + hostInput.trim().trimEnd('/')
            }
            android.util.Log.d(TAG, "resolveBaseUrl: resolved='$result'")
            return result
        }
    }
}
