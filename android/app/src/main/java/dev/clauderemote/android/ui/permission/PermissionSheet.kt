package dev.clauderemote.android.ui.permission

import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.clauderemote.android.ui.PendingPermissionUi
import kotlinx.coroutines.delay

/**
 * §12.3 permission bottom sheet — deliberately hard to mis-tap:
 *
 * - the Allow and Deny actions are separated by [PermissionSheetDefaults.ButtonSpacing]
 *   (far beyond a thumb-slip radius);
 * - initial focus lands on the TITLE, never on Allow — keyboard/DPAD users
 *   must move focus deliberately before confirming;
 * - the sheet is fail-closed: dismissal resolves as DENY, countdown expiry
 *   disables both buttons (the bridge resolves expiry itself), and the
 *   caller-provided state carries no preselected decision;
 * - command-execution and file-change categories get the prominent
 *   (error-container) styling; no risk score is ever shown because the
 *   protocol defines none.
 */
object PermissionSheetDefaults {
    /** Minimum gap between the Deny and Allow buttons (§12.3 足够间距). */
    val ButtonSpacing = 48.dp

    const val TITLE_TAG = "permission_title"
    const val ALLOW_TAG = "permission_allow"
    const val DENY_TAG = "permission_deny"

    /** §12.3 categories rendered with the prominent style. */
    val PROMINENT_CATEGORIES = setOf("command_execution", "file_change")
}

/** Renders [dev.clauderemote.android.ui.PendingPermissionUi] in the sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PermissionSheet(
    pending: PendingPermissionUi,
    onAllow: (String) -> Unit,
    onDeny: (String) -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = { onDeny(pending.permissionRequestId) },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        PermissionSheetContent(
            state = pending.toSheetState(),
            onAllow = onAllow,
            onDeny = onDeny,
        )
    }
}

/**
 * The sheet body, public so the instrumented test drives it deterministically.
 */
@Composable
fun PermissionSheetContent(
    state: PermissionSheetUiState,
    onAllow: (String) -> Unit,
    onDeny: (String) -> Unit,
) {
    val titleFocus = remember { FocusRequester() }
    // The countdown state lives in THIS scope (not inside [CountdownLabel]):
    // `expired` and both button `enabled` states derive from it, so the
    // zero-crossing recomposes the whole body. When the ticker state was
    // owned by the label, only the label recomposed at zero — the buttons
    // stayed enabled and the label stuck on a stale count.
    val remainingMs by rememberRemainingMs(state.expiresAtMs)
    val expired = state.expiresAtMs != null && remainingMs <= 0

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 16.dp),
    ) {
        Text(
            text = "权限请求",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier
                .testTag(PermissionSheetDefaults.TITLE_TAG)
                .focusRequester(titleFocus)
                .focusable(),
        )
        Spacer(Modifier.height(12.dp))
        PermissionDetail(state)
        Spacer(Modifier.height(12.dp))
        CountdownLabel(state, remainingMs, expired)
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(0.dp)) {
            // Deny is the primary (filled) action: fail-closed ordering, and
            // the two actions are kept [PermissionSheetDefaults.ButtonSpacing]
            // apart so a mis-tap cannot hit the opposite decision.
            Button(
                onClick = { onDeny(state.permissionRequestId) },
                enabled = !expired,
                modifier = Modifier
                    .weight(1f)
                    .testTag(PermissionSheetDefaults.DENY_TAG),
            ) {
                Text("拒绝")
            }
            Spacer(Modifier.width(PermissionSheetDefaults.ButtonSpacing))
            FilledTonalButton(
                onClick = { onAllow(state.permissionRequestId) },
                enabled = !expired,
                modifier = Modifier
                    .weight(1f)
                    .testTag(PermissionSheetDefaults.ALLOW_TAG),
            ) {
                Text("允许")
            }
        }
        Spacer(Modifier.height(24.dp))
    }

    // Initial focus goes to the title — never to Allow (§12.3).
    LaunchedEffect(state.permissionRequestId) {
        runCatching { titleFocus.requestFocus() }
    }
}

/** Tool name, extractable command/path, and the full raw parameters (§12.3). */
@Composable
private fun PermissionDetail(state: PermissionSheetUiState) {
    val prominent = state.displayCategory in PermissionSheetDefaults.PROMINENT_CATEGORIES
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = if (prominent) {
            MaterialTheme.colorScheme.errorContainer
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(
                text = state.toolName ?: "未知工具",
                style = MaterialTheme.typography.titleMedium,
                color = if (prominent) {
                    MaterialTheme.colorScheme.onErrorContainer
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            state.commandOrPath?.let { command ->
                Spacer(Modifier.height(4.dp))
                Text(
                    text = command,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
            state.rawParamsJson?.let { raw ->
                Spacer(Modifier.height(4.dp))
                Text(
                    text = raw,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 4,
                )
            }
        }
    }
}

/**
 * Countdown state hoisted to the caller's scope (§12.3 fail-closed expiry):
 * ticks once per second until the wall-clock expiry crosses, then stops.
 * Returns Long.MAX_VALUE when no expiry is advertised (never expires).
 */
@Composable
private fun rememberRemainingMs(expiresAtMs: Long?): State<Long> {
    val remaining = remember(expiresAtMs) { mutableLongStateOf(expiresAtMs?.let { it - System.currentTimeMillis() } ?: Long.MAX_VALUE) }
    LaunchedEffect(expiresAtMs) {
        val expiry = expiresAtMs ?: return@LaunchedEffect
        while (true) {
            val left = expiry - System.currentTimeMillis()
            remaining.longValue = left
            if (left <= 0) break
            delay(1_000)
        }
    }
    return remaining
}

/** §12.3 countdown; when it hits zero the sheet is disabled (fail-closed). */
@Composable
private fun CountdownLabel(state: PermissionSheetUiState, remainingMs: Long, expired: Boolean) {
    if (state.expiresAtMs == null) return
    Text(
        text = if (expired) {
            "已过期：请求将按拒绝处理"
        } else {
            "剩余 ${(remainingMs / 1000 + 1)} 秒"
        },
        style = MaterialTheme.typography.labelMedium,
        color = if (expired) {
            MaterialTheme.colorScheme.error
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
    )
}

/** Compose-facing sheet state (mapped from the ViewModel's PendingPermissionUi). */
data class PermissionSheetUiState(
    val permissionRequestId: String,
    val toolName: String?,
    val displayCategory: String?,
    val commandOrPath: String?,
    val rawParamsJson: String?,
    val expiresAtMs: Long?,
)

internal fun PendingPermissionUi.toSheetState(): PermissionSheetUiState = PermissionSheetUiState(
    permissionRequestId = permissionRequestId,
    toolName = toolName,
    displayCategory = displayCategory,
    commandOrPath = commandOrPath,
    rawParamsJson = rawParamsJson,
    expiresAtMs = expiresAtMs,
)
