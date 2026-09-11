package dev.clauderemote.android.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Keystore-encrypted at-rest storage for every long-lived secret the app
 * holds (spec §10.2 step 6, §10.3): the OAuth Access token, the OAuth
 * refresh token, and the device session token with its expiry.
 *
 * Backed by [EncryptedSharedPreferences] under a MasterKey with the
 * AES-256-GCM key scheme (Android Keystore); preference keys are encrypted
 * with AES256-SIV and values with AES256-GCM.
 *
 * SECURITY INVARIANTS:
 *   * Values are NEVER logged, and never leave this class except through
 *     its typed accessors;
 *   * nothing here falls back to plaintext SharedPreferences — if the
 *     encrypted store cannot be created, access fails rather than
 *     downgrading;
 *   * the Room `device_session` row keeps only a REFERENCE to this store
 *     (Token persistence itself lives here).
 */
class EncryptedTokenStore(
    context: Context,
    fileName: String = DEFAULT_FILE_NAME,
) {
    private val appContext = context.applicationContext

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            fileName,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /** A stored token plus its advertised epoch-ms expiry (null = unknown). */
    data class StoredToken(val token: String, val expiresAtMs: Long?)

    // -- OAuth Access token ------------------------------------------------

    fun getAccessToken(): StoredToken? =
        prefs.getString(KEY_ACCESS_TOKEN, null)?.let { token ->
            StoredToken(token, if (prefs.contains(KEY_ACCESS_EXPIRES_AT)) getLong(KEY_ACCESS_EXPIRES_AT) else null)
        }

    fun putAccessToken(token: String, expiresAtMs: Long?) {
        prefs.edit()
            .putString(KEY_ACCESS_TOKEN, token)
            .apply {
                if (expiresAtMs != null) putLong(KEY_ACCESS_EXPIRES_AT, expiresAtMs) else remove(KEY_ACCESS_EXPIRES_AT)
            }
            .apply()
    }

    fun clearAccessToken() {
        prefs.edit()
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_ACCESS_EXPIRES_AT)
            .apply()
    }

    // -- OAuth refresh token ----------------------------------------------

    fun getRefreshToken(): String? = prefs.getString(KEY_REFRESH_TOKEN, null)

    fun putRefreshToken(token: String) {
        prefs.edit().putString(KEY_REFRESH_TOKEN, token).apply()
    }

    fun clearRefreshToken() {
        prefs.edit().remove(KEY_REFRESH_TOKEN).apply()
    }

    // -- Device session token ---------------------------------------------

    /**
     * The cached device session, or null when absent. A token row without a
     * recorded expiry is treated as unusable (fail-safe: force a refresh).
     */
    fun getDeviceSessionToken(): StoredToken? {
        val token = prefs.getString(KEY_DEVICE_SESSION_TOKEN, null) ?: return null
        if (!prefs.contains(KEY_DEVICE_SESSION_EXPIRES_AT)) return null
        return StoredToken(token, getLong(KEY_DEVICE_SESSION_EXPIRES_AT))
    }

    fun putDeviceSessionToken(token: String, expiresAtMs: Long) {
        prefs.edit()
            .putString(KEY_DEVICE_SESSION_TOKEN, token)
            .putLong(KEY_DEVICE_SESSION_EXPIRES_AT, expiresAtMs)
            .apply()
    }

    fun clearDeviceSessionToken() {
        prefs.edit()
            .remove(KEY_DEVICE_SESSION_TOKEN)
            .remove(KEY_DEVICE_SESSION_EXPIRES_AT)
            .apply()
    }

    /** Full logout: drops every stored credential. */
    fun clearAll() {
        clearAccessToken()
        clearRefreshToken()
        clearDeviceSessionToken()
    }

    private fun getLong(key: String): Long =
        requireNotNull(prefs.getLong(key, Long.MIN_VALUE)) { "missing long for $key" }

    companion object {
        const val DEFAULT_FILE_NAME = "claude_remote_tokens"

        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_ACCESS_EXPIRES_AT = "access_expires_at_ms"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_DEVICE_SESSION_TOKEN = "device_session_token"
        private const val KEY_DEVICE_SESSION_EXPIRES_AT = "device_session_expires_at_ms"
    }
}

/**
 * [AccessTokenStore] over [EncryptedTokenStore] — the OAuthManager's
 * production persistence seam.
 */
class EncryptedAccessTokenStore(
    private val store: EncryptedTokenStore,
) : AccessTokenStore {
    override fun getAccess(): StoredAccessToken? =
        store.getAccessToken()?.let { StoredAccessToken(it.token, it.expiresAtMs) }

    override fun getRefreshToken(): String? = store.getRefreshToken()

    override fun putAccess(token: String, expiresAtMs: Long?) =
        store.putAccessToken(token, expiresAtMs)

    override fun putRefreshToken(token: String) = store.putRefreshToken(token)

    override fun clearAccess() = store.clearAccessToken()
}

/**
 * [DeviceSessionCache] over [EncryptedTokenStore] — the DeviceSessionManager's
 * production token cache.
 */
class EncryptedDeviceSessionCache(
    private val store: EncryptedTokenStore,
) : DeviceSessionCache {
    override fun get(): CachedDeviceSession? =
        store.getDeviceSessionToken()?.let { CachedDeviceSession(it.token, it.expiresAtMs ?: 0L) }

    override fun put(token: String, expiresAtMs: Long) =
        store.putDeviceSessionToken(token, expiresAtMs)

    override fun clear() = store.clearDeviceSessionToken()
}
