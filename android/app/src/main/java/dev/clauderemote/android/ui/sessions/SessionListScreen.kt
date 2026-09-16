package dev.clauderemote.android.ui.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.clauderemote.android.sync.BridgeProject
import dev.clauderemote.android.ui.theme.AppColors
import dev.clauderemote.android.ui.theme.EnhancedCard
import dev.clauderemote.android.ui.theme.PrimaryButton
import dev.clauderemote.android.ui.theme.SecondaryButton
import dev.clauderemote.android.ui.theme.StatusBadge

/**
 * §12.1 session list — sessions grouped by lifecycle state (等待批准 /
 * 正在运行 / 已停止); each row shows the project name, title, the model
 * Claude Code currently reports, status, and the last activity time. The
 * page offers new-session and scan-old-sessions entries (§12.4).
 */
enum class SessionListGroup(val label: String) {
    AWAITING_APPROVAL("等待批准"),
    RUNNING("正在运行"),
    STOPPED("已停止"),
}

/** Maps a §7.1 bridge session status onto its §12.1 list group. */
fun sessionListGroupOf(status: String): SessionListGroup = when (status) {
    "waiting_permission" -> SessionListGroup.AWAITING_APPROVAL
    "starting", "idle", "running", "interrupting" -> SessionListGroup.RUNNING
    else -> SessionListGroup.STOPPED
}

data class SessionRowUi(
    val sessionId: String,
    val projectName: String,
    val title: String,
    val model: String,
    val status: String,
    val lastActivity: String,
)

data class SessionGroupUi(val group: SessionListGroup, val rows: List<SessionRowUi>)

data class SessionListUiState(val groups: List<SessionGroupUi>)

@Composable
fun SessionListScreen(
    state: SessionListUiState,
    projects: List<BridgeProject>,
    onFetchProjects: () -> Unit,
    onOpenSession: (String) -> Unit,
    onNewSession: (projectId: String, displayName: String?) -> Unit,
    onScanImports: () -> Unit,
) {
    var showNewSessionDialog by remember { mutableStateOf(false) }
    // §7.2 step 1: the picker lists what the bridge authorizes, refreshed
    // every time the dialog opens (never derived from local sessions — a
    // fresh install has none yet).
    LaunchedEffect(showNewSessionDialog) {
        if (showNewSessionDialog) onFetchProjects()
    }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("会话", style = MaterialTheme.typography.headlineMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PrimaryButton(
                onClick = { showNewSessionDialog = true },
                modifier = Modifier.weight(1f),
            ) {
                Icon(Icons.Default.Add, contentDescription = null)
                Spacer(Modifier.padding(4.dp))
                Text("新建会话")
            }
            SecondaryButton(
                onClick = onScanImports,
                modifier = Modifier.weight(1f),
            ) {
                Icon(Icons.Default.Search, contentDescription = null)
                Spacer(Modifier.padding(4.dp))
                Text("扫描旧会话")
            }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            state.groups.forEach { group ->
                item(key = "group-${group.group.name}") {
                    Text(
                        text = group.group.label,
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                items(group.rows, key = { it.sessionId }) { row ->
                    SessionRow(row = row, onClick = { onOpenSession(row.sessionId) })
                }
            }
        }
    }
    if (showNewSessionDialog) {
        NewSessionDialog(
            projects = projects,
            onDismiss = { showNewSessionDialog = false },
            onCreate = { projectId, name ->
                showNewSessionDialog = false
                onNewSession(projectId, name)
            },
        )
    }
}

@Composable
private fun SessionRow(row: SessionRowUi, onClick: () -> Unit) {
    EnhancedCard(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = row.projectName,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = row.title,
                style = MaterialTheme.typography.titleMedium,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusBadge(
                    text = row.status,
                    color = statusColor(row.status),
                )
                Text(
                    text = row.model,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = row.lastActivity,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun statusColor(status: String) = when (sessionListGroupOf(status)) {
    SessionListGroup.AWAITING_APPROVAL -> AppColors.Warning
    SessionListGroup.RUNNING -> AppColors.Success
    SessionListGroup.STOPPED -> AppColors.TextTertiary
}

/**
 * §12.4 new-session dialog: only Bridge-authorized projects are selectable,
 * the display name is optional, and there are NO model / permission-mode /
 * free-path inputs (model follows the Mac default, permission mode is fixed
 * to `default`).
 */
@Composable
private fun NewSessionDialog(
    projects: List<BridgeProject>,
    onDismiss: () -> Unit,
    onCreate: (projectId: String, displayName: String?) -> Unit,
) {
    var selectedProject by remember { mutableStateOf<BridgeProject?>(null) }
    // The dialog opens before project.list resolves; auto-select the first
    // entry once it arrives (without clobbering an explicit user choice).
    LaunchedEffect(projects) {
        if (selectedProject == null) selectedProject = projects.firstOrNull()
    }
    var displayName by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建会话") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("项目（仅限 Bridge 授权项目）", style = MaterialTheme.typography.labelMedium)
                if (projects.isEmpty()) {
                    Text(
                        "Bridge 上还没有已授权项目；请在 Mac 上执行 admin authorize-project 后重试",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                projects.forEach { project ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.RadioButton(
                            selected = selectedProject?.projectId == project.projectId,
                            onClick = { selectedProject = project },
                        )
                        Text(project.displayName, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                OutlinedTextField(
                    value = displayName,
                    onValueChange = { displayName = it },
                    label = { Text("会话名称（可选）") },
                    singleLine = true,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(selectedProject?.projectId ?: return@TextButton, displayName.ifBlank { null }) },
                enabled = selectedProject != null,
            ) {
                Text("创建")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}
