package dev.clauderemote.android.ui

import dev.clauderemote.android.data.local.CommandEventEntity
import dev.clauderemote.android.data.local.MessageEntity
import dev.clauderemote.android.data.local.SessionEntity
import dev.clauderemote.android.network.CoordinatorSignal
import dev.clauderemote.android.protocol.v1.CommandType
import dev.clauderemote.android.protocol.v1.MessageSendCommand
import dev.clauderemote.android.protocol.v1.MessageSendPayload
import dev.clauderemote.android.protocol.v1.PermissionDecision
import dev.clauderemote.android.protocol.v1.PermissionResolveCommand
import dev.clauderemote.android.protocol.v1.PermissionResolvePayload
import dev.clauderemote.android.protocol.v1.ProtocolCommand
import dev.clauderemote.android.protocol.v1.CommandRefPayload
import dev.clauderemote.android.protocol.v1.CommandRetryIndeterminateCommand
import dev.clauderemote.android.protocol.v1.SessionImportCommand
import dev.clauderemote.android.protocol.v1.SessionImportPayload
import dev.clauderemote.android.protocol.v1.SessionRefPayload
import dev.clauderemote.android.protocol.v1.SessionReleaseCommand
import dev.clauderemote.android.protocol.v1.SessionResumeCommand
import dev.clauderemote.android.protocol.v1.SessionScanImportsCommand
import dev.clauderemote.android.protocol.v1.SessionScanImportsPayload
import dev.clauderemote.android.protocol.v1.SessionStopCommand
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Conversation-facing ViewModel (spec §12.2, §12.3, §12.4, §12.5).
 *
 * Pure Kotlin — no Android framework types — so the whole state derivation is
 * JVM-testable against in-memory fakes ([ConversationRepositoryTest fixtures
 * in ConversationViewModelTest]). The Compose screens are thin collectors of
 * [uiState]/[importState]/[expiryWarning]; production wiring over real Room
 * DAOs and the ConnectionCoordinator lands with Task 33.
 *
 * State-derivation rules mirrored from the spec:
 * - §12.2: a user message row renders the §8.3/§8.4 command status badge by
 *   joining `MessageEntity.requestId` ↔ `CommandEventEntity.status`; rows
 *   without a correlated command row render badge-free rather than guessing;
 * - §7.1/§12.2: only `idle` accepts new user messages, so Send is enabled
 *   iff the session status is `idle` — non-idle shows the server's real
 *   state instead of letting the user re-submit by feel;
 * - §7.5: Stop and Release are distinct commands, and Release only ever
 *   fires from `idle`/`interrupted`;
 * - §12.3: the pending permission is exposed fail-closed — no preselected
 *   decision, the sheet's Allow is never the default focus target;
 * - §7.4: a send is projected optimistically (user row + dispatching badge +
 *   requestId correlation) BEFORE the command leaves, so the crash window
 *   always has a resumable intent row;
 * - §12.5: the refresh-expiry warning appears when the OAuth Access token or
 *   the device session has less than [EXPIRY_WARNING_THRESHOLD_MS] left.
 */
class ConversationViewModel(
    private val sessionId: String,
    private val repository: ConversationRepository,
    private val commandSender: CommandSender,
    private val expirySource: TokenExpirySource,
    private val scope: CoroutineScope,
    private val now: () -> Instant = Instant::now,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val newRequestId: () -> String = { UUID.randomUUID().toString() },
) {

    private val _uiState = MutableStateFlow(ConversationUiState())
    val uiState: StateFlow<ConversationUiState> = _uiState.asStateFlow()

    private val _importState = MutableStateFlow(ImportUiState())
    val importState: StateFlow<ImportUiState> = _importState.asStateFlow()

    private val _expiryWarning = MutableStateFlow<ExpiryWarning?>(null)
    val expiryWarning: StateFlow<ExpiryWarning?> = _expiryWarning.asStateFlow()

    init {
        refresh()
    }

    /**
     * Re-reads the projection and the token expiries; the screens call this on resume.
     * The banner SURVIVES the re-derivation — it is transient UI state owned by
     * [onCoordinatorSignal], cleared only when its condition clears
     * ([clearBanner]), never by a routine refresh.
     */
    fun refresh() {
        _uiState.value = computeUiState().copy(banner = _uiState.value.banner)
        _expiryWarning.value = computeExpiryWarning()
    }

    // -------------------------------------------------------------------
    // §12.2 message actions
    // -------------------------------------------------------------------

    /**
     * Sends a user message. Gated on `idle` (§7.1: only idle accepts new user
     * messages); a non-idle call is a no-op — the UI already disables Send,
     * this is the second, state-truthful gate behind it.
     */
    fun sendMessage(text: String) {
        if (!isIdle()) return
        val requestId = newRequestId()
        val timestamp = now()
        // §7.4 optimistic intent: the row and its command correlation are
        // durable BEFORE the envelope leaves, so a crash mid-send always
        // leaves a resumable (retry-indeterminate) trail.
        repository.upsertMessage(
            MessageEntity(
                historyItemId = "$LOCAL_MESSAGE_PREFIX$requestId",
                sessionId = sessionId,
                historyRevision = REVISION_LIVE,
                role = ROLE_USER,
                contentJson = textContentJson(text),
                sourceIdsJson = """["$requestId"]""",
                status = STATUS_DISPATCHING,
                requestId = requestId,
                position = nextPosition(),
                createdAt = timestamp.toString(),
                updatedAt = timestamp,
            ),
        )
        repository.upsertCommandEvent(
            CommandEventEntity(
                requestId = requestId,
                sessionId = sessionId,
                idempotencyKey = requestId,
                commandType = CommandType.MESSAGE_SEND.wire,
                status = STATUS_DISPATCHING,
                resultJson = null,
                updatedAt = timestamp,
            ),
        )
        sendCommand(
            MessageSendCommand(
                requestId = requestId,
                idempotencyKey = requestId,
                sessionId = sessionId,
                sentAt = timestamp.toString(),
                payload = MessageSendPayload(sessionId = sessionId, text = text),
            ),
        )
        refresh()
    }

    /** The §12.2 send-continue affordance on interrupted messages. */
    fun sendContinue() {
        sendMessage(CONTINUE_MESSAGE_TEXT)
    }

    /**
     * §11.2/§12.2 Safe Retry: only ever a `command.retry_indeterminate` — the
     * indeterminate row's requestId is exactly the correlation the bridge
     * resolves the retry against.
     */
    fun safeRetry(requestId: String) {
        sendCommand(
            CommandRetryIndeterminateCommand(
                requestId = newRequestId(),
                idempotencyKey = newRequestIdIdempotent(),
                sentAt = now().toString(),
                payload = CommandRefPayload(requestId = requestId),
            ),
        )
    }

    /** §7.3 resume of an interrupted session. */
    fun resume() {
        sendCommand(
            SessionResumeCommand(
                requestId = newRequestId(),
                idempotencyKey = newRequestIdIdempotent(),
                sessionId = sessionId,
                sentAt = now().toString(),
                payload = SessionRefPayload(sessionId = sessionId),
            ),
        )
    }

    /** §7.5 Stop: interrupts the current turn; the session stays resumable. */
    fun stop() {
        sendCommand(
            SessionStopCommand(
                requestId = newRequestId(),
                idempotencyKey = newRequestIdIdempotent(),
                sessionId = sessionId,
                sentAt = now().toString(),
                payload = SessionRefPayload(sessionId = sessionId),
            ),
        )
    }

    /**
     * §7.5 Release: only valid from `idle`/`interrupted`. The state exposure
     * (releaseEnabled) already reflects this; this second gate keeps the
     * invariant even against direct calls.
     */
    fun release() {
        val status = currentStatus()
        if (status != SESSION_STATUS_IDLE && status != SESSION_STATUS_INTERRUPTED) return
        sendCommand(
            SessionReleaseCommand(
                requestId = newRequestId(),
                idempotencyKey = newRequestIdIdempotent(),
                sessionId = sessionId,
                sentAt = now().toString(),
                payload = SessionRefPayload(sessionId = sessionId),
            ),
        )
    }

    // -------------------------------------------------------------------
    // §12.3 permission actions (fail-closed)
    // -------------------------------------------------------------------

    fun allowPermission(permissionRequestId: String) =
        resolvePermission(permissionRequestId, PermissionDecision.ALLOW)

    fun denyPermission(permissionRequestId: String) =
        resolvePermission(permissionRequestId, PermissionDecision.DENY)

    private fun resolvePermission(permissionRequestId: String, decision: PermissionDecision) {
        sendCommand(
            PermissionResolveCommand(
                requestId = newRequestId(),
                idempotencyKey = newRequestIdIdempotent(),
                sessionId = sessionId,
                sentAt = now().toString(),
                payload = PermissionResolvePayload(
                    permissionRequestId = permissionRequestId,
                    sessionId = sessionId,
                    decision = decision,
                ),
            ),
        )
        // Optimistically resolve the local row so the sheet dismisses
        // immediately; a later permission.resolved event reconciles the
        // projection (§6.7 stable source IDs make that a no-op upsert).
        repository.messages(sessionId)
            .firstOrNull { it.historyItemId == permissionRequestId && it.status == STATUS_PENDING }
            ?.let { pending ->
                repository.upsertMessage(pending.copy(status = STATUS_RESOLVED, updatedAt = now()))
            }
        refresh()
    }

    // -------------------------------------------------------------------
    // §12.4 import actions
    // -------------------------------------------------------------------

    fun importScan(projectId: String) {
        _importState.value = _importState.value.copy(projectId = projectId, scanning = true)
        sendCommand(
            SessionScanImportsCommand(
                requestId = newRequestId(),
                idempotencyKey = newRequestIdIdempotent(),
                sentAt = now().toString(),
                payload = SessionScanImportsPayload(projectId = projectId),
            ),
        )
    }

    /**
     * Feeds the §12.4 project picker: the projects this install already
     * tracks in the projection (the Bridge-authorized set).
     */
    fun setKnownProjects(projects: List<String>) {
        if (_importState.value.projects != projects) {
            _importState.value = _importState.value.copy(projects = projects)
        }
    }

    fun importConfirm(targetSessionId: String) {
        sendCommand(
            SessionImportCommand(
                requestId = newRequestId(),
                idempotencyKey = newRequestIdIdempotent(),
                sentAt = now().toString(),
                payload = SessionImportPayload(
                    sessionId = targetSessionId,
                    projectId = _importState.value.projectId ?: "",
                ),
            ),
        )
        _importState.value = _importState.value.copy(scanning = false)
    }

    // -------------------------------------------------------------------
    // §11.1 coordinator signals → conversation banners
    // -------------------------------------------------------------------

    fun onCoordinatorSignal(signal: CoordinatorSignal) {
        _uiState.value = _uiState.value.copy(
            banner = when (signal) {
                is CoordinatorSignal.ReAuthenticationRequired -> ConversationBanner.RE_AUTHENTICATION_REQUIRED
                is CoordinatorSignal.SessionConflict -> ConversationBanner.SESSION_CONFLICT
                is CoordinatorSignal.ResyncRequired -> ConversationBanner.RESYNC_REQUIRED
                is CoordinatorSignal.UpgradeRequired -> ConversationBanner.UPGRADE_REQUIRED
            },
        )
    }

    /**
     * Clears the banner once its condition is resolved (e.g. the connection
     * returned to CONNECTED after a §6.7 resync, or a re-login succeeded).
     * Until then the banner persists across every [refresh].
     */
    fun clearBanner() {
        if (_uiState.value.banner != null) {
            _uiState.value = _uiState.value.copy(banner = null)
        }
    }

    // -------------------------------------------------------------------
    // State derivation
    // -------------------------------------------------------------------

    private fun computeUiState(): ConversationUiState {
        val session = repository.session(sessionId)
        val messages = repository.messages(sessionId)
        val commands = repository.commandEvents(sessionId)
        val statusByRequestId = commands.associate { it.requestId to it.status }

        val items = messages.map { message -> projectItem(message, statusByRequestId) }

        return ConversationUiState(
            session = session,
            items = items,
            sendEnabled = session?.status == SESSION_STATUS_IDLE,
            releaseEnabled = session?.status == SESSION_STATUS_IDLE ||
                session?.status == SESSION_STATUS_INTERRUPTED,
            streaming = messages.any { it.status == STATUS_STREAMING },
            pendingPermission = messages
                .firstOrNull { it.role == ROLE_PERMISSION && it.status == STATUS_PENDING }
                ?.let(::projectPendingPermission),
        )
    }

    /** §12.2 per-badge affordances: Safe Retry for indeterminate rows,
     *  Resume + send-continue for interrupted ones. */
    private fun badgeActions(badge: MessageBadge?): List<MessageAction> = when (badge) {
        MessageBadge.INDETERMINATE -> listOf(MessageAction.SAFE_RETRY)
        MessageBadge.INTERRUPTED -> listOf(MessageAction.RESUME, MessageAction.SEND_CONTINUE)
        else -> emptyList()
    }

    /** Badge + per-badge actions derivation (§12.2). */
    private fun projectItem(message: MessageEntity, statusByRequestId: Map<String, String>): ConversationItem {
        if (message.role == ROLE_TOOL) return projectToolItem(message)
        val badge = message.requestId
            ?.let { statusByRequestId[it] }
            ?.let(MessageBadge::fromWire)
        return ConversationItem.Text(
            id = message.historyItemId,
            role = message.role,
            text = extractText(message),
            requestId = message.requestId,
            badge = badge,
            actions = badgeActions(badge),
            streaming = message.status == STATUS_STREAMING,
        )
    }

    private fun projectToolItem(message: MessageEntity): ConversationItem.ToolCall {
        val blocks = blocksOf(message)
        val toolUse = blocks.firstOrNull { it[BLOCK_KIND]?.jsonPrimitive?.contentOrNull == BLOCK_TOOL_USE }
        val toolName = toolUse?.get("toolName")?.jsonPrimitive?.contentOrNull ?: "tool"
        val preview = toolUse?.get("input")?.toString().orEmpty()
        val output = blocks
            .filter { block ->
                val kind = block[BLOCK_KIND]?.jsonPrimitive?.contentOrNull
                kind == BLOCK_TOOL_OUTPUT || kind == BLOCK_TOOL_RESULT
            }
            .mapNotNull { block ->
                block["text"]?.jsonPrimitive?.contentOrNull
                    ?: block["content"]?.jsonPrimitive?.contentOrNull
            }
            .joinToString(separator = "\n")
        val truncated = blocks.any { it["truncated"]?.jsonPrimitive?.contentOrNull == "true" }
        return ConversationItem.ToolCall(
            id = message.historyItemId,
            toolName = toolName,
            status = message.status,
            preview = preview,
            output = output,
            truncated = truncated,
        )
    }

    private fun projectPendingPermission(message: MessageEntity): PendingPermissionUi {
        val block = blocksOf(message).firstOrNull { it[BLOCK_KIND]?.jsonPrimitive?.contentOrNull == BLOCK_PERMISSION_REQUEST }
        val input = block?.get("input")
        val commandOrPath = (input as? JsonObject)?.let { obj ->
            obj["command"]?.jsonPrimitive?.contentOrNull
                ?: obj["file_path"]?.jsonPrimitive?.contentOrNull
                ?: obj["path"]?.jsonPrimitive?.contentOrNull
        }
        return PendingPermissionUi(
            permissionRequestId = block?.get("permissionRequestId")?.jsonPrimitive?.contentOrNull
                ?: message.historyItemId,
            toolName = block?.get("toolName")?.jsonPrimitive?.contentOrNull,
            displayCategory = block?.get("displayCategory")?.jsonPrimitive?.contentOrNull,
            commandOrPath = commandOrPath,
            rawParamsJson = input?.toString(),
            expiresAtMs = block?.get("expiresAt")?.jsonPrimitive?.contentOrNull?.let(::parseRfc3339ToMs),
            // Fail-closed (§12.3): never a preselected decision — the sheet's
            // default focus must not be the Allow action.
            defaultDecision = null,
        )
    }

    private fun computeExpiryWarning(): ExpiryWarning? =
        listOfNotNull(
            expirySource.accessTokenExpiresAtMs()
                ?.minus(nowMs())
                ?.takeIf { it >= 0 }
                ?.let { ExpiryWarning(ExpiryWarning.Kind.ACCESS_TOKEN, it) },
            expirySource.deviceSessionExpiresAtMs()
                ?.minus(nowMs())
                ?.takeIf { it >= 0 }
                ?.let { ExpiryWarning(ExpiryWarning.Kind.DEVICE_SESSION, it) },
        )
            .filter { it.remainingMs < EXPIRY_WARNING_THRESHOLD_MS }
            .minByOrNull { it.remainingMs }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    private fun currentStatus(): String? = repository.session(sessionId)?.status

    private fun isIdle(): Boolean = currentStatus() == SESSION_STATUS_IDLE

    private fun nextPosition(): Long =
        (repository.messages(sessionId).maxOfOrNull { it.position } ?: -1L) + 1L

    /**
     * A second idempotency key for commands that are their own request (the
     * retry envelope's requestId differs from the retried command's, and the
     * idempotency key must differ from the message-send requestId to keep the
     * optimistic correlation clean).
     */
    private fun newRequestIdIdempotent(): String = newRequestId()

    private fun sendCommand(command: ProtocolCommand) {
        scope.launch { commandSender.send(command) }
    }

    private fun blocksOf(message: MessageEntity): List<JsonObject> =
        runCatching { lenientJson.parseToJsonElement(message.contentJson) as? JsonArray }
            .getOrNull()
            ?.filterIsInstance<JsonObject>()
            ?: emptyList()

    private fun extractText(message: MessageEntity): String =
        blocksOf(message)
            .filter { block ->
                val kind = block[BLOCK_KIND]?.jsonPrimitive?.contentOrNull
                kind == BLOCK_TEXT || kind == BLOCK_SYSTEM_NOTE
            }
            .mapNotNull { it["text"]?.jsonPrimitive?.contentOrNull }
            .joinToString(separator = "\n")

    private fun textContentJson(text: String): String =
        JsonArray(
            listOf(
                buildJsonObject {
                    put(BLOCK_KIND, BLOCK_TEXT)
                    put("text", text)
                },
            ),
        ).toString()

    private fun parseRfc3339ToMs(raw: String): Long? =
        try {
            OffsetDateTime.parse(raw).toInstant().toEpochMilli()
        } catch (e: DateTimeParseException) {
            null
        }

    private val lenientJson = Json { ignoreUnknownKeys = true }

    companion object {
        /** §12.5: warn when a token has less than five minutes left. */
        const val EXPIRY_WARNING_THRESHOLD_MS = 5 * 60_000L

        /** §12.2 send-continue affordance text. */
        const val CONTINUE_MESSAGE_TEXT = "continue"

        const val SESSION_STATUS_IDLE = "idle"
        const val SESSION_STATUS_INTERRUPTED = "interrupted"

        const val ROLE_USER = "user"
        const val ROLE_TOOL = "tool"
        const val ROLE_PERMISSION = "permission"

        const val STATUS_STREAMING = "streaming"
        const val STATUS_PENDING = "pending"
        const val STATUS_RESOLVED = "resolved"
        const val STATUS_DISPATCHING = "dispatching"

        const val REVISION_LIVE = "live"
        const val LOCAL_MESSAGE_PREFIX = "local-message:"

        const val BLOCK_KIND = "kind"
        const val BLOCK_TEXT = "text"
        const val BLOCK_SYSTEM_NOTE = "system_note"
        const val BLOCK_TOOL_USE = "tool_use"
        const val BLOCK_TOOL_OUTPUT = "tool_output"
        const val BLOCK_TOOL_RESULT = "tool_result"
        const val BLOCK_PERMISSION_REQUEST = "permission_request"
    }
}

/**
 * Read/write seam over the Room projection the conversation UI consumes.
 * The JVM suite drives it with an in-memory fake; the production
 * implementation (Task 33) wraps the MessageDao/CommandEventDao/SessionDao.
 */
interface ConversationRepository {
    fun session(sessionId: String): SessionEntity?
    fun messages(sessionId: String): List<MessageEntity>
    fun commandEvents(sessionId: String): List<CommandEventEntity>

    /** Optimistic §7.4 intent write (user row) before a command leaves. */
    fun upsertMessage(message: MessageEntity)

    /** Optimistic §7.4 intent write (command correlation row). */
    fun upsertCommandEvent(event: CommandEventEntity)
}

/** Sends one §8.2 command envelope; production delegates to ConnectionCoordinator.send. */
fun interface CommandSender {
    suspend fun send(command: ProtocolCommand)
}

/**
 * Auth/token expiry seam feeding the §12.5 refresh-expiry warning. Millis are
 * epoch times; null means "no advertised expiry" (opaque Access tokens).
 */
interface TokenExpirySource {
    fun accessTokenExpiresAtMs(): Long?
    fun deviceSessionExpiresAtMs(): Long?
}

/** §8.3/§8.4 command status badge rendered on user message rows (§12.2). */
enum class MessageBadge(val wire: String) {
    ACCEPTED("accepted"),
    DISPATCHING("dispatching"),
    DISPATCHED("dispatched"),
    INDETERMINATE("indeterminate"),
    INTERRUPTED("interrupted"),
    COMPLETED("completed"),
    FAILED("failed"),
    ;

    companion object {
        fun fromWire(raw: String): MessageBadge? = entries.firstOrNull { it.wire == raw }
    }
}

/** §12.2 per-badge affordances. */
enum class MessageAction { SAFE_RETRY, RESUME, SEND_CONTINUE }

/** Rendered conversation row: a message, or a collapsible tool card (§12.2). */
sealed interface ConversationItem {
    val id: String

    data class Text(
        override val id: String,
        val role: String,
        val text: String,
        /** Correlation to the message.send command; the Safe Retry target. */
        val requestId: String?,
        val badge: MessageBadge?,
        val actions: List<MessageAction>,
        val streaming: Boolean,
    ) : ConversationItem

    data class ToolCall(
        override val id: String,
        val toolName: String,
        val status: String,
        val preview: String,
        val output: String,
        val truncated: Boolean,
    ) : ConversationItem
}

/** §12.3 pending permission, exposed fail-closed (no default decision). */
data class PendingPermissionUi(
    val permissionRequestId: String,
    val toolName: String?,
    val displayCategory: String?,
    val commandOrPath: String?,
    val rawParamsJson: String?,
    val expiresAtMs: Long?,
    val defaultDecision: PermissionDecision?,
)

/** §11.1/§12.2 connection-outcome banners rendered above the conversation. */
enum class ConversationBanner {
    RESYNC_REQUIRED,
    RE_AUTHENTICATION_REQUIRED,
    UPGRADE_REQUIRED,
    SESSION_CONFLICT,
}

/** §12.5 refresh-expiry warning. */
data class ExpiryWarning(
    val kind: Kind,
    val remainingMs: Long,
) {
    enum class Kind { ACCESS_TOKEN, DEVICE_SESSION }
}

/** Conversation screen state (§12.2). */
data class ConversationUiState(
    val session: SessionEntity? = null,
    val items: List<ConversationItem> = emptyList(),
    val sendEnabled: Boolean = false,
    val releaseEnabled: Boolean = false,
    val streaming: Boolean = false,
    val pendingPermission: PendingPermissionUi? = null,
    val banner: ConversationBanner? = null,
)

/** §12.4 import screen state. */
data class ImportUiState(
    val projectId: String? = null,
    val projects: List<String> = emptyList(),
    val scanning: Boolean = false,
    val candidates: List<ImportCandidateUi> = emptyList(),
)

/** One scanned import candidate with its §12.4 disposition. */
data class ImportCandidateUi(
    val sessionId: String,
    val title: String,
    val lastActivity: String? = null,
    val state: ImportCandidateState = ImportCandidateState.IMPORTABLE,
)

/** §12.4: corrupted records, moved projects, and duplicates get explicit states. */
enum class ImportCandidateState { IMPORTABLE, CORRUPTED, PROJECT_MOVED, DUPLICATE }
