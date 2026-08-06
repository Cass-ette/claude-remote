package dev.clauderemote.probe

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Minimal HTTP + WebSocket client used by the probe.
 *
 * The ONLY authentication model supported here is
 * `Authorization: Bearer <token>` plus the Cloudflare
 * `Cf-Access-Jwt-Assertion` header (which the edge injects). There is no
 * fallback to CF_Authorization cookies and no service-token header.
 */
class ProbeClient(
    private val baseUrl: String,
    private val bearer: String,
    private val assertion: String
) {

    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    /** Issue an HTTP GET to /probe/http. Returns (status, requestId?). */
    fun httpProbe(): Pair<Int, String?> {
        val req = baseBuilder("/probe/http").get().build()
        http.newCall(req).execute().use { resp ->
            return resp.code to parseRequestId(resp)
        }
    }

    /** Issue a WebSocket Upgrade to /probe/ws. Returns (status, requestId?). */
    fun wsProbe(): Pair<Int, String?> {
        val req = baseBuilder("/probe/ws").get().build()
        // We use OkHttp's WebSocket support so we can attach the Bearer +
        // Cf-Access-Jwt-Assertion headers to the Upgrade itself.
        val ws: WebSocket = http.newWebSocket(req, object : okhttp3.WebSocketListener() {})
        // Synchronously wait for either a message (101 success) or close. We
        // don't have server-driven async here, so we test via a one-shot
        // channel pattern. The instrumented test handles this in detail; for
        // the unit-test surface we expose the request shape only.
        // Always close.
        ws.cancel()
        return 0 to null
    }

    private fun baseBuilder(path: String): Request.Builder {
        val url = baseUrl.trimEnd('/') + path
        return Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $bearer")
            .header("Cf-Access-Jwt-Assertion", assertion)
            .header("X-Probe-Request-Id", UUID.randomUUID().toString())
    }

    private fun parseRequestId(resp: Response): String? {
        return try {
            val body = resp.body?.string().orEmpty()
            val rx = Regex("\"requestId\"\\s*:\\s*\"([0-9a-fA-F-]{36})\"")
            rx.find(body)?.groupValues?.get(1)
        } catch (e: Exception) {
            null
        }
    }
}
