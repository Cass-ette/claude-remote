package dev.clauderemote.android.ui.connection

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.clauderemote.android.network.ConnectionState
import dev.clauderemote.android.ui.ExpiryWarning

/**
 * §12.5 connection screen — the app's front door. Shows the Cloudflare OAuth
 * login state and re-login entry, the scan-to-pair entry, the tunnel/bridge
 * state, all four versions (app, bridge, protocol, Claude Code), the current
 * device identity, the Access/device-session expiry warning, and the re-pair
 * instructions. Dark-first Material 3 per §12.5.
 */
data class ConnectionUiState(
    val signedInAs: String?,
    val paired: Boolean,
    val deviceIdentity: String,
    val connectionState: ConnectionState,
    val appVersion: String,
    val bridgeVersion: String?,
    val protocolVersion: String,
    val claudeCodeVersion: String?,
    val expiryWarning: ExpiryWarning?,
)

@Composable
fun ConnectionScreen(
    state: ConnectionUiState,
    onReLogin: () -> Unit,
    onScanPair: () -> Unit,
    onOpenSessions: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("连接", style = MaterialTheme.typography.headlineSmall)

        Section("Cloudflare 登录") {
            Text(
                text = state.signedInAs?.let { "已登录：$it" } ?: "未登录",
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(onClick = onReLogin) { Text("重新登录") }
        }

        Section("配对") {
            Text(
                text = if (state.paired) "设备已配对" else "设备未配对",
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = "设备身份：${state.deviceIdentity}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
            )
            OutlinedButton(onClick = onScanPair) { Text("扫码配对") }
            Text(
                text = "重新配对说明：在 Mac 侧生成配对二维码后扫描；撤销旧设备请在 Bridge 管理页操作。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Section("Tunnel 与 Bridge") {
            Text(
                text = when (state.connectionState) {
                    ConnectionState.CONNECTED -> "已连接"
                    ConnectionState.CONNECTING -> "连接中…"
                    ConnectionState.DISCONNECTED -> "未连接"
                    ConnectionState.STOPPED -> "已停止"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = if (state.connectionState == ConnectionState.CONNECTED) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }

        state.expiryWarning?.let { warning ->
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.errorContainer,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = when (warning.kind) {
                        ExpiryWarning.Kind.ACCESS_TOKEN ->
                            "Access 令牌即将过期（剩余 ${warning.remainingMs / 60_000} 分钟），请刷新"
                        ExpiryWarning.Kind.DEVICE_SESSION ->
                            "设备会话即将过期（剩余 ${warning.remainingMs / 60_000} 分钟），将自动续期"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.padding(12.dp),
                )
            }
        }

        Section("版本") {
            VersionRow("App", state.appVersion)
            VersionRow("Bridge", state.bridgeVersion ?: "未知")
            VersionRow("协议", state.protocolVersion)
            VersionRow("Claude Code", state.claudeCodeVersion ?: "未知")
        }

        Button(
            onClick = onOpenSessions,
            enabled = state.connectionState == ConnectionState.CONNECTED,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("进入会话列表")
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        content()
    }
}

@Composable
private fun VersionRow(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(0.dp))
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
