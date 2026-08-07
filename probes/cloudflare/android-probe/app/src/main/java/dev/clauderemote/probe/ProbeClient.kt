package dev.clauderemote.probe

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

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
        .pingInterval(0, TimeUnit.SECONDS)
        .build()

    /** Issue an HTTP GET to /probe/http. Returns (status, requestId?). */
    fun httpProbe(): Pair<Int, String?> {
        val req = baseBuilder("/probe/http").get().build()
        http.newCall(req).execute().use { resp ->
            return resp.code to parseRequestId(resp)
        }
    }

    /**
     * Issue a WebSocket Upgrade to /probe/ws. Returns (status, requestId?).
     *
     * - `101` on a successful Upgrade + the first text frame parsed for
     *   `requestId`.
     * - The HTTP status code on `unexpected-response` (server rejected the
     *   Upgrade before establishing the WS).
     * - `-1` on timeout (no signal within 1s of dispatch).
     *
     * `0` is never returned; callers may safely treat `0` as a programmer
     * error.
     */
    fun wsProbe(): Pair<Int, String?> {
        val req = baseBuilder("/probe/ws").get().build()
        val opened = CountDownLatch(1)
        val firstMessage = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val statusRef = AtomicReference<Int>(-1)
        val requestIdRef = AtomicReference<String?>(null)
        val unexpectedResponse = AtomicReference<Response?>(null)

        val ws: WebSocket = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                statusRef.set(101)
                opened.countDown()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                requestIdRef.set(parseRequestIdFromText(text))
                firstMessage.countDown()
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // Not used by the probe protocol; treat as no payload.
                firstMessage.countDown()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (response != null) {
                    unexpectedResponse.set(response)
                }
                opened.countDown()
                firstMessage.countDown()
                closed.countDown()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                closed.countDown()
            }
        })

        // Wait first for the Upgrade result (open or unexpected-response).
        // Then, if open, wait for the first message which carries requestId.
        val openedOk = opened.await(1, TimeUnit.SECONDS)
        val unexpected = unexpectedResponse.get()
        if (!openedOk && unexpected == null && statusRef.get() < 0) {
            // Timeout before any signal — abort.
            ws.cancel()
            return -1 to null
        }
        if (unexpected != null) {
            ws.cancel()
            return unexpected.code to null
        }
        // 101 path — wait for first text message (bounded).
        if (!firstMessage.await(1, TimeUnit.SECONDS)) {
            ws.cancel()
            return 101 to null
        }
        // Close gracefully so the server sees a clean 1000.
        ws.close(1000, "ok")
        return (statusRef.get()) to requestIdRef.get()
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
            parseRequestIdFromText(body)
        } catch (e: Exception) {
            null
        }
    }

    private fun parseRequestIdFromText(text: String): String? {
        val rx = Regex("\"requestId\"\\s*:\\s*\"([0-9a-fA-F-]{36})\"")
        return rx.find(text)?.groupValues?.get(1)
    }
}
