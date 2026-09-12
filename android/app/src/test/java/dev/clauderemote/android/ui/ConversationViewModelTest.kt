package dev.clauderemote.android.ui

import dev.clauderemote.android.data.local.CommandEventEntity
import dev.clauderemote.android.data.local.MessageEntity
import dev.clauderemote.android.data.local.SessionEntity
import dev.clauderemote.android.network.CoordinatorSignal
import dev.clauderemote.android.protocol.v1.CommandRetryIndeterminateCommand
import dev.clauderemote.android.protocol.v1.CommandType
import dev.clauderemote.android.protocol.v1.MessageSendCommand
import dev.clauderemote.android.protocol.v1.PermissionDecision
import dev.clauderemote.android.protocol.v1.PermissionResolveCommand
import dev.clauderemote.android.protocol.v1.ProtocolCommand
import dev.clauderemote.android.protocol.v1.SessionImportCommand
import dev.clauderemote.android.protocol.v1.SessionReleaseCommand
import dev.clauderemote.android.protocol.v1.SessionResumeCommand
import dev.clauderemote.android.protocol.v1.SessionScanImportsCommand
import dev.clauderemote.android.protocol.v1.SessionStopCommand
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the conversation ViewModel (spec §12.2, §12.3, §12.5).
 *
 * The ViewModel is pure Kotlin — no Android framework types — so the whole
 * suite drives it through in-memory fakes of the repository, command sender,
 * and token-expiry seams:
 *
 * 1. message rows render the §8.3/§8.4 command status badge by joining
 *    MessageEntity.requestId ↔ CommandEventEntity.status (all seven states);
 * 2. `indeterminate` rows expose exactly one Safe Retry action; `interrupted`
 *    rows expose Resume + send-continue;
 * 3. Send is enabled iff the session is `idle` (§7.1: only idle accepts
 *    new user messages);
 * 4. the permission state is fail-closed (no preselected decision);
 * 5. Stop and Release are distinct commands, and Release only fires from
 *    `idle`/`interrupted` (§7.5);
 * 6. the refresh-expiry warning appears when the Access token or the device
 *    session has < 5 minutes left;
 * 7. coordinator §8.1 signals surface as conversation banners;
 * 8. import scan/confirm construct the §8.2 payloads.
 */
class ConversationViewModelTest {

    private val t0: Instant = Instant.parse("2026-01-01T00:00:00Z")
    private var nowMs: Long = 1_700_000_000_000L

    // -------------------------------------------------------------------
    // 1. Status badges keyed by requestId
    // -------------------------------------------------------------------

    @Test
    fun messagesRenderWithCommandStatusBadges_keyedByRequestId() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_IDLE)
        val statuses = listOf(
            "accepted", "dispatching", "dispatched", "indeterminate", "interrupted", "completed", "failed",
        )
        statuses.forEachIndexed { i, status ->
            repo.messages += userMessage("m$i", requestId = "r$i", position = i.toLong())
            repo.commands += commandEvent("r$i", status)
        }
        // A row without a requestId and one whose requestId has no command
        // row must render badge-free rather than guessing (§12.2: show the
        // server's real state, never an invented one).
        repo.messages += userMessage("m-plain", requestId = null, position = 7)
        repo.messages += userMessage("m-orphan", requestId = "r-unknown", position = 8)

        val vm = conversationViewModel(repo)

        val items = vm.uiState.value.items
        assertEquals(statuses.size + 2, items.size)
        statuses.forEachIndexed { i, status ->
            val badge = (items[i] as ConversationItem.Text).badge
            assertNotNull("message $i should carry a badge", badge)
            assertEquals(status, badge!!.wire)
        }
        assertNull((items[7] as ConversationItem.Text).badge)
        assertNull((items[8] as ConversationItem.Text).badge)
    }

    @Test
    fun failedBadgeSurfacesOnMessageRow_notOnlyOnCommandEvent() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_IDLE)
        repo.messages += userMessage("m1", requestId = "r1", position = 0)
        repo.commands += commandEvent("r1", "failed")

        val vm = conversationViewModel(repo)

        val item = vm.uiState.value.items.single() as ConversationItem.Text
        assertEquals(MessageBadge.FAILED, item.badge)
    }

    // -------------------------------------------------------------------
    // 2. Safe retry / resume / send-continue actions
    // -------------------------------------------------------------------

    @Test
    fun indeterminateMessageExposesSingleSafeRetryAction() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_IDLE)
        repo.messages += userMessage("m1", requestId = "r-ind", position = 0)
        repo.commands += commandEvent("r-ind", "indeterminate")

        val vm = conversationViewModel(repo)

        val item = vm.uiState.value.items.single() as ConversationItem.Text
        assertEquals(listOf(MessageAction.SAFE_RETRY), item.actions)
    }

    @Test
    fun interruptedMessageExposesResumeAndSendContinueActions() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_INTERRUPTED)
        repo.messages += userMessage("m1", requestId = "r-int", position = 0)
        repo.commands += commandEvent("r-int", "interrupted")

        val vm = conversationViewModel(repo)

        val item = vm.uiState.value.items.single() as ConversationItem.Text
        assertEquals(setOf(MessageAction.RESUME, MessageAction.SEND_CONTINUE), item.actions.toSet())
    }

    @Test
    fun safeRetrySendsCommandRetryIndeterminate_forTheCorrelatedRequest() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_IDLE)
        repo.messages += userMessage("m1", requestId = "r-ind", position = 0)
        repo.commands += commandEvent("r-ind", "indeterminate")
        val sender = RecordingCommandSender()

        val vm = conversationViewModel(repo, sender)
        vm.safeRetry("r-ind")

        val command = sender.sent.filterIsInstance<CommandRetryIndeterminateCommand>().single()
        assertEquals("r-ind", command.payload.requestId)
    }

    @Test
    fun resumeSendsSessionResumeCommand() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_INTERRUPTED)
        val sender = RecordingCommandSender()

        val vm = conversationViewModel(repo, sender)
        vm.resume()

        val command = sender.sent.filterIsInstance<SessionResumeCommand>().single()
        assertEquals(SESSION_ID, command.payload.sessionId)
    }

    // -------------------------------------------------------------------
    // 3. Send gating (§7.1/§12.2: only idle accepts new user messages)
    // -------------------------------------------------------------------

    @Test
    fun idleSessionEnablesSend_nonIdleDisables() {
        for (status in listOf(
            "inactive", "starting", "running", "waiting_permission", "interrupting", "releasing",
            "interrupted", "failed",
        )) {
            val repo = FakeConversationRepository()
            repo.session = session(status)
            val vm = conversationViewModel(repo)
            assertFalse("Send must be disabled while the session is $status", vm.uiState.value.sendEnabled)
        }
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_IDLE)
        assertTrue(conversationViewModel(repo).uiState.value.sendEnabled)
    }

    @Test
    fun sendMessageWritesOptimisticIntentAndSendsCommand_whenIdle() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_IDLE)
        repo.messages += userMessage("existing", requestId = "r-old", position = 0)
        val sender = RecordingCommandSender()

        val vm = conversationViewModel(repo, sender)
        vm.sendMessage("hello world")

        val command = sender.sent.filterIsInstance<MessageSendCommand>().single()
        assertEquals("hello world", command.payload.text)
        assertEquals(SESSION_ID, command.payload.sessionId)
        assertEquals(SESSION_ID, command.sessionId)

        // The optimistic §7.4 intent: the user row is projected immediately
        // with a dispatching badge and the requestId correlation in place.
        val item = vm.uiState.value.items.last() as ConversationItem.Text
        assertEquals("hello world", item.text)
        assertEquals(MessageBadge.DISPATCHING, item.badge)
        assertEquals(command.requestId, repo.commands.last().requestId)
        assertEquals(command.requestId, repo.messages.last().requestId)
    }

    @Test
    fun sendMessageIgnored_whenNotIdle() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_RUNNING)
        repo.messages += userMessage("existing", requestId = "r-old", position = 0)
        val sender = RecordingCommandSender()

        val vm = conversationViewModel(repo, sender)
        vm.sendMessage("should not go out")

        assertTrue(sender.sent.isEmpty())
        assertEquals(1, vm.uiState.value.items.size)
    }

    @Test
    fun sendContinueSendsAContinueMessage_whenIdle() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_IDLE)
        val sender = RecordingCommandSender()

        val vm = conversationViewModel(repo, sender)
        vm.sendContinue()

        val command = sender.sent.filterIsInstance<MessageSendCommand>().single()
        assertEquals(ConversationViewModel.CONTINUE_MESSAGE_TEXT, command.payload.text)
    }

    // -------------------------------------------------------------------
    // 4. Permission state is fail-closed (§12.3)
    // -------------------------------------------------------------------

    @Test
    fun pendingPermissionIsFailClosed_byDefault() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_WAITING_PERMISSION)
        repo.messages += permissionMessage("perm-1")

        val vm = conversationViewModel(repo)

        val pending = vm.uiState.value.pendingPermission
        assertNotNull(pending)
        assertEquals("perm-1", pending!!.permissionRequestId)
        // No preselected decision: the sheet must never default to Allow.
        assertNull(pending.defaultDecision)
    }

    @Test
    fun allowPermissionSendsAllowResolution_andResolvesLocally() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_WAITING_PERMISSION)
        repo.messages += permissionMessage("perm-1")
        val sender = RecordingCommandSender()

        val vm = conversationViewModel(repo, sender)
        vm.allowPermission("perm-1")

        val command = sender.sent.filterIsInstance<PermissionResolveCommand>().single()
        assertEquals(PermissionDecision.ALLOW, command.payload.decision)
        assertEquals("perm-1", command.payload.permissionRequestId)
        assertEquals(SESSION_ID, command.payload.sessionId)
        assertEquals(SESSION_ID, command.sessionId)
        assertNull(vm.uiState.value.pendingPermission)
    }

    @Test
    fun denyPermissionSendsDenyResolution() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_WAITING_PERMISSION)
        repo.messages += permissionMessage("perm-1")
        val sender = RecordingCommandSender()

        val vm = conversationViewModel(repo, sender)
        vm.denyPermission("perm-1")

        val command = sender.sent.filterIsInstance<PermissionResolveCommand>().single()
        assertEquals(PermissionDecision.DENY, command.payload.decision)
        assertNull(vm.uiState.value.pendingPermission)
    }

    // -------------------------------------------------------------------
    // 5. Stop vs Release (§7.5)
    // -------------------------------------------------------------------

    @Test
    fun stopAndReleaseAreDistinctCommands_releaseOnlyFromIdleOrInterrupted() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_RUNNING)
        val sender = RecordingCommandSender()
        val vm = conversationViewModel(repo, sender)

        // Running: Stop is valid, Release is not — neither the state exposure
        // nor a direct call may send a release (§7.5: release only in
        // idle/interrupted).
        assertFalse(vm.uiState.value.releaseEnabled)
        vm.stop()
        vm.release()
        val types = sender.sent.map { it.commandType }
        assertTrue(types.contains(CommandType.SESSION_STOP))
        assertFalse(types.contains(CommandType.SESSION_RELEASE))
        val stop = sender.sent.filterIsInstance<SessionStopCommand>().single()
        assertEquals(SESSION_ID, stop.payload.sessionId)

        // Interrupted: Release becomes available and sends the command.
        repo.session = session(SESSION_STATUS_INTERRUPTED)
        vm.refresh()
        assertTrue(vm.uiState.value.releaseEnabled)
        vm.release()
        val release = sender.sent.filterIsInstance<SessionReleaseCommand>().single()
        assertEquals(SESSION_ID, release.payload.sessionId)

        // Idle: Release also available.
        repo.session = session(SESSION_STATUS_IDLE)
        vm.refresh()
        assertTrue(vm.uiState.value.releaseEnabled)
    }

    // -------------------------------------------------------------------
    // 6. Refresh-expiry warning (§12.5)
    // -------------------------------------------------------------------

    @Test
    fun expiryWarningAppears_whenAccessTokenNearsExpiry() {
        val expiry = FakeTokenExpirySource()
        expiry.accessExpiresAtMs = nowMs + 3 * MINUTE_MS

        val vm = conversationViewModel(expirySource = expiry)

        val warning = vm.expiryWarning.value
        assertNotNull(warning)
        assertEquals(ExpiryWarning.Kind.ACCESS_TOKEN, warning!!.kind)
        assertEquals(3 * MINUTE_MS, warning.remainingMs)
    }

    @Test
    fun expiryWarningClears_whenAccessIsFarFromExpiry() {
        val expiry = FakeTokenExpirySource()
        expiry.accessExpiresAtMs = nowMs + 30 * MINUTE_MS

        val vm = conversationViewModel(expirySource = expiry)
        assertNull(vm.expiryWarning.value)
    }

    @Test
    fun expiryWarningAppears_whenDeviceSessionNearsExpiry() {
        val expiry = FakeTokenExpirySource()
        expiry.accessExpiresAtMs = nowMs + 30 * MINUTE_MS
        expiry.deviceExpiresAtMs = nowMs + 2 * MINUTE_MS

        val vm = conversationViewModel(expirySource = expiry)

        val warning = vm.expiryWarning.value
        assertNotNull(warning)
        assertEquals(ExpiryWarning.Kind.DEVICE_SESSION, warning!!.kind)
    }

    @Test
    fun expiryWarningRecomputedOnRefresh_withFakeClock() {
        val expiry = FakeTokenExpirySource()
        expiry.accessExpiresAtMs = nowMs + 30 * MINUTE_MS
        val vm = conversationViewModel(expirySource = expiry)
        assertNull(vm.expiryWarning.value)

        // Time passes without the token rotating: 28 minutes later the same
        // token is now inside the warning window and refresh() must show it.
        nowMs += 28 * MINUTE_MS
        vm.refresh()

        val warning = vm.expiryWarning.value
        assertNotNull(warning)
        assertEquals(ExpiryWarning.Kind.ACCESS_TOKEN, warning!!.kind)
        assertEquals(2 * MINUTE_MS, warning.remainingMs)
    }

    // -------------------------------------------------------------------
    // 7. Coordinator signals surface as banners (§11.1/§12.2)
    // -------------------------------------------------------------------

    @Test
    fun coordinatorSignalsSurfaceAsConversationBanners() {
        val vm = conversationViewModel()

        vm.onCoordinatorSignal(CoordinatorSignal.ResyncRequired)
        assertEquals(ConversationBanner.RESYNC_REQUIRED, vm.uiState.value.banner)

        vm.onCoordinatorSignal(CoordinatorSignal.ReAuthenticationRequired)
        assertEquals(ConversationBanner.RE_AUTHENTICATION_REQUIRED, vm.uiState.value.banner)

        vm.onCoordinatorSignal(CoordinatorSignal.UpgradeRequired)
        assertEquals(ConversationBanner.UPGRADE_REQUIRED, vm.uiState.value.banner)

        vm.onCoordinatorSignal(CoordinatorSignal.SessionConflict("boom"))
        assertEquals(ConversationBanner.SESSION_CONFLICT, vm.uiState.value.banner)
    }

    @Test
    fun bannerSurvivesRefresh_untilItsConditionClears() {
        val repo = FakeConversationRepository()
        repo.session = session(SESSION_STATUS_IDLE)
        val vm = conversationViewModel(repo)

        vm.onCoordinatorSignal(CoordinatorSignal.ResyncRequired)
        vm.refresh()
        assertEquals(ConversationBanner.RESYNC_REQUIRED, vm.uiState.value.banner)

        // Internal refresh paths (a send, a permission resolution) must not
        // drop the banner either.
        vm.sendMessage("still resyncing")
        assertEquals(ConversationBanner.RESYNC_REQUIRED, vm.uiState.value.banner)

        // The condition clearing is the ONLY thing that removes the banner.
        vm.clearBanner()
        assertNull(vm.uiState.value.banner)
        vm.refresh()
        assertNull(vm.uiState.value.banner)
    }

    // -------------------------------------------------------------------
    // 8. Import scan/confirm (§12.4)
    // -------------------------------------------------------------------

    @Test
    fun importScanSendsScanImportsCommand_andMarksScanning() {
        val sender = RecordingCommandSender()
        val vm = conversationViewModel(sender = sender)

        vm.importScan("proj-9")

        val command = sender.sent.filterIsInstance<SessionScanImportsCommand>().single()
        assertEquals("proj-9", command.payload.projectId)
        val state = vm.importState.value
        assertEquals("proj-9", state.projectId)
        assertTrue(state.scanning)
    }

    @Test
    fun importConfirmSendsImportCommand_forScannedProject() {
        val sender = RecordingCommandSender()
        val vm = conversationViewModel(sender = sender)
        vm.importScan("proj-9")

        vm.importConfirm("imported-session-1")

        val command = sender.sent.filterIsInstance<SessionImportCommand>().single()
        assertEquals("imported-session-1", command.payload.sessionId)
        assertEquals("proj-9", command.payload.projectId)
    }

    // -------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------

    private fun conversationViewModel(
        repository: FakeConversationRepository = FakeConversationRepository(),
        sender: RecordingCommandSender = RecordingCommandSender(),
        expirySource: FakeTokenExpirySource = FakeTokenExpirySource(),
    ): ConversationViewModel =
        ConversationViewModel(
            sessionId = SESSION_ID,
            repository = repository,
            commandSender = sender,
            expirySource = expirySource,
            scope = CoroutineScope(Dispatchers.Unconfined),
            now = { t0 },
            nowMs = { nowMs },
            newRequestId = { "req-${counter.incrementAndGet()}" },
        )

    private val counter = java.util.concurrent.atomic.AtomicLong()

    private fun session(status: String) = SessionEntity(
        sessionId = SESSION_ID,
        projectId = PROJECT_ID,
        displayName = "demo session",
        status = status,
        lastAckEventId = 10L,
        updatedAt = t0,
    )

    private fun userMessage(id: String, requestId: String?, position: Long, text: String = "text-$id") =
        MessageEntity(
            historyItemId = id,
            sessionId = SESSION_ID,
            historyRevision = "live",
            role = "user",
            contentJson = """[{"kind":"text","text":"$text"}]""",
            sourceIdsJson = "[]",
            status = "complete",
            requestId = requestId,
            position = position,
            createdAt = "2026-01-01T00:00:00Z",
            updatedAt = t0,
        )

    private fun permissionMessage(permissionRequestId: String, toolName: String = "Bash") =
        MessageEntity(
            historyItemId = permissionRequestId,
            sessionId = SESSION_ID,
            historyRevision = "live",
            role = "permission",
            contentJson = (
                """[{"kind":"permission_request","permissionRequestId":"$permissionRequestId",""" +
                    """"toolName":"$toolName","displayCategory":"command_execution",""" +
                    """"expiresAt":"2026-01-01T04:55:00Z",""" +
                    """"input":{"command":"rm -rf /tmp/probe","file_path":"/tmp/probe/x.txt"}}]"""
                ),
            sourceIdsJson = "[]",
            status = "pending",
            requestId = null,
            position = 99L,
            createdAt = "2026-01-01T00:00:00Z",
            updatedAt = t0,
        )

    private fun commandEvent(requestId: String, status: String) = CommandEventEntity(
        requestId = requestId,
        sessionId = SESSION_ID,
        idempotencyKey = requestId,
        commandType = CommandType.MESSAGE_SEND.wire,
        status = status,
        resultJson = null,
        updatedAt = t0,
    )

    private companion object {
        const val SESSION_ID = "22222222-2222-4222-8222-222222222222"
        const val PROJECT_ID = "proj-demo"
        const val SESSION_STATUS_IDLE = "idle"
        const val SESSION_STATUS_RUNNING = "running"
        const val SESSION_STATUS_INTERRUPTED = "interrupted"
        const val SESSION_STATUS_WAITING_PERMISSION = "waiting_permission"
        const val MINUTE_MS = 60_000L
    }
}

// ---------------------------------------------------------------------------
// In-memory fakes. The repository mirrors the DAO-shaped contract the
// production implementation will wrap (Task 33 wires real Room); the sender
// records every §8.2 command envelope; the expiry source models the
// OAuthManager/DeviceSessionManager token expiries.
// ---------------------------------------------------------------------------

private class FakeConversationRepository : ConversationRepository {
    var session: SessionEntity? = null
    val messages = mutableListOf<MessageEntity>()
    val commands = mutableListOf<CommandEventEntity>()

    override fun session(sessionId: String): SessionEntity? =
        session?.takeIf { it.sessionId == sessionId }

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

private class RecordingCommandSender : CommandSender {
    val sent = mutableListOf<ProtocolCommand>()
    override suspend fun send(command: ProtocolCommand) {
        sent.add(command)
    }
}

private class FakeTokenExpirySource : TokenExpirySource {
    var accessExpiresAtMs: Long? = null
    var deviceExpiresAtMs: Long? = null
    override fun accessTokenExpiresAtMs(): Long? = accessExpiresAtMs
    override fun deviceSessionExpiresAtMs(): Long? = deviceExpiresAtMs
}
