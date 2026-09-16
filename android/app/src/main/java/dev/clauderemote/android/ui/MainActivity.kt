package dev.clauderemote.android.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.lifecycleScope
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.clauderemote.android.BuildConfig
import dev.clauderemote.android.ClaudeRemoteApp
import dev.clauderemote.android.auth.PairingController
import dev.clauderemote.android.network.ConnectionState
import dev.clauderemote.android.protocol.v1.PROTOCOL_VERSION
import dev.clauderemote.android.protocol.v1.SessionCreateCommand
import dev.clauderemote.android.protocol.v1.SessionCreatePayload
import dev.clauderemote.android.ui.connection.ConnectionScreen
import dev.clauderemote.android.ui.connection.ConnectionUiState
import dev.clauderemote.android.ui.connection.PairingDialog
import dev.clauderemote.android.ui.conversation.ConversationScreen
import dev.clauderemote.android.ui.import_.ImportSessionScreen
import dev.clauderemote.android.ui.sessions.SessionGroupUi
import dev.clauderemote.android.ui.sessions.SessionListGroup
import dev.clauderemote.android.ui.sessions.SessionListScreen
import dev.clauderemote.android.ui.sessions.SessionListUiState
import dev.clauderemote.android.ui.sessions.SessionRowUi
import dev.clauderemote.android.ui.sessions.sessionListGroupOf
import dev.clauderemote.android.ui.theme.AppTheme
import dev.clauderemote.android.sync.BridgeProject
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.launch

/**
 * Single-activity Compose host (§12), wired over the REAL graph
 * ([ClaudeRemoteApp.graph]): Room-backed projection, the live
 * ConnectionCoordinator, the real ConversationRepository/CommandSender seams.
 *
 * Nav graph: connection → sessions → (conversation | import).
 *
 * Deep links (singleTask, revised §10.2): the OAuth App Link redirect
 * (https://<bridge host>/auth/callback) and the pairing payload link
 * (claude-remote://pair?host=…&token=…) both land here via
 * [onNewIntent]/[onCreate] and route into the [PairingController].
 */
class MainActivity : ComponentActivity() {

    /** Prefill from a claude-remote://pair link; opens the pairing dialog. */
    val pairPrefill = mutableStateOf<PairingController.PairPrefill?>(null)

    /** Last login/pairing outcome line shown in the dialog and on the connection screen. */
    val pairingStatus = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AppTheme {
                ClaudeRemoteNavGraph()
            }
        }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val uri: Uri = intent?.data ?: return
        val app = application as ClaudeRemoteApp
        when {
            app.pairingController.isOAuthRedirect(uri) -> lifecycleScope.launch {
                runCatching { app.pairingController.onRedirect(uri) }
                    .onSuccess { outcome ->
                        pairingStatus.value = when (outcome) {
                            is PairingController.Outcome.Paired ->
                                "配对成功（设备 ${outcome.deviceId.take(8)}…），已连接 Bridge"
                            PairingController.Outcome.LoggedIn -> "登录成功"
                        }
                    }
                    .onFailure { e ->
                        pairingStatus.value = "配对/登录失败：${e.message ?: e.javaClass.simpleName}"
                    }
            }
            else -> app.pairingController.parsePairLink(uri)?.let { pairPrefill.value = it }
        }
    }
}

/**
 * §12.5 dark-first theming with Catppuccin Macchiato palette
 */
private object Routes {
    const val CONNECTION = "connection"
    const val SESSIONS = "sessions"
    const val CONVERSATION = "conversation/{sessionId}"
    const val IMPORT = "import"
}

@Composable
private fun ClaudeRemoteNavGraph() {
    val app = LocalContext.current.applicationContext as ClaudeRemoteApp
    val activity = LocalContext.current as? MainActivity
    val graph = app.graph ?: return
    val navController = rememberNavController()
    val scope = rememberCoroutineScope()

    val connectionState by graph.coordinator.state.collectAsState()
    var hostInput by remember { mutableStateOf(app.hostStore.bridgeHost() ?: "") }

    // Pairing dialog state; the prefill (deep link) and the outcome line come
    // from the activity's states so onNewIntent-driven updates recompose here.
    val prefill by activity?.pairPrefill ?: remember { mutableStateOf(null) }
    val status by activity?.pairingStatus ?: remember { mutableStateOf(null) }
    var pairDialogOpen by remember { mutableStateOf(false) }
    LaunchedEffect(prefill) {
        if (prefill != null) {
            pairDialogOpen = true
            prefill?.host?.takeIf { it.isNotBlank() }?.let { hostInput = it }
        }
    }

    // The session list is a read over the same Room projection the event
    // pipeline writes; it reloads whenever a session's projection changes.
    var sessionRows by remember { mutableStateOf(graph.sessionSnapshots()) }
    LaunchedEffect(Unit) {
        graph.projectionChanged.collect {
            sessionRows = graph.sessionSnapshots()
        }
    }

    // §7.2 step 1: the bridge-authorized project list (NOT derived from the
    // local session projection — a fresh install has no sessions yet). Fetched
    // when the new-session dialog opens and when the import screen is entered.
    var bridgeProjects by remember { mutableStateOf<List<BridgeProject>>(emptyList()) }
    val fetchProjects: () -> Unit = {
        scope.launch {
            runCatching { graph.projectApi.listProjects() }
                .onSuccess { bridgeProjects = it }
        }
    }

    /** Launches the interactive browser login (optionally with a pairing token). */
    fun startInteractiveLogin(host: String, pairingToken: String?) {
        scope.launch {
            activity?.pairingStatus?.value = "正在打开浏览器登录…"
            runCatching { app.pairingController.begin(host, pairingToken) }
                .onSuccess { intent ->
                    activity?.pairingStatus?.value = "请在浏览器中完成 Cloudflare 登录"
                    // Application contexts cannot startActivity without
                    // FLAG_ACTIVITY_NEW_TASK — that crashes instead of opening
                    // the Custom Tab, so prefer the activity context.
                    val starter = activity ?: app.also { intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
                    starter.startActivity(intent)
                }
                .onFailure { e ->
                    activity?.pairingStatus?.value =
                        "无法开始登录：${e.message ?: e.javaClass.simpleName}"
                }
        }
    }

    NavHost(navController = navController, startDestination = Routes.CONNECTION) {
        composable(Routes.CONNECTION) {
            if (pairDialogOpen) {
                PairingDialog(
                    initialHost = prefill?.host ?: hostInput,
                    initialToken = prefill?.pairingToken.orEmpty(),
                    status = status,
                    onDismiss = {
                        pairDialogOpen = false
                        activity?.pairPrefill?.value = null
                    },
                    onSubmit = { host, token ->
                        pairDialogOpen = false
                        activity?.pairPrefill?.value = null
                        hostInput = host
                        app.saveBridgeHost(host)
                        startInteractiveLogin(host, token.ifBlank { null })
                    },
                )
            }
            // Reading `status` here recomputes the identity/pairing reads on
            // every login/pairing outcome.
            ConnectionScreen(
                state = ConnectionUiState(
                    // Display-only decode of the Access token's `sub` claim
                    // (verification already happened at exchange/refresh).
                    // Bridge-issued access tokens are opaque (not JWTs), so a
                    // null subject decode is expected while still signed in.
                    signedInAs = graph.tokenStore.getAccessToken()?.let { stored ->
                        decodeJwtSubject(stored.token) ?: "Bridge 令牌"
                    },
                    paired = graph.tokenStore.getDeviceSessionToken() != null,
                    deviceIdentity = runCatching { graph.deviceKeys.deviceId() }
                        .getOrElse { "设备密钥不可用" },
                    connectionState = connectionState,
                    appVersion = BuildConfig.VERSION_NAME,
                    bridgeVersion = null,
                    protocolVersion = PROTOCOL_VERSION,
                    claudeCodeVersion = null,
                    expiryWarning = null,
                    bridgeHost = hostInput,
                    pairingStatus = status,
                ),
                onReLogin = {
                    scope.launch {
                        if (graph.tokenStore.getRefreshToken() == null) {
                            // No completed login on this install: interactive.
                            startInteractiveLogin(hostInput, null)
                        } else {
                            runCatching { graph.oauth.getValidAccessToken(forceRefresh = true) }
                                .onSuccess { graph.coordinator.start() }
                                .onFailure { e ->
                                    // A dead refresh token must fall through to
                                    // the browser — never leave the user stuck
                                    // with no in-app path forward.
                                    activity?.pairingStatus?.value =
                                        "刷新失败，改为浏览器重新登录：${e.message ?: e.javaClass.simpleName}"
                                    startInteractiveLogin(hostInput, null)
                                }
                        }
                    }
                },
                onScanPair = { pairDialogOpen = true },
                onBridgeHostChange = { hostInput = it },
                onSaveBridgeHost = { app.saveBridgeHost(hostInput) },
                onOpenSessions = { navController.navigate(Routes.SESSIONS) },
            )
        }
        composable(Routes.SESSIONS) {
            SessionListScreen(
                state = sessionListState(sessionRows.map(::sessionRowOf)),
                projects = bridgeProjects,
                onFetchProjects = fetchProjects,
                onOpenSession = { sessionId ->
                    navController.navigate(Routes.CONVERSATION.replace("{sessionId}", sessionId))
                },
                onNewSession = { projectId, displayName ->
                    scope.launch {
                        graph.sendCommand(
                            SessionCreateCommand(
                                requestId = UUID.randomUUID().toString(),
                                idempotencyKey = UUID.randomUUID().toString(),
                                sentAt = Instant.now().toString(),
                                payload = SessionCreatePayload(projectId, displayName),
                            ),
                        )
                    }
                },
                onScanImports = { navController.navigate(Routes.IMPORT) },
            )
        }
        composable(Routes.CONVERSATION) { entry ->
            val sessionId = entry.arguments?.getString("sessionId").orEmpty()
            ConversationDestination(graph, sessionId)
        }
        composable(Routes.IMPORT) {
            val viewModel = remember {
                ConversationViewModel(
                    sessionId = "",
                    repository = graph.conversationRepository,
                    commandSender = graph.sendCommand,
                    expirySource = graph.tokenExpirySource,
                    scope = scope,
                )
            }
            val importState by viewModel.importState.collectAsState()
            LaunchedEffect(Unit) { fetchProjects() }
            LaunchedEffect(bridgeProjects) {
                // The import picker lists the bridge-authorized projects
                // (§12.4), not the local projection. The picker value feeds
                // session.scan_imports verbatim, so it must stay the projectId.
                viewModel.setKnownProjects(bridgeProjects.map { it.projectId })
            }
            ImportSessionScreen(
                state = importState,
                onPickProject = viewModel::importScan,
                onScan = { importState.projectId?.let(viewModel::importScan) },
                onConfirmImport = viewModel::importConfirm,
                onBack = { navController.popBackStack() },
            )
        }
    }
}

/** The conversation destination: one ViewModel over the real seams. */
@Composable
private fun ConversationDestination(
    graph: dev.clauderemote.android.AppGraph,
    sessionId: String,
) {
    val scope = rememberCoroutineScope()
    val viewModel = remember(sessionId) {
        ConversationViewModel(
            sessionId = sessionId,
            repository = graph.conversationRepository,
            commandSender = graph.sendCommand,
            expirySource = graph.tokenExpirySource,
            scope = scope,
        )
    }
    val uiState by viewModel.uiState.collectAsState()
    val expiryWarning by viewModel.expiryWarning.collectAsState()
    val connectionState by graph.coordinator.state.collectAsState()

    // §11.1 coordinator signals surface as conversation banners; the RESYNC
    // banner clears when the connection returns to CONNECTED after recovery.
    LaunchedEffect(sessionId) {
        graph.coordinator.signals.collect { viewModel.onCoordinatorSignal(it) }
    }
    LaunchedEffect(sessionId) {
        graph.coordinator.state.collect { state ->
            if (state == ConnectionState.CONNECTED &&
                viewModel.uiState.value.banner == ConversationBanner.RESYNC_REQUIRED
            ) {
                viewModel.clearBanner()
            }
        }
    }
    // Re-derive the UI state whenever this session's projection changed.
    LaunchedEffect(sessionId) {
        graph.projectionChanged.collect { changed ->
            if (changed == sessionId) viewModel.refresh()
        }
    }
    LaunchedEffect(Unit) { viewModel.refresh() }

    ConversationScreen(
        state = uiState,
        expiryWarning = expiryWarning,
        connectionLabel = when (connectionState) {
            ConnectionState.CONNECTED -> "Bridge 已连接"
            ConnectionState.CONNECTING -> "Bridge 连接中…"
            ConnectionState.DISCONNECTED -> "Bridge 未连接"
            ConnectionState.STOPPED -> "Bridge 已停止"
        },
        modelName = "跟随 Mac 设置",
        onSendMessage = viewModel::sendMessage,
        onSafeRetry = viewModel::safeRetry,
        onResume = viewModel::resume,
        onSendContinue = viewModel::sendContinue,
        onStop = viewModel::stop,
        onRelease = viewModel::release,
        onAllowPermission = viewModel::allowPermission,
        onDenyPermission = viewModel::denyPermission,
    )
}

/** Groups the projected sessions into the §12.1 list. */
private fun sessionListState(rows: List<SessionRowUi>): SessionListUiState = SessionListUiState(
    groups = SessionListGroup.entries
        .map { group -> group to rows.filter { sessionListGroupOf(it.status) == group } }
        .filter { (_, rowsInGroup) -> rowsInGroup.isNotEmpty() }
        .map { (group, rowsInGroup) -> SessionGroupUi(group, rowsInGroup) },
)

/** Maps one projected session onto its §12.1 row. */
private fun sessionRowOf(session: dev.clauderemote.android.data.local.SessionEntity) = SessionRowUi(
    sessionId = session.sessionId,
    projectName = session.projectId.ifBlank { "未知项目" },
    title = session.displayName.ifBlank { session.sessionId.take(8) },
    model = "跟随 Mac 设置",
    status = session.status,
    lastActivity = relativeActivity(session.updatedAt),
)

/**
 * DISPLAY-ONLY JWT `sub` decode (no signature check — verification already
 * happened at exchange/refresh; this never gates any decision).
 */
private fun decodeJwtSubject(token: String?): String? {
    if (token == null) return null
    val parts = token.split(".")
    if (parts.size != 3) return null
    return runCatching {
        val payload = String(java.util.Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8)
        (kotlinx.serialization.json.Json.parseToJsonElement(payload) as? kotlinx.serialization.json.JsonObject)
            ?.get("sub")
            ?.let { it as? kotlinx.serialization.json.JsonPrimitive }
            ?.takeIf { it.isString }
            ?.content
    }.getOrNull()
}

private fun relativeActivity(instant: Instant, now: Instant = Instant.now()): String {
    val minutes = Duration.between(instant, now).toMinutes()
    return when {
        minutes < 1 -> "刚刚"
        minutes < 60 -> "$minutes 分钟前"
        minutes < 24 * 60 -> "${minutes / 60} 小时前"
        else -> "${minutes / (24 * 60)} 天前"
    }
}
