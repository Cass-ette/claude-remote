package dev.clauderemote.probe

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Receives `dev.clauderemote.probe.ACTION_TUNNEL_STOPPED` from the runner
 * after the cloudflared process group has been terminated. The instrumented
 * test registers a listener so it can retry HTTP and WebSocket with its
 * refreshed bearer and then write the final evidence file.
 */
class TunnelStoppedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION) {
            AppLinkCallbackRouter.dispatch(null) // no-op, kept for parity
            TunnelStoppedSignal.fire()
        }
    }

    companion object {
        const val ACTION = "dev.clauderemote.probe.ACTION_TUNNEL_STOPPED"
    }
}

object TunnelStoppedSignal {
    private val waiters = mutableListOf<() -> Unit>()

    @Synchronized
    fun await(block: () -> Unit) {
        waiters.add(block)
    }

    @Synchronized
    fun fire() {
        val snapshot = waiters.toList()
        waiters.clear()
        snapshot.forEach { runCatching { it() } }
    }

    @Synchronized
    fun reset() {
        waiters.clear()
    }
}
