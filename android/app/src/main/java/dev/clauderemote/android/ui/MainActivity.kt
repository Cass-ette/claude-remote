package dev.clauderemote.android.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.clauderemote.android.BuildConfig
import dev.clauderemote.android.ClaudeRemoteApp
import dev.clauderemote.android.network.ConnectionState
import dev.clauderemote.android.protocol.v1.PROTOCOL_VERSION
import dev.clauderemote.android.protocol.v1.SessionCreateCommand
import dev.clauderemote.android.protocol.v1.SessionCreatePayload
import dev.clauderemote.android.ui.connection.ConnectionScreen
import dev.clauderemote.android.ui.connection.ConnectionUiState
import dev.clauderemote.android.ui.conversation.ConversationScreen
import dev.clauderemote.android.ui.import_.ImportSessionScreen
import dev.clauderemote.android.ui.sessions.SessionGroupUi
import dev.clauderemote.android.ui.sessions.SessionListGroup
import dev.clauderemote.android.ui.sessions.SessionListScreen
import dev.clauderemote.android.ui.sessions.SessionListUiState
import dev.clauderemote.android.ui.sessions.SessionRowUi
import dev.clauderemote.android.ui.sessions.sessionListGroupOf
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
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ClaudeRemoteTheme {
                ClaudeRemoteNavGraph()
            }
        }
    }
}

/**
 * §12.5 dark-first theming: the DARK scheme is the app's base palette; a
 * light scheme exists as a secondary option for light-system users.
 */
@Composable
fun ClaudeRemoteTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme,
        content = content,
    )
}

private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFF9EC6FF),
    onPrimary = Color(0xFF00325B),
    primaryContainer = Color(0xFF1B4A78),
    onPrimaryContainer = Color(0xFFD3E4FF),
    secondary = Color(0xFFBAC7DC),
    onSecondary = Color(0xFF243140),
    secondaryContainer = Color(0xFF3B4857),
    onSecondaryContainer = Color(0xFFD6E3F8),
    tertiary = Color(0xFFDFBBFD),
    onTertiary = Color(0xFF40255E),
    tertiaryContainer = Color(0xFF583B76),
    onTertiaryContainer = Color(0xFFF4DAFF),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF1A1C1E),
    onBackground = Color(0xFFE3E2E6),
    surface = Color(0xFF1A1C1E),
    onSurface = Color(0xFFE3E2E6),
    surfaceVariant = Color(0xFF43474E),
    onSurfaceVariant = Color(0xFFC4C6CF),
)

private val LightColorScheme = lightColorScheme(
    primary = Color(0xFF2A5E97),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD3E4FF),
    onPrimaryContainer = Color(0xFF001C36),
    secondary = Color(0xFF526070),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFD6E3F8),
    onSecondaryContainer = Color(0xFF0F1D2A),
    tertiary = Color(0xFF6F567F),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFF9D8FD),
    onTertiaryContainer = Color(0xFF291336),
    background = Color(0xFFFDFBFF),
    onBackground = Color(0xFF1A1C1E),
    surface = Color(0xFFFDFBFF),
    onSurface = Color(0xFF1A1C1E),
    surfaceVariant = Color(0xFFDFE2EB),
    onSurfaceVariant = Color(0xFF43474E),
)

private object Routes {
    const val CONNECTION = "connection"
    const val SESSIONS = "sessions"
    const val CONVERSATION = "conversation/{sessionId}"
    const val IMPORT = "import"
}

@Composable
private fun ClaudeRemoteNavGraph() {
    val app = LocalContext.current.applicationContext as ClaudeRemoteApp
    val graph = app.graph ?: return
    val navController = rememberNavController()
    val scope = rememberCoroutineScope()

    val connectionState by graph.coordinator.state.collectAsState()
    var hostInput by remember { mutableStateOf(app.hostStore.bridgeHost() ?: "") }

    // The session list is a read over the same Room projection the event
    // pipeline writes; it reloads whenever a session's projection changes.
    var sessionRows by remember { mutableStateOf(graph.sessionSnapshots()) }
    LaunchedEffect(Unit) {
        graph.projectionChanged.collect {
            sessionRows = graph.sessionSnapshots()
        }
    }

    NavHost(navController = navController, startDestination = Routes.CONNECTION) {
        composable(Routes.CONNECTION) {
            ConnectionScreen(
                state = ConnectionUiState(
                    // The signed-in identity becomes available once the
                    // interactive OAuth login (Task 29 browser flow) has run
                    // on this install; until then no assertion is fabricated.
                    signedInAs = null,
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
                ),
                onReLogin = {
                    // Programmatic half of the re-login path: force an Access
                    // refresh through the real OAuthManager, then restart the
                    // connect loop. The interactive browser flow requires a
                    // verified App Link host and lands with the login wiring.
                    scope.launch {
                        runCatching { graph.oauth.getValidAccessToken(forceRefresh = true) }
                        graph.coordinator.start()
                    }
                },
                onScanPair = {
                    // Pairing needs the one-time token from the Mac-side QR;
                    // the enrollment itself goes through the real
                    // DeviceSessionManager once the scanner is wired.
                },
                onBridgeHostChange = { hostInput = it },
                onSaveBridgeHost = { app.saveBridgeHost(hostInput) },
                onOpenSessions = { navController.navigate(Routes.SESSIONS) },
            )
        }
        composable(Routes.SESSIONS) {
            SessionListScreen(
                state = sessionListState(sessionRows.map(::sessionRowOf)),
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
            LaunchedEffect(sessionRows) {
                // The project picker lists the projects this install already
                // tracks in the projection (Bridge-authorized projects).
                viewModel.setKnownProjects(sessionRows.map { it.projectId }.distinct())
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

private fun relativeActivity(instant: Instant, now: Instant = Instant.now()): String {
    val minutes = Duration.between(instant, now).toMinutes()
    return when {
        minutes < 1 -> "刚刚"
        minutes < 60 -> "$minutes 分钟前"
        minutes < 24 * 60 -> "${minutes / 60} 小时前"
        else -> "${minutes / (24 * 60)} 天前"
    }
}
