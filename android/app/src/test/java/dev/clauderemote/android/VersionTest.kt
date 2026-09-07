package dev.clauderemote.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Build configuration smoke test. Guards the identity and compatibility
 * contract of the APK: the application ID must stay stable across releases,
 * the version name must be present, and the API floor must match the
 * Keystore/Cloudflare requirements from the design spec.
 */
class VersionTest {

    @Test
    fun applicationIdIsStable() {
        assertEquals("dev.clauderemote.android", BuildConfig.APPLICATION_ID)
    }

    @Test
    fun versionNameIsNotBlank() {
        assertTrue(
            "VERSION_NAME must be set for every release build",
            BuildConfig.VERSION_NAME.isNotBlank()
        )
    }

    @Test
    fun minSdkMatchesApiFloor() {
        assertEquals(28, AppConstants.MIN_SDK)
    }
}
