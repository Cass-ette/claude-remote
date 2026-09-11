package dev.clauderemote.android.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.NoSuchAlgorithmException
import java.security.NoSuchProviderException
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.InvalidAlgorithmParameterException
import java.security.spec.ECGenParameterSpec

/**
 * Raised when the device cannot provide a non-exportable Android Keystore
 * ECDSA P-256 key (spec §4). Callers MUST block pairing on this error and
 * must never fall back to a bundled or software-generated private key.
 */
class DeviceUnsupportedError(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Signing seam consumed by the auth managers (Task 29): the non-exportable
 * device key's identity and signature, plus the SPKI public half for
 * pairing. Implemented by [DeviceKeyManager]; pure-JVM tests fake it so the
 * device-session orchestration runs without a Keystore.
 */
interface DeviceSigner {
    /** `base64url_no_pad(SHA-256(SPKI DER))` (§10.3 step 5). */
    fun deviceId(): String

    /** X.509 SubjectPublicKeyInfo DER of the device public key (§10.3 step 4). */
    fun publicKeySpkiDer(): ByteArray

    /** `SHA256withECDSA` over [bytes]; ASN.1 DER SEQUENCE(INTEGER r, INTEGER s). */
    fun sign(bytes: ByteArray): ByteArray
}

/**
 * Owns the device-auth key inside the Android Keystore (spec §4, §10.3):
 *
 * - a non-exportable `secp256r1` (P-256) ECDSA keypair under [alias],
 *   generated with PURPOSE_SIGN | PURPOSE_VERIFY and no user-auth gate
 *   (pairing is gated by the one-time challenge, not the lock screen);
 * - `SHA256withECDSA` signatures in ASN.1 DER (`SEQUENCE(INTEGER r,
 *   INTEGER s)`), exactly the encoding the Bridge verifies;
 * - the public half exposed as X.509 SubjectPublicKeyInfo DER plus the
 *   derived `deviceId = base64url_no_pad(SHA-256(SPKI DER))` (§10.3 step 5).
 *
 * Spec §4 capability probe: EVERY Keystore failure path — missing EC or
 * AndroidKeyStore provider, unsupported P-256 parameters, provider/hardware
 * errors including StrongBox unavailability — surfaces as
 * [DeviceUnsupportedError]; there is deliberately NO software key fallback.
 * After generation the private key handle must report `format == null`
 * (non-exportable); otherwise the entry is deleted and the device is
 * declared unsupported.
 */
class DeviceKeyManager(
    private val alias: String = DEFAULT_ALIAS,
    private val keyPairGeneratorSource: KeyPairGeneratorSource =
        KeyPairGeneratorSource { algorithm, provider ->
            KeyPairGenerator.getInstance(algorithm, provider)
        },
) : DeviceSigner {

    /**
     * Seam for capability-probe failure-injection tests: produces the
     * `KeyPairGenerator` the manager uses. The default is the real
     * `KeyPairGenerator.getInstance(algorithm, "AndroidKeyStore")`.
     */
    fun interface KeyPairGeneratorSource {
        fun get(algorithm: String, provider: String): KeyPairGenerator
    }

    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    }

    @Volatile
    private var cachedKeyPair: KeyPair? = null

    /**
     * Returns the device keypair, generating it on first use. Idempotent:
     * an existing entry under [alias] is reused. Throws
     * [DeviceUnsupportedError] on any Keystore failure (see class docs).
     */
    @Synchronized
    fun ensureDeviceKey(): KeyPair {
        cachedKeyPair?.let { return it }

        val pair = loadExistingKeyPair() ?: generateDeviceKeyPair()
        // §4: the key must be non-exportable. AndroidKeyStore private keys
        // report format == null; anything else means an exportable
        // (software-level) key materialized — delete it and refuse.
        if (pair.private.format != null) {
            deleteKey()
            throw DeviceUnsupportedError(
                "Android Keystore private key is exportable (format=${pair.private.format}); " +
                    "device-auth requires a non-exportable key (spec §4)",
            )
        }
        cachedKeyPair = pair
        return pair
    }

    /** Signs [bytes] with `SHA256withECDSA`; returns the ASN.1 DER signature. */
    @Synchronized
    override fun sign(bytes: ByteArray): ByteArray {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(ensureDeviceKey().private)
        signature.update(bytes)
        return signature.sign()
    }

    /** The public key as X.509 SubjectPublicKeyInfo DER (§10.3 step 4). */
    override fun publicKeySpkiDer(): ByteArray = ensureDeviceKey().public.encoded

    /** `base64url_no_pad(SHA-256(SPKI DER))` (§10.3 step 5). */
    override fun deviceId(): String = deviceIdFromSpki(publicKeySpkiDer())

    /** Deletes the entry under [alias] (test cleanup / device revocation). */
    @Synchronized
    fun deleteKey() {
        cachedKeyPair = null
        if (keyStore.containsAlias(alias)) {
            keyStore.deleteEntry(alias)
        }
    }

    private fun loadExistingKeyPair(): KeyPair? {
        val privateKey = keyStore.getKey(alias, null) as? PrivateKey ?: return null
        val certificate = keyStore.getCertificate(alias) ?: return null
        return KeyPair(certificate.publicKey, privateKey)
    }

    private fun generateDeviceKeyPair(): KeyPair {
        val generator = try {
            keyPairGeneratorSource.get("EC", ANDROID_KEYSTORE)
        } catch (e: NoSuchAlgorithmException) {
            throw DeviceUnsupportedError("Android Keystore EC key generation is unavailable", e)
        } catch (e: NoSuchProviderException) {
            throw DeviceUnsupportedError("Android Keystore provider is unavailable", e)
        } catch (e: StrongBoxUnavailableException) {
            throw DeviceUnsupportedError("StrongBox is unavailable on this device", e)
        } catch (e: ProviderException) {
            throw DeviceUnsupportedError("Android Keystore provider failed", e)
        }

        return try {
            generator.initialize(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            generator.generateKeyPair()
        } catch (e: InvalidAlgorithmParameterException) {
            throw DeviceUnsupportedError("P-256 is unavailable in the Android Keystore", e)
        } catch (e: StrongBoxUnavailableException) {
            throw DeviceUnsupportedError("StrongBox is unavailable on this device", e)
        } catch (e: ProviderException) {
            throw DeviceUnsupportedError("Android Keystore key generation failed", e)
        }
    }

    companion object {
        /** Keystore alias of the production device-auth key. */
        const val DEFAULT_ALIAS = "claude_remote_device_auth"

        private const val ANDROID_KEYSTORE = "AndroidKeyStore"

        /**
         * `deviceId = base64url_no_pad(SHA-256(SPKI DER))` (§10.3 step 5) —
         * URL_SAFE (base64url alphabet), NO_PADDING, NO_WRAP.
         */
        fun deviceIdFromSpki(spkiDer: ByteArray): String =
            Base64.encodeToString(
                MessageDigest.getInstance("SHA-256").digest(spkiDer),
                Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
            )
    }
}
