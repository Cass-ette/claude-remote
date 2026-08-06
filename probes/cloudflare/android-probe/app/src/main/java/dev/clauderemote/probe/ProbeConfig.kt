package dev.clauderemote.probe

/**
 * Runtime configuration for the probe. Every field is required — there is NO
 * default and NO fallback. The runner injects these via dex System properties
 * or `adb shell am start -e` extras.
 *
 * Required environment values:
 *   CF_PROBE_BASE_URL            — public HTTPS base URL of the probe origin
 *   CF_ACCESS_TEAM_DOMAIN        — e.g. myteam.cloudflareaccess.com
 *   CF_ACCESS_AUD                — Access application AUD
 *   CF_EXPECTED_SUBJECT          — expected JWT subject (email)
 *   CLOUDFLARED_CONFIG           — absolute path to cloudflared config
 *   MAC_LAN_IP                   — Mac LAN IP for raw TCP refusal check
 *   ANDROID_SERIAL               — adb device serial
 *   APP_LINK_SHA256_FINGERPRINT  — APK signing-cert SHA-256 fingerprint
 *   CF_LOGIN_TIMEOUT_MS          — deadline for OAuth completion
 *   CF_TOKEN_EXPIRY_TIMEOUT_MS   — must exceed real Access session + 120s
 *   CF_INSTRUMENTATION_TIMEOUT_MS
 *   CF_OVERALL_TIMEOUT_MS        — must exceed login + expiry + cleanup
 */
data class ProbeConfig(
    val baseUrl: String,
    val teamDomain: String,
    val accessAudience: String,
    val expectedSubject: String,
    val cloudflaredConfig: String,
    val macLanIp: String,
    val androidSerial: String,
    val appLinkSha256Fingerprint: String,
    val loginTimeoutMs: Long,
    val tokenExpiryTimeoutMs: Long,
    val instrumentationTimeoutMs: Long,
    val overallTimeoutMs: Long
) {
    init {
        require(baseUrl.startsWith("https://")) { "baseUrl must be https" }
        require(teamDomain.isNotBlank()) { "teamDomain required" }
        require(accessAudience.isNotBlank()) { "accessAudience required" }
        require(expectedSubject.isNotBlank()) { "expectedSubject required" }
        require(cloudflaredConfig.startsWith("/")) { "cloudflaredConfig must be absolute" }
        require(macLanIp.count { it == '.' } == 3) { "macLanIp must be IPv4" }
        require(androidSerial.isNotBlank()) { "androidSerial required" }
        require(appLinkSha256Fingerprint.length == 64) {
            "appLinkSha256Fingerprint must be 64 hex chars (SHA-256)"
        }
        require(loginTimeoutMs > 0L) { "loginTimeoutMs must be > 0" }
        require(tokenExpiryTimeoutMs > loginTimeoutMs + 120_000L) {
            "tokenExpiryTimeoutMs must exceed loginTimeoutMs + 120s"
        }
        require(overallTimeoutMs > loginTimeoutMs + tokenExpiryTimeoutMs + instrumentationTimeoutMs) {
            "overallTimeoutMs must exceed login + expiry + instrumentation"
        }
    }

    companion object {
        /**
         * Build a [ProbeConfig] from required environment values. Throws
         * [IllegalStateException] if any are missing/invalid.
         */
        fun fromEnv(env: Map<String, String>): ProbeConfig {
            fun req(name: String): String =
                env[name] ?: error("missing required env: $name")

            return ProbeConfig(
                baseUrl = req("CF_PROBE_BASE_URL"),
                teamDomain = req("CF_ACCESS_TEAM_DOMAIN"),
                accessAudience = req("CF_ACCESS_AUD"),
                expectedSubject = req("CF_EXPECTED_SUBJECT"),
                cloudflaredConfig = req("CLOUDFLARED_CONFIG"),
                macLanIp = req("MAC_LAN_IP"),
                androidSerial = req("ANDROID_SERIAL"),
                appLinkSha256Fingerprint = req("APP_LINK_SHA256_FINGERPRINT"),
                loginTimeoutMs = req("CF_LOGIN_TIMEOUT_MS").toLong(),
                tokenExpiryTimeoutMs = req("CF_TOKEN_EXPIRY_TIMEOUT_MS").toLong(),
                instrumentationTimeoutMs = req("CF_INSTRUMENTATION_TIMEOUT_MS").toLong(),
                overallTimeoutMs = req("CF_OVERALL_TIMEOUT_MS").toLong()
            )
        }
    }
}
