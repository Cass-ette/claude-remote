package dev.clauderemote.android.ui.permission

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.clauderemote.android.ui.PendingPermissionUi
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented Compose UI test for the §12.3 fail-closed permission defaults:
 *
 * - the Allow button must NOT receive initial focus (the title does), so a
 *   keyboard/DPAD confirm can never accidentally grant a permission;
 * - the Allow and Deny buttons keep at least the configured minimum spacing
 *   ([PermissionSheetDefaults.ButtonSpacing]) so a mis-tap cannot land on
 *   the opposite decision.
 *
 * The countdown is driven with a null expiry in these tests so no ticker
 * recomposition interferes with focus/position assertions.
 */
@RunWith(AndroidJUnit4::class)
class PermissionSheetUiTest {

    @get:Rule
    val composeRule = createComposeRule()

    private fun renderSheet() {
        composeRule.setContent {
            MaterialTheme {
                PermissionSheet(
                    pending = PendingPermissionUi(
                        permissionRequestId = "perm-test-1",
                        toolName = "Bash",
                        displayCategory = "command_execution",
                        commandOrPath = "rm -rf /tmp/probe",
                        rawParamsJson = """{"command":"rm -rf /tmp/probe"}""",
                        expiresAtMs = null,
                        defaultDecision = null,
                    ),
                    onAllow = {},
                    onDeny = {},
                )
            }
        }
        composeRule.waitForIdle()
    }

    @Test
    fun allowButtonDoesNotReceiveInitialFocus() {
        renderSheet()

        composeRule.onNodeWithTag(PermissionSheetDefaults.ALLOW_TAG).assertIsNotFocused()
        composeRule.onNodeWithTag(PermissionSheetDefaults.DENY_TAG).assertIsNotFocused()
        // Focus lands on the neutral title, never on the Allow action.
        composeRule.onNodeWithTag(PermissionSheetDefaults.TITLE_TAG).assertIsFocused()
    }

    @Test
    fun allowAndDenyButtonsKeepMinimumSpacing() {
        renderSheet()

        val allow = composeRule.onNodeWithTag(PermissionSheetDefaults.ALLOW_TAG).fetchSemanticsNode()
        val deny = composeRule.onNodeWithTag(PermissionSheetDefaults.DENY_TAG).fetchSemanticsNode()
        val minGapPx = with(composeRule.density) {
            PermissionSheetDefaults.ButtonSpacing.toPx()
        }
        // Layout is Deny (left) — spacing — Allow (right); the horizontal gap
        // between the two bounds must be at least the configured minimum.
        val gapPx = allow.positionInRoot.x - (deny.positionInRoot.x + deny.size.width)
        assertTrue(
            "Allow/Deny gap ${gapPx}px must be >= ${minGapPx}px (${PermissionSheetDefaults.ButtonSpacing})",
            gapPx >= minGapPx - 1f,
        )
    }
}
