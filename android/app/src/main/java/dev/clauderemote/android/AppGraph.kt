package dev.clauderemote.android

import android.content.Context
import android.content.SharedPreferences
import androidx.room.Room
import dev.clauderemote.android.auth.AppAuthTokenRefresher
import dev.clauderemote.android.auth.DeviceSessionManager
import dev.clauderemote.android.auth.EncryptedAccessTokenStore
import dev.clauderemote.android.auth.EncryptedDeviceSessionCache
import dev.clauderemote.android.auth.EncryptedTokenStore
import dev.clauderemote.android.auth.AccessTokens
import dev.clauderemote.android.auth.HttpBridgeAuthApi
import dev.clauderemote.android.auth.OAuthManager
import dev.clauderemote.android.auth.PlatformAppLinkVerifier
import dev.clauderemote.android.auth.ReLoginRequiredError
import dev.clauderemote.android.auth.TokenRefresher
import dev.clauderemote.android.data.local.AppDatabase
import dev.clauderemote.android.data.local.Migrations
import dev.clauderemote.android.network.ConnectionCoordinator
import dev.clauderemote.android.network.CoordinatorSignal
import dev.clauderemote.android.network.HttpBridgeApi
import dev.clauderemote.android.network.ManagerCredentialSource
import dev.clauderemote.android.network.OkHttpBridgeTransport
import dev.clauderemote.android.security.DeviceKeyManager
import dev.clauderemote.android.sync.BridgeSnapshotApi
import dev.clauderemote.android.sync.SessionRepository
import dev.clauderemote.android.sync.SnapshotCoordinator
import dev.clauderemote.android.ui.ConversationRepository
import dev.clauderemote.android.ui.TokenExpirySource
import dev.clauderemote.android.data.local.CommandEventEntity
import dev.clauderemote.android.data.local.MessageEntity
import dev.clauderemote.android.data.local.SessionEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import net.openid.appauth.AuthorizationServiceConfiguration

/**
 * The composition root (spec §12 wiring): builds the REAL dependency graph —
 * Room projection, Keystore device key, encrypted token store, OAuth manager,
 * device-session manager, HTTP/WS transport, connection coordinator, §6.7
 * snapshot coordinator, session repository — and owns the runtime loops that
 * tie them together:
 *
 * - the coordinator's §8.4 event stream is folded into Room through
 *   [SessionRepository.handleEvent] (buffer-or-apply + guarded ACK), then a
 *   [projectionChanged] notification lets the UI re-read the projection;
 * - a 4410 ResyncRequired signal parks reconnection, runs the §6.7 recovery
 *   for every known session (pending-commit recovery first), and re-enters
 *   the connect loop, which posts the checkpointed watermark as its
 *   resume-from marker (§11.1);
 * - startup runs [SnapshotCoordinator.recoverPendingCheckpoints] so a crash
 *   between the checkpoint transaction and the commit is retried with the
 *   SAME idempotency key (§6.7).
 *
 * Config seams: [BridgeEndpoints] fixes the base URLs (BuildConfig debug
 * default, or the user-entered host persisted by [BridgeHostStore]); the
 * E2E suite drives this same graph over its embedded fake bridge with a
 * seeded opaque Access token in the real encrypted store.
 */
class AppGraph private constructor(
    val context: Context,
    val endpoints: BridgeEndpoints,
    val applicationScope: CoroutineScope,
    val db: AppDatabase,
    val tokenStore: EncryptedTokenStore,
    val deviceKeys: DeviceKeyManager,
    val oauth: OAuthManager,
    val deviceSessions: DeviceSessionManager,
    val coordinator: ConnectionCoordinator,
    val snapshotCoordinator: SnapshotCoordinator,
    val repository: SessionRepository,
    val conversationRepository: ConversationRepository,
    val tokenExpirySource: TokenExpirySource,
) {

    /** Emits the sessionId whose projection just changed (post-handleEvent). */
    private val _projectionChanged = MutableSharedFlow<String>(extraBufferCapacity = 256)
    val projectionChanged: SharedFlow<String> = _projectionChanged.asSharedFlow()

    /** Sends one §8.2 envelope over the live socket (the ViewModels' seam). */
    val sendCommand: suspend (dev.clauderemote.android.protocol.v1.ProtocolCommand) -> Unit =
        { command -> coordinator.send(command) }

    /** All projected sessions, newest first (the session list's read model). */
    fun sessionSnapshots(): List<SessionEntity> = db.sessionDao().getAll()

    private var started = false
    private var startJob: Job? = null

    /**
     * Idempotent runtime start: startup checkpoint recovery, the event
     * pipeline, the 4410 recovery handler, and the connect loop.
     */
    fun start() {
        if (started) return
        started = true
        startJob = applicationScope.launch {
            // §6.7 crash window: a pending checkpoint row means the app died
            // between the Room transaction and the confirmed commit — retry
            // the SAME idempotency key before anything else talks to the bridge.
            runCatching { snapshotCoordinator.recoverPendingCheckpoints() }
        }
        applicationScope.launch {
            coordinator.events.collect { event ->
                runCatching { repository.handleEvent(event) }
                _projectionChanged.tryEmit(event.sessionId)
            }
        }
        applicationScope.launch {
            coordinator.signals.collect { signal ->
                if (signal is CoordinatorSignal.ResyncRequired) launch {
                    onResyncRequired()
                }
            }
        }
        coordinator.start()
    }

    /** Stops the connect loop and cancels the runtime scopes. */
    fun shutdown() {
        coordinator.stop()
        applicationScope.cancel()
    }

    /**
     * §6.7/§11.1 recovery after a 4410: recover any pending commit first (the
     * pending table is single-row), then rebuild every known session's
     * projection with a fresh snapshot cycle, then re-enter the connect loop —
     * the reconnect's resume ACK then carries the checkpointed watermark.
     */
    private suspend fun onResyncRequired() {
        runCatching { snapshotCoordinator.recoverPendingCheckpoints() }
        for (session in db.sessionDao().getAll()) {
            runCatching { snapshotCoordinator.onResyncRequired(session.sessionId) }
                .onFailure { _projectionChanged.tryEmit(session.sessionId) }
        }
        coordinator.start()
    }

    companion object {

        /**
         * Builds the production graph. Every piece is the real implementation;
         * the E2E suite drives this same graph over its embedded fake bridge
         * with a seeded opaque Access token in the real encrypted store.
         */
        fun build(
            context: Context,
            endpoints: BridgeEndpoints,
            dbName: String = AppDatabase.NAME,
            applicationScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
        ): AppGraph {
            val appContext = context.applicationContext

            // allowMainThreadQueries: the ConversationRepository seam the
            // ViewModel reads is synchronous and is called from composition;
            // every query is a small indexed projection read, and all protocol
            // writes still run inside Room transactions on worker dispatchers.
            val db = Room.databaseBuilder(appContext, AppDatabase::class.java, dbName)
                .addMigrations(*Migrations.ALL)
                .allowMainThreadQueries()
                .build()

            val tokenStore = EncryptedTokenStore(appContext)
            val deviceKeys = DeviceKeyManager()
            val oauth = OAuthManager(
                appLinkVerifier = PlatformAppLinkVerifier(appContext),
                tokenStore = EncryptedAccessTokenStore(tokenStore),
                tokenRefresher = StoredTokenRefresher(appContext),
            )
            val sessionCache = EncryptedDeviceSessionCache(tokenStore)
            val deviceSessions = DeviceSessionManager(
                authApi = HttpBridgeAuthApi(endpoints.httpBaseUrl),
                oauth = oauth,
                signer = deviceKeys,
                sessionCache = sessionCache,
            )
            val credentialSource = ManagerCredentialSource(oauth, deviceSessions, sessionCache)

            val commandsApi = HttpBridgeApi(
                baseUrl = endpoints.httpBaseUrl,
                credentialsProvider = { credentialSource.currentCredentials() },
            )
            val transport = OkHttpBridgeTransport(endpoints.wsUrl)

            // The coordinator reads resume markers from the repository, and
            // the repository ACKs through the coordinator — break the cycle
            // with a late binding on the ack-position source.
            var sessionRepository: SessionRepository? = null
            val coordinator = ConnectionCoordinator(
                transport = transport,
                credentialSource = credentialSource,
                ackPositions = { sessionRepository?.lastAckedEventIds() ?: emptyMap() },
                scope = applicationScope,
            )
            val snapshotCoordinator = SnapshotCoordinator(
                db = db,
                api = BridgeSnapshotApi(commandsApi),
                ackSender = { sessionId, lastEventId -> coordinator.acknowledge(sessionId, lastEventId) },
            )
            sessionRepository = SessionRepository(db = db, coordinator = snapshotCoordinator)

            return AppGraph(
                context = appContext,
                endpoints = endpoints,
                applicationScope = applicationScope,
                db = db,
                tokenStore = tokenStore,
                deviceKeys = deviceKeys,
                oauth = oauth,
                deviceSessions = deviceSessions,
                coordinator = coordinator,
                snapshotCoordinator = snapshotCoordinator,
                repository = sessionRepository,
                conversationRepository = RoomConversationRepository(db),
                tokenExpirySource = StoreTokenExpirySource(tokenStore),
            )
        }
    }
}

/**
 * The two base URLs the transport stack talks to: the HTTP command/auth host
 * and the §8.1 WebSocket stream (bridge WS_PATH "/api/v1/ws").
 */
data class BridgeEndpoints(val httpBaseUrl: String, val wsUrl: String) {
    companion object {
        fun of(httpBaseUrl: String): BridgeEndpoints =
            BridgeEndpoints(
                httpBaseUrl = httpBaseUrl.trimEnd('/'),
                wsUrl = httpBaseUrl.trimEnd('/').replaceFirst("http", "ws") + "/api/v1/ws",
            )
    }
}

/**
 * Persists the user-entered bridge host (the ConnectionScreen input). The
 * host itself is not a secret — tokens stay in [EncryptedTokenStore] — so a
 * plain SharedPreferences file is the right home for it.
 */
class BridgeHostStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    /** The user-entered host (bare host or full base URL), or null until configured. */
    fun bridgeHost(): String? = prefs.getString(KEY_HOST, null)?.takeIf { it.isNotBlank() }

    fun save(host: String) {
        prefs.edit().putString(KEY_HOST, host.trim()).apply()
    }

    private companion object {
        const val PREFS_FILE = "bridge_config"
        const val KEY_HOST = "bridge_host"
    }
}

/**
 * [TokenRefresher] over the persisted AppAuth state of a completed
 * interactive login (Task 29 flow). Until a login has completed on this
 * install there is no configuration, and every refresh surfaces
 * [ReLoginRequiredError] — there is no secondary credential source (§10.2).
 */
class StoredTokenRefresher(private val context: Context) : TokenRefresher {

    override suspend fun refresh(refreshToken: String): AccessTokens {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
        val configJson = prefs.getString(KEY_CONFIG, null)
        val clientId = prefs.getString(KEY_CLIENT_ID, null)
        if (configJson == null || clientId == null) {
            throw ReLoginRequiredError(
                "no interactive login has completed on this install; cannot refresh silently",
            )
        }
        val configuration = AuthorizationServiceConfiguration.fromJson(configJson)
        return AppAuthTokenRefresher(context, configuration, clientId).refresh(refreshToken)
    }

    /** Persists the OAuth endpoints + public client id of a completed login. */
    fun storeLogin(configuration: AuthorizationServiceConfiguration, clientId: String) {
        context.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CONFIG, configuration.toJsonString())
            .putString(KEY_CLIENT_ID, clientId)
            .apply()
    }

    private companion object {
        const val PREFS_FILE = "bridge_oauth"
        const val KEY_CONFIG = "oauth_configuration_json"
        const val KEY_CLIENT_ID = "oauth_client_id"
    }
}

/**
 * [ConversationRepository] over the Room DAOs — the production seam the
 * ConversationViewModel reads and writes its optimistic §7.4 intents through.
 */
class RoomConversationRepository(private val db: AppDatabase) : ConversationRepository {

    override fun session(sessionId: String): SessionEntity? = db.sessionDao().getBySessionId(sessionId)

    override fun messages(sessionId: String): List<MessageEntity> = db.messageDao().getForSession(sessionId)

    override fun commandEvents(sessionId: String): List<CommandEventEntity> =
        db.commandEventDao().getForSession(sessionId)

    override fun upsertMessage(message: MessageEntity) {
        db.messageDao().upsertMessage(message)
    }

    override fun upsertCommandEvent(event: CommandEventEntity) {
        db.commandEventDao().upsert(event)
    }
}

/**
 * [TokenExpirySource] over the encrypted token store: the §12.5
 * refresh-expiry warning derives from the SAME persisted expiries the
 * managers refresh against.
 */
class StoreTokenExpirySource(private val store: EncryptedTokenStore) : TokenExpirySource {

    override fun accessTokenExpiresAtMs(): Long? = store.getAccessToken()?.expiresAtMs

    override fun deviceSessionExpiresAtMs(): Long? = store.getDeviceSessionToken()?.expiresAtMs
}
