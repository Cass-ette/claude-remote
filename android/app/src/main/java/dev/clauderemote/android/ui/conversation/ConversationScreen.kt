package dev.clauderemote.android.ui.conversation

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import dev.clauderemote.android.data.local.SessionEntity
import dev.clauderemote.android.ui.ConversationBanner
import dev.clauderemote.android.ui.ConversationItem
import dev.clauderemote.android.ui.ConversationUiState
import dev.clauderemote.android.ui.ExpiryWarning
import dev.clauderemote.android.ui.MessageAction
import dev.clauderemote.android.ui.MessageBadge
import dev.clauderemote.android.ui.permission.PermissionSheet
import dev.clauderemote.android.ui.theme.AppColors
import dev.clauderemote.android.ui.theme.PrimaryButton
import dev.clauderemote.android.ui.theme.SecondaryButton

/**
 * §12.2 conversation screen — a thin Compose collector over the
 * framework-independent ViewModel state. Rendering contract:
 *
 * - top: bridge/auth status, project, read-only model, session status;
 * - messages: user rows carry the command status badge joined off requestId;
 *   `indeterminate` rows offer Safe Retry; `interrupted` rows offer Resume
 *   and send-continue; Claude replies stream; tool calls render as
 *   collapsible cards with truncation markers;
 * - banners: error/interrupted/resync/upgrade/re-auth states (§11.1);
 * - bottom: input + Send + Stop; Send is enabled only while the session is
 *   idle so non-terminal commands always show the server's real state
 *   instead of inviting a duplicate submit.
 */
@Composable
fun ConversationScreen(
    state: ConversationUiState,
    expiryWarning: ExpiryWarning?,
    connectionLabel: String,
    modelName: String,
    onSendMessage: (String) -> Unit,
    onSafeRetry: (String) -> Unit,
    onResume: () -> Unit,
    onSendContinue: () -> Unit,
    onStop: () -> Unit,
    onRelease: () -> Unit,
    onAllowPermission: (String) -> Unit,
    onDenyPermission: (String) -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background
        ) {
            Column(modifier = Modifier.fillMaxSize().imePadding()) {
            ConversationHeader(
                session = state.session,
                expiryWarning = expiryWarning,
                connectionLabel = connectionLabel,
                modelName = modelName,
            )
            state.banner?.let { banner -> BannerRow(banner) }
            MessageList(
                state = state,
                modifier = Modifier.weight(1f),
                onSafeRetry = onSafeRetry,
                onResume = onResume,
                onSendContinue = onSendContinue,
            )
            InputBar(
                sendEnabled = state.sendEnabled,
                releaseEnabled = state.releaseEnabled,
                onSendMessage = onSendMessage,
                onStop = onStop,
                onRelease = onRelease,
            )
        }
        }
        // §12.3: the pending permission takes over as a modal bottom sheet.
        state.pendingPermission?.let { pending ->
            PermissionSheet(
                pending = pending,
                onAllow = onAllowPermission,
                onDeny = onDenyPermission,
            )
        }
    }
}

@Composable
private fun ConversationHeader(
    session: SessionEntity?,
    expiryWarning: ExpiryWarning?,
    connectionLabel: String,
    modelName: String,
) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(text = connectionLabel, style = MaterialTheme.typography.labelMedium)
                Text(
                    text = session?.projectId ?: "",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = modelName,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = "状态：${session?.status ?: "未知"}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            expiryWarning?.let { warning ->
                Text(
                    text = when (warning.kind) {
                        ExpiryWarning.Kind.ACCESS_TOKEN -> "Access 令牌即将过期（${warning.remainingMs / 60_000} 分钟）"
                        ExpiryWarning.Kind.DEVICE_SESSION -> "设备会话即将过期（${warning.remainingMs / 60_000} 分钟）"
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun BannerRow(banner: ConversationBanner) {
    val label = when (banner) {
        ConversationBanner.RESYNC_REQUIRED -> "本地状态需要重新同步，正在等待快照恢复…"
        ConversationBanner.RE_AUTHENTICATION_REQUIRED -> "需要重新登录或重新配对"
        ConversationBanner.UPGRADE_REQUIRED -> "协议版本不兼容，请升级应用"
        ConversationBanner.SESSION_CONFLICT -> "命令与服务端冲突，未自动重试"
    }
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onErrorContainer,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun MessageList(
    state: ConversationUiState,
    modifier: Modifier,
    onSafeRetry: (String) -> Unit,
    onResume: () -> Unit,
    onSendContinue: () -> Unit,
) {
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(
            horizontal = 16.dp,
            vertical = 8.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(state.items, key = { it.id }) { item ->
            when (item) {
                is ConversationItem.Text -> MessageRow(
                    item = item,
                    onSafeRetry = onSafeRetry,
                    onResume = onResume,
                    onSendContinue = onSendContinue,
                )
                is ConversationItem.ToolCall -> ToolCard(item)
            }
        }
        if (state.streaming) {
            item(key = "streaming-indicator") { StreamingIndicator() }
        }
    }
}

@Composable
private fun MessageRow(
    item: ConversationItem.Text,
    onSafeRetry: (String) -> Unit,
    onResume: () -> Unit,
    onSendContinue: () -> Unit,
) {
    val fromUser = item.role == "user"
    val elevation by animateDpAsState(
        targetValue = if (item.streaming) 4.dp else 2.dp,
        animationSpec = spring(
            dampingRatio = Spring.DampingRatioMediumBouncy,
            stiffness = Spring.StiffnessLow,
        ),
        label = "message-elevation"
    )

    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        horizontalAlignment = if (fromUser) Alignment.End else Alignment.Start,
    ) {
        Card(
            modifier = Modifier
                .widthIn(max = 320.dp)
                .shadow(
                    elevation = elevation,
                    shape = RoundedCornerShape(
                        topStart = 16.dp,
                        topEnd = 16.dp,
                        bottomStart = if (fromUser) 16.dp else 4.dp,
                        bottomEnd = if (fromUser) 4.dp else 16.dp,
                    ),
                ),
            shape = RoundedCornerShape(
                topStart = 16.dp,
                topEnd = 16.dp,
                bottomStart = if (fromUser) 16.dp else 4.dp,
                bottomEnd = if (fromUser) 4.dp else 16.dp,
            ),
            colors = CardDefaults.cardColors(
                containerColor = when {
                    fromUser -> AppColors.Primary.copy(alpha = 0.15f)
                    item.role == "system" -> AppColors.SurfaceElevated
                    else -> AppColors.Surface
                },
            ),
        ) {
            Column(Modifier.padding(12.dp)) {
                Text(
                    text = item.text.ifBlank { "（无内容）" },
                    style = MaterialTheme.typography.bodyMedium,
                    color = when {
                        fromUser -> AppColors.Primary
                        else -> AppColors.TextPrimary
                    },
                )
                if (item.streaming) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(
                            modifier = Modifier.width(12.dp).height(12.dp),
                            strokeWidth = 1.5.dp,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text("生成中…", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
        item.badge?.let { badge -> BadgeChip(badge) }
        if (item.actions.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val retryTarget = item.requestId
                if (MessageAction.SAFE_RETRY in item.actions && retryTarget != null) {
                    SecondaryButton(onClick = { onSafeRetry(retryTarget) }) { Text("安全重试") }
                }
                if (MessageAction.RESUME in item.actions) {
                    SecondaryButton(onClick = onResume) { Text("恢复会话") }
                }
                if (MessageAction.SEND_CONTINUE in item.actions) {
                    SecondaryButton(onClick = onSendContinue) { Text("发送「继续」") }
                }
            }
        }
    }
}

@Composable
private fun BadgeChip(badge: MessageBadge) {
    val (container, content) = when (badge) {
        MessageBadge.COMPLETED -> MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.onPrimaryContainer
        MessageBadge.FAILED, MessageBadge.INTERRUPTED -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        MessageBadge.INDETERMINATE -> MaterialTheme.colorScheme.tertiaryContainer to MaterialTheme.colorScheme.onTertiaryContainer
        else -> MaterialTheme.colorScheme.secondaryContainer to MaterialTheme.colorScheme.onSecondaryContainer
    }
    Surface(shape = RoundedCornerShape(8.dp), color = container) {
        Text(
            text = badge.wire,
            style = MaterialTheme.typography.labelSmall,
            color = content,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/** §12.2 collapsible tool call card with a truncation marker on the output. */
@Composable
private fun ToolCard(item: ConversationItem.ToolCall) {
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(10.dp)) {
            TextButton(onClick = { expanded = !expanded }) {
                Text(
                    text = (if (expanded) "▼ " else "▶ ") + item.toolName + " · " + item.status,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            if (expanded) {
                if (item.preview.isNotBlank()) {
                    Text(
                        text = item.preview,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 3,
                    )
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    text = item.output.ifBlank { "（暂无输出）" } + if (item.truncated) "\n…（输出已截断）" else "",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}

@Composable
private fun StreamingIndicator() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(modifier = Modifier.width(14.dp).height(14.dp), strokeWidth = 1.dp)
        Spacer(Modifier.width(8.dp))
        Text("Claude 正在生成…", style = MaterialTheme.typography.labelMedium)
    }
}

/** §12.2 bottom bar: input + Send + Stop, with the Release affordance. */
@Composable
private fun InputBar(
    sendEnabled: Boolean,
    releaseEnabled: Boolean,
    onSendMessage: (String) -> Unit,
    onStop: () -> Unit,
    onRelease: () -> Unit,
) {
    var input by remember { mutableStateOf("") }
    val send: () -> Unit = {
        if (sendEnabled && input.isNotBlank()) {
            onSendMessage(input)
            input = ""
        }
    }
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            // Send lives in the same row as the input so it stays reachable
            // while the IME is open (the IME's enter key also sends).
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text(if (sendEnabled) "输入消息…" else "会话运行中，停止后才能发送") },
                    enabled = sendEnabled,
                    maxLines = 4,
                    shape = MaterialTheme.shapes.large,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { send() }),
                )
                PrimaryButton(
                    onClick = send,
                    enabled = sendEnabled && input.isNotBlank(),
                    modifier = Modifier.height(56.dp),
                ) {
                    Text("发送")
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                SecondaryButton(onClick = onStop, enabled = !sendEnabled) {
                    Text("停止")
                }
                Spacer(Modifier.weight(1f))
                // §7.5: Release is a distinct action, only offered from
                // idle/interrupted (the ViewModel double-gates the send).
                TextButton(onClick = onRelease, enabled = releaseEnabled) {
                    Text("释放会话")
                }
            }
        }
    }
}
