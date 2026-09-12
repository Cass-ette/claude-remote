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
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.graphics.Color
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.clauderemote.android.BuildConfig
import dev.clauderemote.android.data.local.CommandEventEntity
import dev.clauderemote.android.data.local.MessageEntity
import dev.clauderemote.android.data.local.SessionEntity
import dev.clauderemote.android.network.ConnectionState
import dev.clauderemote.android.protocol.v1.PROTOCOL_VERSION
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
import java.time.Instant

/**
 * Single-activity Compose host (§12). This chunk wires the nav graph over
 * FAKE repositories — the screens and the framework-independent ViewModel
 * are real; Room/coordinator wiring lands with Task 33.
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
    val navController = rememberNavController()

    // Fake-backed shell wiring (this chunk); Task 33 swaps in Room DAOs and
    // the ConnectionCoordinator-backed sender.
    val repository = remember { DemoConversationRepository() }
    val commandSender = remember { CommandSender { } }
    val expirySource = remember { DemoTokenExpirySource() }
    val scope = rememberCoroutineScope()
    val viewModel = remember(DEMO_SESSION_ID) {
        ConversationViewModel(
            sessionId = DEMO_SESSION_ID,
            repository = repository,
            commandSender = commandSender,
            expirySource = expirySource,
            scope = scope,
        )
    }
    val uiState by viewModel.uiState.collectAsState()
    val importState by viewModel.importState.collectAsState()
    val expiryWarning by viewModel.expiryWarning.collectAsState()

    NavHost(navController = navController, startDestination = Routes.CONNECTION) {
        composable(Routes.CONNECTION) {
            ConnectionScreen(
                state = ConnectionUiState(
                    signedInAs = "demo@example.com",
                    paired = true,
                    deviceIdentity = "ZDAEY9MZFUQGLJ6L (demo)",
                    connectionState = ConnectionState.CONNECTED,
                    appVersion = BuildConfig.VERSION_NAME,
                    bridgeVersion = "2026.3.2 (demo)",
                    protocolVersion = PROTOCOL_VERSION,
                    claudeCodeVersion = "2.1.133 (demo)",
                    expiryWarning = expiryWarning,
                ),
                onReLogin = {},
                onScanPair = {},
                onOpenSessions = { navController.navigate(Routes.SESSIONS) },
            )
        }
        composable(Routes.SESSIONS) {
            SessionListScreen(
                state = demoSessionListState(),
                onOpenSession = { sessionId ->
                    navController.navigate(Routes.CONVERSATION.replace("{sessionId}", sessionId))
                },
                onNewSession = { _, _ -> },
                onScanImports = { navController.navigate(Routes.IMPORT) },
            )
        }
        composable(Routes.CONVERSATION) {
            LaunchedEffect(Unit) { viewModel.refresh() }
            ConversationScreen(
                state = uiState,
                expiryWarning = expiryWarning,
                connectionLabel = "Bridge 已连接 · 认证有效",
                modelName = "claude-fable-5 (demo)",
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
        composable(Routes.IMPORT) {
            ImportSessionScreen(
                state = importState.copy(projects = demoProjects),
                onPickProject = viewModel::importScan,
                onScan = { importState.projectId?.let(viewModel::importScan) },
                onConfirmImport = viewModel::importConfirm,
                onBack = { navController.popBackStack() },
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Demo (fake) data. Screens and ViewModel are production code; these fakes
// only stand in for the Room/coordinator wiring of Task 33.
// ---------------------------------------------------------------------------

private const val DEMO_SESSION_ID = "33333333-3333-4333-8333-333333333333"
private val demoProjects = listOf("claude-remote", "study/thesis")
private val demoInstant = Instant.parse("2026-09-01T08:00:00Z")

private fun demoSessionListState(): SessionListUiState {
    val rows = listOf(
        SessionRowUi(
            sessionId = DEMO_SESSION_ID,
            projectName = "claude-remote",
            title = "UI 壳与假仓库",
            model = "claude-fable-5",
            status = "running",
            lastActivity = "5 分钟前",
        ),
        SessionRowUi(
            sessionId = "44444444-4444-4444-8444-444444444444",
            projectName = "study/thesis",
            title = "论文修订",
            model = "claude-fable-5",
            status = "waiting_permission",
            lastActivity = "1 小时前",
        ),
        SessionRowUi(
            sessionId = "55555555-5555-4555-8555-555555555555",
            projectName = "claude-remote",
            title = "Bridge 重连策略",
            model = "claude-sonnet-4-6",
            status = "interrupted",
            lastActivity = "昨天",
        ),
    )
    return SessionListUiState(
        groups = SessionListGroup.entries
            .map { group -> group to rows.filter { sessionListGroupOf(it.status) == group } }
            .filter { (_, rowsInGroup) -> rowsInGroup.isNotEmpty() }
            .map { (group, rowsInGroup) -> SessionGroupUi(group, rowsInGroup) },
    )
}

/** In-memory demo projection: one running session with a tool call and an indeterminate send. */
private class DemoConversationRepository : ConversationRepository {
    private val session = SessionEntity(
        sessionId = DEMO_SESSION_ID,
        projectId = "claude-remote",
        displayName = "UI 壳与假仓库",
        status = "running",
        lastAckEventId = 42L,
        updatedAt = demoInstant,
    )

    private val messages = mutableListOf(
        MessageEntity(
            historyItemId = "demo-user-1",
            sessionId = DEMO_SESSION_ID,
            historyRevision = "live",
            role = "user",
            contentJson = """[{"kind":"text","text":"帮我看一下这个崩溃窗口"}]""",
            sourceIdsJson = "[]",
            status = "complete",
            requestId = "demo-req-1",
            position = 0,
            createdAt = "2026-09-01T07:59:00Z",
            updatedAt = demoInstant,
        ),
        MessageEntity(
            historyItemId = "demo-tool-1",
            sessionId = DEMO_SESSION_ID,
            historyRevision = "live",
            role = "tool",
            contentJson = """[{"kind":"tool_use","toolName":"Read","toolUseId":"demo-tool-1",""" +
                """"input":{"file_path":"/tmp/claude-remote/crash.log"}},""" +
                """{"kind":"tool_output","text":"(前 40 行崩溃日志…)","truncated":true}]""",
            sourceIdsJson = "[]",
            status = "complete",
            requestId = null,
            position = 1,
            createdAt = "2026-09-01T07:59:10Z",
            updatedAt = demoInstant,
        ),
        MessageEntity(
            historyItemId = "demo-user-2",
            sessionId = DEMO_SESSION_ID,
            historyRevision = "live",
            role = "user",
            contentJson = """[{"kind":"text","text":"再跑一次外场验证"}]""",
            sourceIdsJson = "[]",
            status = "complete",
            requestId = "demo-req-2",
            position = 2,
            createdAt = "2026-09-01T08:00:00Z",
            updatedAt = demoInstant,
        ),
    )

    private val commands = mutableListOf(
        CommandEventEntity(
            requestId = "demo-req-1",
            sessionId = DEMO_SESSION_ID,
            idempotencyKey = "demo-req-1",
            commandType = "message.send",
            status = "completed",
            resultJson = null,
            updatedAt = demoInstant,
        ),
        CommandEventEntity(
            requestId = "demo-req-2",
            sessionId = DEMO_SESSION_ID,
            idempotencyKey = "demo-req-2",
            commandType = "message.send",
            status = "indeterminate",
            resultJson = null,
            updatedAt = demoInstant,
        ),
    )

    override fun session(sessionId: String): SessionEntity? =
        session.takeIf { it.sessionId == sessionId }

    override fun messages(sessionId: String): List<MessageEntity> =
        messages.filter { it.sessionId == sessionId }.sortedBy { it.position }

    override fun commandEvents(sessionId: String): List<CommandEventEntity> =
        commands.filter { it.sessionId == sessionId }

    override fun upsertMessage(message: MessageEntity) {
        messages.removeAll { it.historyItemId == message.historyItemId }
        messages.add(message)
    }

    override fun upsertCommandEvent(event: CommandEventEntity) {
        commands.removeAll { it.requestId == event.requestId }
        commands.add(event)
    }
}

/** Demo expiry seam: no token is near expiry in the shell. */
private class DemoTokenExpirySource : TokenExpirySource {
    override fun accessTokenExpiresAtMs(): Long? = null
    override fun deviceSessionExpiresAtMs(): Long? = null
}
