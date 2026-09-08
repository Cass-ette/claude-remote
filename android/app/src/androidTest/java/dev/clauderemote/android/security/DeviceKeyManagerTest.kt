package dev.clauderemote.android.security

import java.security.KeyFactory
import java.security.KeyStore
import java.security.MessageDigest
import java.security.ProviderException
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented capability-probe tests for the Keystore device key (spec §4,
 * §10.3). These require a real AndroidKeyStore, so they run
 * on-device/on-emulator:
 *
 * - the generated key is a real Keystore P-256 key whose private half is
 *   non-exportable (`private.getFormat() == null`);
 * - `sign()` produces an ASN.1 DER `SHA256withECDSA` signature that verifies
 *   with the exposed SPKI public half (the fixture-based byte-parity and
 *   signature verification against the shared TypeScript key live in the
 *   JVM SigningBytesTest, which reads contracts/v1/auth-signing-fixture.json);
 * - injected generation failures surface as [DeviceUnsupportedError] with no
 *   software fallback — no key materializes under the alias.
 */
@RunWith(AndroidJUnit4::class)
class DeviceKeyManagerTest {

    /** Distinct from DeviceKeyManager.DEFAULT_ALIAS so the real pairing key is never touched. */
    private val alias = "device-key-manager-test"

    @After
    fun removeTestKeys() {
        runCatching { DeviceKeyManager(alias).deleteKey() }
    }

    @Test
    fun generatesNonExportableP256KeystoreKey() {
        val manager = DeviceKeyManager(alias)
        val keyPair = manager.ensureDeviceKey()

        // §4 hard requirement: the private key must be non-exportable.
        assertNull(keyPair.private.format)

        val spki = manager.publicKeySpkiDer()

        // The SPKI names the prime256v1/secp256r1 curve (OID 1.2.840.10045.3.1.7).
        assertTrue(contains(spki, P256_OID_DER))

        // §10.3 step 5: deviceId = base64url_no_pad(SHA-256(SPKI DER)),
        // cross-checked against java.util.Base64 to pin the android.util
        // URL_SAFE | NO_PADDING | NO_WRAP flags.
        val expectedDeviceId =
            Base64.getUrlEncoder().withoutPadding()
                .encodeToString(MessageDigest.getInstance("SHA-256").digest(spki))
        assertEquals(expectedDeviceId, manager.deviceId())

        // ensureDeviceKey() is idempotent: a fresh manager over the same
        // alias reuses the same key identity.
        assertEquals(manager.deviceId(), DeviceKeyManager(alias).deviceId())
    }

    @Test
    fun signProducesDerSha256withEcdsaSignatureVerifiableWithPublicKey() {
        val manager = DeviceKeyManager(alias)

        val content = buildSigningBytes(
            hostAscii = "bridge.example.com",
            deviceId = manager.deviceId(),
            challengeId = "4b3d0fd9-765d-4065-be00-6fc7ff075b05",
            accessSubject = "user@example.com",
            challengeRaw = ByteArray(32) { (it * 7 + 3).toByte() },
        )
        val signatureDer = manager.sign(content)

        // ASN.1 DER SEQUENCE(INTEGER r, INTEGER s) — starts with the
        // SEQUENCE tag, not a fixed-width r||s blob.
        assertEquals(0x30, signatureDer[0].toInt() and 0xff)

        val publicKey = KeyFactory.getInstance("EC")
            .generatePublic(X509EncodedKeySpec(manager.publicKeySpkiDer()))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey)
        verifier.update(content)
        assertTrue(verifier.verify(signatureDer))
    }

    @Test
    fun generationFailureSurfacesAsDeviceUnsupportedErrorWithNoSoftwareFallback() {
        val injected = ProviderException("injected keystore failure")
        val manager = DeviceKeyManager(
            alias = alias,
            keyPairGeneratorSource = { _, _ -> throw injected },
        )
        try {
            manager.ensureDeviceKey()
            fail("expected DeviceUnsupportedError")
        } catch (error: DeviceUnsupportedError) {
            assertEquals(injected, error.cause)
        }

        // No software fallback materialized: nothing exists under the alias,
        // and the public half stays unavailable instead of being synthesized.
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertFalse(keyStore.containsAlias(alias))
        try {
            manager.publicKeySpkiDer()
            fail("expected DeviceUnsupportedError")
        } catch (expected: DeviceUnsupportedError) {
            // §4: pairing must be blocked, never downgraded to a software key.
        }
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    /** DER encoding of the P-256 curve OID 1.2.840.10045.3.1.7. */
    private val P256_OID_DER =
        byteArrayOf(0x06, 0x08, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x03, 0x01, 0x07)

    private fun contains(haystack: ByteArray, needle: ByteArray): Boolean {
        if (needle.isEmpty() || haystack.size < needle.size) return false
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) {
                if (haystack[i + j] != needle[j]) continue@outer
            }
            return true
        }
        return false
    }
}
