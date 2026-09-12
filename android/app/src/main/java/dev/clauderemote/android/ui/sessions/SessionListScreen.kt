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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

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
    onOpenSession: (String) -> Unit,
    onNewSession: (projectId: String, displayName: String?) -> Unit,
    onScanImports: () -> Unit,
) {
    var showNewSessionDialog by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("会话", style = MaterialTheme.typography.headlineSmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { showNewSessionDialog = true }) { Text("新建会话") }
            OutlinedButton(onClick = onScanImports) { Text("扫描旧会话") }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
            projects = state.projectsOf(),
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
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
        onClick = onClick,
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(row.projectName, style = MaterialTheme.typography.labelSmall)
            Text(row.title, style = MaterialTheme.typography.bodyLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "模型：${row.model}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = "状态：${row.status}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
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

/**
 * §12.4 new-session dialog: only Bridge-authorized projects are selectable,
 * the display name is optional, and there are NO model / permission-mode /
 * free-path inputs (model follows the Mac default, permission mode is fixed
 * to `default`).
 */
@Composable
private fun NewSessionDialog(
    projects: List<String>,
    onDismiss: () -> Unit,
    onCreate: (projectId: String, displayName: String?) -> Unit,
) {
    var selectedProject by remember { mutableStateOf(projects.firstOrNull()) }
    var displayName by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建会话") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("项目（仅限 Bridge 授权项目）", style = MaterialTheme.typography.labelMedium)
                projects.forEach { project ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.RadioButton(
                            selected = selectedProject == project,
                            onClick = { selectedProject = project },
                        )
                        Text(project, style = MaterialTheme.typography.bodyMedium)
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
                onClick = { onCreate(selectedProject ?: return@TextButton, displayName.ifBlank { null }) },
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

/** The union of projects across groups (the new-session project picker source). */
private fun SessionListUiState.projectsOf(): List<String> =
    groups.flatMap { it.rows.map { row -> row.projectName } }.distinct()
