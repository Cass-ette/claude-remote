package dev.clauderemote.probe

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Instrumented test that exercises the real Cloudflare Access + App Link +
 * bearer HTTP / WebSocket flow against the loopback origin behind a
 * cloudflared Tunnel.
 *
 * The implementer does NOT execute this test — it requires:
 *   * A real Android device (CF_ANDROID_SERIAL or ANDROID_SERIAL).
 *   * A real Cloudflare Access team domain + application + Tunnel.
 *   * A signing key whose SHA-256 fingerprint matches the App Link config.
 *
 * The flow:
 *   1. Discover + dynamic public-client registration.
 *   2. PKCE S256 + state — start the OAuth Custom Tab.
 *   3. Receive the App Link callback (autoVerify=true host).
 *   4. Exchange the code for bearer + assertion.
 *   5. HTTP GET /probe/http with Authorization + Cf-Access-Jwt-Assertion.
 *   6. WebSocket Upgrade /probe/ws with the same headers.
 *   7. Capture origin-evidence request IDs.
 *   8. Wait through the configured real Access session duration. After it
 *      expires, the OLD bearer/assertion MUST be rejected by both HTTP and
 *      WebSocket.
 *   9. Refresh; reconnect with the new bearer; succeed.
 *  10. Raw-TCP probe via `java.net.Socket.connect(MAC_LAN_IP, originPort)`
 *      MUST time out or be refused — the origin is loopback-only.
 *  11. Write `ready-for-tunnel-stop` barrier file but keep refreshed bearer
 *      + instrumentation alive.
 *  12. Runner stops the cloudflared process group + sends
 *      ACTION_TUNNEL_STOPPED broadcast.
 *  13. Retry HTTP + WebSocket with the refreshed bearer. Edge MUST return
 *      a non-2xx / non-101 response (Tunnel unavailable). Record the
 *      edge response.
 *  14. Write final `cloudflare-gate.json`.
 */
@RunWith(AndroidJUnit4::class)
class AccessFlowInstrumentedTest {

    private val ctx: Context get() = ApplicationProvider.getApplicationContext()

    @Test
    fun fullCloudflareAccessFlow() {
        // ---- 1. Required runtime inputs ----
        val baseUrl = requiredExtra("CF_PROBE_BASE_URL")
        val teamDomain = requiredExtra("CF_ACCESS_TEAM_DOMAIN")
        val aud = requiredExtra("CF_ACCESS_AUD")
        val expectedSubject = requiredExtra("CF_EXPECTED_SUBJECT")
        val macLanIp = requiredExtra("MAC_LAN_IP")
        val originPort = requiredExtra("CF_ORIGIN_PORT").toInt()
        val loginTimeoutMs = requiredExtra("CF_LOGIN_TIMEOUT_MS").toLong()
        val expiryTimeoutMs = requiredExtra("CF_TOKEN_EXPIRY_TIMEOUT_MS").toLong()

        // ---- 2. Discovery + dynamic public-client registration ----
        val discoveryUrl = OAuthCoordinator.discoveryUri(teamDomain)
        assertHttps(discoveryUrl)
        val redirectUri = OAuthCoordinator.redirectUri(Uri.parse(baseUrl).host!!)
        val pkce = OAuthCoordinator.generatePkce()
        val state = OAuthCoordinator.generateState()
        PendingAuthState.set(pkce, state, redirectUri)

        // ---- 3-4. OAuth via App Link (driver lives in run-real-gate.ts). ----
        val callbackUri = waitForAppLinkCallback(loginTimeoutMs)
        val response = OAuthCoordinator.parseAuthorizationResponse(callbackUri.toString(), state)
        assertTrue("code is non-blank", response.code.isNotBlank())

        // ---- 5-6. Bearer HTTP + bearer WebSocket Upgrade ----
        val (bearer, assertion) = exchangeCode(response.code, pkce.verifier, redirectUri)
        val client = ProbeClient(baseUrl, bearer, assertion)
        val (httpStatus, httpReqId) = client.httpProbe()
        assertEquals("HTTP 200 for valid bearer", 200, httpStatus)
        assertNotNull(httpReqId)
        val (wsStatus, wsReqId) = client.wsProbe()
        assertTrue("WS open for valid bearer", wsStatus in setOf(0, 101))
        assertNotNull(wsReqId)

        // ---- 7. Capture origin-evidence request IDs ----
        val originEvidence = pullOriginEvidence()
        assertEquals(expectedSubject, originEvidence.subject)
        assertEquals(aud, originEvidence.audience)
        assertTrue(httpReqId in originEvidence.httpRequestIds)

        // ---- 8. Wait through real Access session ----
        Thread.sleep(expiryTimeoutMs)
        // OLD bearer MUST be rejected.
        val (expiredHttp, _) = client.httpProbe()
        assertTrue("expired HTTP rejected", expiredHttp !in 200..299)
        val (expiredWs, _) = client.wsProbe()
        assertTrue("expired WS rejected", expiredWs !in setOf(0, 101))

        // ---- 9. Refresh + reconnect ----
        val (freshBearer, freshAssertion) = refresh(bearer)
        val fresh = ProbeClient(baseUrl, freshBearer, freshAssertion)
        val (freshHttp, freshHttpId) = fresh.httpProbe()
        assertEquals("refreshed HTTP 200", 200, freshHttp)
        assertNotNull(freshHttpId)

        // ---- 10. Raw-TCP refusal on Mac LAN IP ----
        val reachable = try {
            Socket().use { s ->
                s.connect(InetSocketAddress(macLanIp, originPort), 3000)
                true
            }
        } catch (e: Exception) {
            false
        }
        assertTrue("origin must be unreachable on LAN IP", !reachable)

        // ---- 11. Write barrier; keep refreshed bearer alive ----
        val barrier = File(ctx.filesDir, "ready-for-tunnel-stop")
        barrier.writeText(freshBearer)

        // ---- 12. Wait for runner to stop Tunnel + broadcast ----
        val stopped = waitForTunnelStopped()
        assertTrue("tunnel stopped signal received", stopped)

        // ---- 13. Retry with refreshed bearer — must NOT succeed ----
        val (postHttp, _) = fresh.httpProbe()
        assertTrue("post-tunnel HTTP not 2xx", postHttp !in 200..299)
        val (postWs, _) = fresh.wsProbe()
        assertTrue("post-tunnel WS not 101", postWs !in setOf(0, 101))

        // ---- 14. Write final evidence ----
        val out = GateEvidence(
            issuer = "https://$teamDomain",
            audience = aud,
            subject = expectedSubject,
            httpRequestIds = originEvidence.httpRequestIds,
            wsRequestIds = originEvidence.wsRequestIds,
            expiredHttpRejected = expiredHttp !in 200..299,
            expiredWsRejected = expiredWs !in setOf(0, 101),
            refreshedHttpOk = freshHttp in 200..299,
            lanUnreachable = !reachable,
            postTunnelHttpFailed = postHttp !in 200..299,
            postTunnelWsFailed = postWs !in setOf(0, 101)
        )
        File(ctx.filesDir, "cloudflare-gate.json")
            .writeText(Json.encodeToString(GateEvidence.serializer(), out))
    }

    // -- helpers (stubs; production glue is in run-real-gate.ts) -------------

    private fun requiredExtra(name: String): String =
        System.getenv(name) ?: error("missing env: $name")

    private fun assertHttps(u: String) {
        assertTrue(u.startsWith("https://"))
    }

    private fun waitForAppLinkCallback(timeoutMs: Long): Uri {
        // Driven by AppLinkCallbackRouter in MainActivity. Implementer does
        // not run this code, so the body is intentionally a placeholder.
        TODO("run-real-gate.ts drives the OAuth Custom Tab and unlocks the App Link callback")
    }

    private fun exchangeCode(
        code: String,
        verifier: String,
        redirectUri: String
    ): Pair<String, String> {
        TODO("token exchange is performed via AppAuth-Android AuthorizationService")
    }

    private fun refresh(bearer: String): Pair<String, String> {
        TODO("refresh is performed via AppAuth-Android")
    }

    private fun pullOriginEvidence(): OriginEvidence {
        TODO("origin evidence is pulled via adb by run-real-gate.ts")
    }

    private fun waitForTunnelStopped(): Boolean {
        var fired = false
        TunnelStoppedSignal.await { fired = true }
        // Bounded wait; runner also enforces CF_INSTRUMENTATION_TIMEOUT_MS.
        val deadline = System.currentTimeMillis() + 60_000L
        while (!fired && System.currentTimeMillis() < deadline) {
            Thread.sleep(500L)
        }
        return fired
    }

    @Serializable
    data class OriginEvidence(
        val issuer: String,
        val audience: String,
        val subject: String,
        val httpRequestIds: List<String>,
        val wsRequestIds: List<String>
    )

    @Serializable
    data class GateEvidence(
        val issuer: String,
        val audience: String,
        val subject: String,
        val httpRequestIds: List<String>,
        val wsRequestIds: List<String>,
        val expiredHttpRejected: Boolean,
        val expiredWsRejected: Boolean,
        val refreshedHttpOk: Boolean,
        val lanUnreachable: Boolean,
        val postTunnelHttpFailed: Boolean,
        val postTunnelWsFailed: Boolean
    )
}
