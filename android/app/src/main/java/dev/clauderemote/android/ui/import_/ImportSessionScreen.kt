package dev.clauderemote.android.ui.import_

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.clauderemote.android.ui.ImportCandidateState
import dev.clauderemote.android.ui.ImportCandidateUi
import dev.clauderemote.android.ui.ImportUiState

/**
 * §12.4 import flow — first pick one of the Bridge-authorized projects, then
 * the scan lists that project's candidate sessions. Corrupted records,
 * moved projects, and duplicates each carry an explicit state; only clean
 * candidates offer an import action.
 */
@Composable
fun ImportSessionScreen(
    state: ImportUiState,
    onPickProject: (String) -> Unit,
    onScan: () -> Unit,
    onConfirmImport: (String) -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onBack) { Text("返回") }
            Text("导入会话", style = MaterialTheme.typography.headlineSmall)
        }

        Text("选择授权项目", style = MaterialTheme.typography.titleMedium)
        state.projects.forEach { project ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                RadioButton(
                    selected = state.projectId == project,
                    onClick = { onPickProject(project) },
                )
                Text(project, style = MaterialTheme.typography.bodyMedium)
            }
        }

        Button(onClick = onScan, enabled = state.projectId != null && !state.scanning) {
            Text(if (state.scanning) "扫描中…" else "扫描旧会话")
        }

        if (state.scanning) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.padding(4.dp), strokeWidth = 2.dp)
                Spacer(Modifier.padding(4.dp))
                Text("正在扫描 ${state.projectId ?: ""}…", style = MaterialTheme.typography.bodySmall)
            }
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.candidates, key = { it.sessionId }) { candidate ->
                ImportCandidateRow(
                    candidate = candidate,
                    onConfirmImport = { onConfirmImport(candidate.sessionId) },
                )
            }
        }
    }
}

@Composable
private fun ImportCandidateRow(candidate: ImportCandidateUi, onConfirmImport: () -> Unit) {
    val (stateLabel, stateColor) = when (candidate.state) {
        ImportCandidateState.IMPORTABLE -> "可导入" to MaterialTheme.colorScheme.primary
        ImportCandidateState.CORRUPTED -> "记录损坏" to MaterialTheme.colorScheme.error
        ImportCandidateState.PROJECT_MOVED -> "项目已移动" to MaterialTheme.colorScheme.error
        ImportCandidateState.DUPLICATE -> "重复记录（已存在）" to MaterialTheme.colorScheme.tertiary
    }
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(candidate.title, style = MaterialTheme.typography.bodyLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stateLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = stateColor,
                )
                candidate.lastActivity?.let { activity ->
                    Text(
                        text = activity,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.weight(1f))
                if (candidate.state == ImportCandidateState.IMPORTABLE) {
                    OutlinedButton(onClick = onConfirmImport) { Text("导入") }
                }
            }
        }
    }
}
