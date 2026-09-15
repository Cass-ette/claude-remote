package dev.clauderemote.android.sync

import dev.clauderemote.android.data.local.CommandEventDao
import dev.clauderemote.android.data.local.CommandEventEntity
import dev.clauderemote.android.data.local.MessageDao
import dev.clauderemote.android.data.local.MessageEntity
import dev.clauderemote.android.data.local.PendingLiveEventDao
import dev.clauderemote.android.data.local.PendingLiveEventEntity
import dev.clauderemote.android.data.local.SessionDao
import dev.clauderemote.android.data.local.SessionEntity
import dev.clauderemote.android.protocol.v1.CommandStatusChangedPayload
import dev.clauderemote.android.protocol.v1.EventType
import dev.clauderemote.android.protocol.v1.ProtocolEvent
import dev.clauderemote.android.protocol.v1.ProtocolJson
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * §8.4 event reducer: folds one bridge event into the Room projection
 * (spec §6.7, §8.4, §8.5).
 *
 * The reducer is a pure function of (DAO bundle, event) — it never opens a
 * Room transaction itself. The SessionRepository wraps every [apply] in ONE
 * Room transaction (`withTransaction`), so a crash can never leave a
 * half-applied event; the JVM suite drives it against in-memory DAO fakes,
 * the instrumented suite drives it through real Room.
 *
 * Delivery semantics (§8.5):
 * - the per-session continuous cursor `sessions.lastAckEventId` doubles as
 *   the APPLIED tracker: an event with `eventId <= cursor` is a duplicate
 *   and is dropped silently (re-deliveries above the resume marker dedupe
 *   here); duplicates of a merely BUFFERED event dedupe on the
 *   `pending_live_events` composite PK instead;
 * - an event with `eventId > cursor + 1` (a gap) is buffered into
 *   `pending_live_events` verbatim and applied only once the gap fills —
 *   unless a committed checkpoint supersedes the gap: the coordinator's
 *   commit transaction sets the cursor to `deliveryWatermark` and the
 *   buffered events above it then apply as the new contiguous head.
 *
 * Projection conventions:
 * - snapshot items and live events share the STABLE source ID (message
 *   UUID / toolUseId / permissionRequestId) as `messages.historyItemId`,
 *   so §6.7 "snapshot already contains this event" never duplicates a row;
 * - `contentJson` stores a JSON array of App history blocks using the
 *   bridge adapter's block vocabulary: {"kind":"text"|"tool_use"|
 *   "tool_result"|"system_note"|...};
 * - a malformed/unknown payload CONSUMES the position without projecting
 *   anything: otherwise one undecodable event would wedge the session on
 *   a permanent redelivery loop (§8.5 does not require tolerating drift,
 *   but it requires never faking continuity — the event is dropped, the
 *   cursor still advances past it).
 *
 * Payload field names mirror the bridge emitters exactly where they exist
 * (session-supervisor.ts, command-ledger.ts, session-event-pump.ts,
 * permission-broker.ts). The remaining v1 payloads are intentionally loose
 * on the wire; the local data classes below define the App-side contract.
 */
class EventReducer(
    private val now: () -> Instant = Instant::now,
) {

    /** Result of folding one event into the projection. */
    enum class Outcome {
        /** The event (and any gap it filled) was applied and the cursor advanced. */
        APPLIED,

        /** eventId at/below the continuous cursor: §8.5 duplicate, dropped. */
        DUPLICATE_DROPPED,

        /** A gap is missing: the event is buffered verbatim, cursor unmoved. */
        BUFFERED,
    }

    fun apply(daos: ProjectionDaos, event: ProtocolEvent): Outcome {
        val sessionId = event.sessionId
        val eventId = event.eventId.value
        val floor = daos.sessions.getBySessionId(sessionId)?.lastAckEventId ?: 0L
        return when {
            eventId <= floor -> Outcome.DUPLICATE_DROPPED
            eventId > floor + 1 -> {
                daos.pendingEvents.bufferPendingEvent(
                    PendingLiveEventEntity(
                        sessionId = sessionId,
                        eventId = eventId,
                        envelopeJson = ProtocolJson.json.encodeToString(ProtocolEvent.serializer(), event),
                        receivedAt = now(),
                    ),
                )
                Outcome.BUFFERED
            }
            else -> {
                applyTyped(daos, event)
                advanceCursor(daos, sessionId, eventId)
                drainBuffered(daos, sessionId, eventId)
                Outcome.APPLIED
            }
        }
    }

    /**
     * §8.5 cursor advance. The sessions row IS the cursor's storage: for an
     * unknown session whose first event is non-status (nothing upserts the
     * row yet) ackIfAfter's UPDATE matches zero rows, the position never
     * persists, and every reconnect replays from zero — a permanent wedge.
     * A minimal row is created first so the cursor still advances; a later
     * session.state.changed (or snapshot cycle) fills in the real fields.
     */
    private fun advanceCursor(daos: ProjectionDaos, sessionId: String, candidate: Long) {
        if (daos.sessions.getBySessionId(sessionId) == null) {
            daos.sessions.upsert(
                SessionEntity(
                    sessionId = sessionId,
                    projectId = "",
                    displayName = "",
                    status = STATUS_UNKNOWN,
                    lastAckEventId = null,
                    updatedAt = now(),
                ),
            )
        }
        daos.sessions.ackIfAfter(sessionId, candidate, now())
    }

    /**
     * Applies buffered events that are now the contiguous head, in eventId
     * order. Events still behind a gap are re-buffered untouched.
     */
    private fun drainBuffered(daos: ProjectionDaos, sessionId: String, appliedId: Long) {
        var cursor = appliedId
        val remaining = daos.pendingEvents.takeBufferedEvents(sessionId, afterEventId = appliedId).toMutableList()
        while (remaining.firstOrNull()?.eventId == cursor + 1L) {
            val next = remaining.removeFirst()
            decodeEnvelope(next.envelopeJson)?.let { applyTyped(daos, it) }
            advanceCursor(daos, sessionId, next.eventId)
            cursor = next.eventId
        }
        remaining.forEach { daos.pendingEvents.bufferPendingEvent(it) }
    }

    internal fun decodeEnvelope(envelopeJson: String): ProtocolEvent? =
        runCatching { ProtocolJson.json.decodeFromString(ProtocolEvent.serializer(), envelopeJson) }.getOrNull()

    // -------------------------------------------------------------------
    // Typed application
    // -------------------------------------------------------------------

    /**
     * Projects one event's payload WITHOUT the §8.5 ordering checks — used
     * by the snapshot coordinator for state the checkpoint itself captured
     * (pending permission), where no delivery ordering exists.
     */
    internal fun applyProjection(daos: ProjectionDaos, event: ProtocolEvent) = applyTyped(daos, event)

    private fun applyTyped(daos: ProjectionDaos, event: ProtocolEvent) {
        when (event.eventType) {
            EventType.SESSION_STATE_CHANGED -> {
                val p = parse<SessionStateChangedPayload>(event.payload) ?: return
                upsertSessionStatus(daos, event.sessionId, p.status)
            }
            EventType.COMMAND_STATUS_CHANGED -> {
                val p = parse<CommandStatusChangedPayload>(event.payload) ?: return
                applyCommandStatusChanged(daos, event, p)
            }
            EventType.ASSISTANT_MESSAGE_DELTA -> {
                val p = parse<AssistantMessageDeltaPayload>(event.payload) ?: return
                applyAssistantDelta(daos, event, p)
            }
            EventType.ASSISTANT_MESSAGE_COMPLETED -> {
                val p = parse<AssistantMessageCompletedPayload>(event.payload) ?: return
                applyAssistantCompleted(daos, event, p)
            }
            EventType.TOOL_STARTED -> {
                val p = parse<ToolStartedPayload>(event.payload) ?: return
                upsertBlocks(
                    daos, event, stableId = p.toolUseId, role = ROLE_TOOL, status = STATUS_RUNNING,
                    sourceId = p.toolUseId,
                    blocks = listOf(
                        buildJsonObject {
                            put(KIND, BLOCK_TOOL_USE)
                            put("toolUseId", p.toolUseId)
                            p.toolName?.let { put("toolName", it) }
                            p.input?.let { put("input", it) }
                        },
                    ),
                )
            }
            EventType.TOOL_OUTPUT_DELTA -> {
                val p = parse<ToolOutputDeltaPayload>(event.payload) ?: return
                applyToolOutputDelta(daos, event, p)
            }
            EventType.TOOL_COMPLETED -> {
                val p = parse<ToolCompletedPayload>(event.payload) ?: return
                applyToolCompleted(daos, event, p)
            }
            EventType.PERMISSION_REQUESTED -> {
                val p = parse<PermissionRequestedPayload>(event.payload) ?: return
                upsertBlocks(
                    daos, event, stableId = p.permissionRequestId, role = ROLE_PERMISSION, status = STATUS_PENDING,
                    sourceId = p.permissionRequestId,
                    blocks = listOf(
                        buildJsonObject {
                            put(KIND, "permission_request")
                            put("permissionRequestId", p.permissionRequestId)
                            p.toolName?.let { put("toolName", it) }
                            p.input?.let { put("input", it) }
                            p.toolUseId?.let { put("toolUseId", it) }
                            p.requestedAt?.let { put("requestedAt", it) }
                            p.expiresAt?.let { put("expiresAt", it) }
                            p.displayCategory?.let { put("displayCategory", it) }
                        },
                    ),
                )
            }
            EventType.PERMISSION_RESOLVED -> {
                val p = parse<PermissionResolvedPayload>(event.payload) ?: return
                applyPermissionResolved(daos, event, p)
            }
            EventType.PROCESS_STDERR_SUMMARY -> {
                val p = parse<ProcessStderrSummaryPayload>(event.payload) ?: return
                upsertBlocks(
                    daos, event, stableId = systemNoteId(event), role = ROLE_SYSTEM, status = STATUS_COMPLETE,
                    sourceId = systemNoteId(event),
                    blocks = listOf(noteBlock(p.summary ?: p.text ?: "")),
                )
            }
            EventType.SESSION_INTERRUPTED -> {
                val p = parse<SessionInterruptedPayload>(event.payload) ?: return
                upsertSessionStatus(daos, event.sessionId, STATUS_INTERRUPTED)
                upsertBlocks(
                    daos, event, stableId = systemNoteId(event), role = ROLE_SYSTEM, status = STATUS_COMPLETE,
                    sourceId = systemNoteId(event),
                    blocks = listOf(noteBlock(p.reason ?: "session interrupted")),
                )
            }
            EventType.SESSION_FAILED -> {
                val p = parse<SessionFailedPayload>(event.payload) ?: return
                upsertSessionStatus(daos, event.sessionId, STATUS_FAILED)
                upsertBlocks(
                    daos, event, stableId = systemNoteId(event), role = ROLE_SYSTEM, status = STATUS_COMPLETE,
                    sourceId = systemNoteId(event),
                    blocks = listOf(
                        noteBlock(
                            p.error?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull
                                ?: p.message
                                ?: "session failed",
                        ),
                    ),
                )
            }
        }
    }

    private fun applyCommandStatusChanged(daos: ProjectionDaos, event: ProtocolEvent, p: CommandStatusChangedPayload) {
        val resultJson = p.result?.toString()
        val updated = daos.commands.updateCommandStatusByRequestId(
            requestId = p.requestId,
            status = p.commandStatus.name.lowercase(),
            resultJson = resultJson,
            now = now(),
        )
        if (updated == 0) {
            // Unknown requestId (e.g. a command issued by another device):
            // project it from the payload instead of dropping it.
            daos.commands.upsert(
                CommandEventEntity(
                    requestId = p.requestId,
                    sessionId = event.sessionId,
                    idempotencyKey = p.idempotencyKey,
                    commandType = p.commandType,
                    status = p.commandStatus.name.lowercase(),
                    resultJson = resultJson,
                    updatedAt = now(),
                ),
            )
        }
        // Badge source: the MessageEntity correlated by requestId finalizes
        // on terminal command statuses; non-terminal statuses leave it.
        val messageStatus = when (p.commandStatus) {
            dev.clauderemote.android.protocol.v1.CommandStatus.COMPLETED -> STATUS_COMPLETE
            dev.clauderemote.android.protocol.v1.CommandStatus.FAILED,
            dev.clauderemote.android.protocol.v1.CommandStatus.INTERRUPTED,
            -> STATUS_FAILED
            else -> null
        }
        if (messageStatus != null) {
            daos.messages.getByRequestId(event.sessionId, p.requestId)?.let { linked ->
                if (linked.status != messageStatus) {
                    daos.messages.upsertMessage(linked.copy(status = messageStatus, updatedAt = now()))
                }
            }
        }
    }

    private fun applyAssistantDelta(daos: ProjectionDaos, event: ProtocolEvent, p: AssistantMessageDeltaPayload) {
        // The bridge's delta payload is {frame} with NO messageUuid (only
        // message_start frames carry message.id), and one assistant turn
        // streams per session at a time — so the streaming row is keyed by
        // the per-session fallback id. assistant.message.completed then
        // finalizes under the stable messageUuid and drops the fallback
        // partial, keeping the one-row-per-message invariant (§6.7).
        val frame = p.frame as? JsonObject
        val stableId = fallbackStreamingId(event.sessionId)
        val existing = daos.messages.getByHistoryItemId(stableId)
        if (existing != null && existing.status != STATUS_STREAMING) {
            // A finalized row (snapshot or a completed re-delivery) must not
            // regress back to streaming partial text (§6.7 shared source IDs).
            return
        }
        val deltaText = extractDeltaText(frame)
        if (existing == null) {
            // The turn tail (content_block_stop / message_delta / message_stop)
            // arrives AFTER assistant.message.completed dropped the streaming
            // partial; those no-text frames must not resurrect an empty
            // "生成中…" row that nothing will ever complete.
            if (deltaText.isEmpty() && frame?.get("type")?.jsonPrimitive?.contentOrNull != "message_start") return
            upsertBlocks(
                daos, event, stableId = stableId, role = ROLE_ASSISTANT, status = STATUS_STREAMING,
                sourceId = stableId, blocks = textBlocks(deltaText),
            )
        } else {
            val accumulated = accumulatedText(existing) + deltaText
            daos.messages.upsertMessage(
                existing.copy(contentJson = blocksToJson(textBlocks(accumulated)), updatedAt = now()),
            )
        }
    }

    private fun applyAssistantCompleted(daos: ProjectionDaos, event: ProtocolEvent, p: AssistantMessageCompletedPayload) {
        val fallbackId = fallbackStreamingId(event.sessionId)
        val stableId = p.messageUuid ?: fallbackId
        val existing = daos.messages.getByHistoryItemId(stableId)
        val blocks = messageBlocks(p.message)
        if (blocks.none { it[KIND]?.jsonPrimitive?.contentOrNull == BLOCK_TOOL_USE } &&
            blocks.all { it["text"]?.jsonPrimitive?.contentOrNull.isNullOrBlank() }
        ) {
            // Thinking-only turn (GLM emits `thinking` blocks the block
            // vocabulary does not model): persisting it would render a blank
            // bubble. Drop the turn's fallback streaming partial too so no
            // dangling "生成中…" row remains.
            daos.messages.getByHistoryItemId(fallbackId)
                ?.takeIf { it.status == STATUS_STREAMING }
                ?.let { daos.messages.deleteByHistoryItemId(fallbackId) }
            return
        }
        upsertBlocks(
            daos, event, stableId = stableId, role = ROLE_ASSISTANT, status = STATUS_COMPLETE,
            sourceId = stableId,
            blocks = blocks,
            createdAt = existing?.createdAt,
            position = existing?.position,
        )
        if (stableId != fallbackId) {
            // The turn streamed under the per-session fallback id before the
            // real UUID became known: drop the stale partial so it is not
            // displayed next to the finalized row.
            daos.messages.getByHistoryItemId(fallbackId)
                ?.takeIf { it.status == STATUS_STREAMING }
                ?.let { daos.messages.deleteByHistoryItemId(fallbackId) }
        }
    }

    private fun applyToolOutputDelta(daos: ProjectionDaos, event: ProtocolEvent, p: ToolOutputDeltaPayload) {
        val chunk = p.delta ?: p.text ?: ""
        val existing = daos.messages.getByHistoryItemId(p.toolUseId)
        if (existing != null && existing.status != STATUS_RUNNING) {
            // Terminal tool row (snapshot or completed): late output deltas
            // are already reflected in the final content.
            return
        }
        if (existing == null) {
            upsertBlocks(
                daos, event, stableId = p.toolUseId, role = ROLE_TOOL, status = STATUS_RUNNING,
                sourceId = p.toolUseId,
                blocks = listOf(outputBlock(chunk)),
            )
            return
        }
        val blocks = parseBlocks(existing.contentJson)
        val last = blocks.lastOrNull()
        if (last != null && last[KIND]?.jsonPrimitive?.contentOrNull == BLOCK_TOOL_OUTPUT) {
            val accumulated = last["text"]?.jsonPrimitive?.contentOrNull.orEmpty() + chunk
            blocks[blocks.size - 1] = outputBlock(accumulated)
        } else {
            blocks.add(outputBlock(chunk))
        }
        daos.messages.upsertMessage(existing.copy(contentJson = blocksToJson(blocks), updatedAt = now()))
    }

    private fun applyToolCompleted(daos: ProjectionDaos, event: ProtocolEvent, p: ToolCompletedPayload) {
        val terminal = when (p.status) {
            "error", STATUS_FAILED -> STATUS_FAILED
            else -> STATUS_COMPLETE
        }
        val existing = daos.messages.getByHistoryItemId(p.toolUseId)
        val blocks = existing?.let { parseBlocks(it.contentJson) } ?: mutableListOf()
        blocks.removeAll { it[KIND]?.jsonPrimitive?.contentOrNull == BLOCK_TOOL_RESULT }
        blocks.add(
            buildJsonObject {
                put(KIND, BLOCK_TOOL_RESULT)
                put("toolUseId", p.toolUseId)
                put("content", p.output?.let(::outputText) ?: "")
            },
        )
        upsertBlocks(
            daos, event, stableId = p.toolUseId, role = ROLE_TOOL, status = terminal,
            sourceId = p.toolUseId, blocks = blocks,
            createdAt = existing?.createdAt,
            position = existing?.position,
        )
    }

    private fun applyPermissionResolved(daos: ProjectionDaos, event: ProtocolEvent, p: PermissionResolvedPayload) {
        val existing = daos.messages.getByHistoryItemId(p.permissionRequestId) ?: return
        val blocks = parseBlocks(existing.contentJson)
        blocks.removeAll { it[KIND]?.jsonPrimitive?.contentOrNull == "permission_resolution" }
        blocks.add(
            buildJsonObject {
                put(KIND, "permission_resolution")
                put("behavior", p.behavior)
                p.reason?.let { put("reason", it) }
                p.message?.let { put("message", it) }
            },
        )
        daos.messages.upsertMessage(
            existing.copy(contentJson = blocksToJson(blocks), status = STATUS_RESOLVED, updatedAt = now()),
        )
    }

    // -------------------------------------------------------------------
    // Shared row helpers
    // -------------------------------------------------------------------

    /**
     * Upsert a row on its STABLE source id. An existing row keeps its
     * original position and createdAt (stable ordering); a new row lands at
     * max(position)+1.
     */
    private fun upsertBlocks(
        daos: ProjectionDaos,
        event: ProtocolEvent,
        stableId: String,
        role: String,
        status: String,
        sourceId: String,
        blocks: List<JsonObject>,
        createdAt: String? = null,
        position: Long? = null,
    ) {
        val existing = daos.messages.getByHistoryItemId(stableId)
        val row = MessageEntity(
            historyItemId = stableId,
            sessionId = event.sessionId,
            historyRevision = existing?.historyRevision ?: REVISION_LIVE,
            role = existing?.role ?: role,
            contentJson = blocksToJson(blocks),
            sourceIdsJson = existing?.sourceIdsJson ?: """["$sourceId"]""",
            status = status,
            requestId = existing?.requestId,
            position = position ?: existing?.position ?: ((daos.messages.maxPosition(event.sessionId) ?: -1L) + 1),
            createdAt = createdAt ?: existing?.createdAt ?: event.timestamp,
            updatedAt = now(),
        )
        daos.messages.upsertMessage(row)
    }

    private fun upsertSessionStatus(daos: ProjectionDaos, sessionId: String, status: String) {
        val session = daos.sessions.getBySessionId(sessionId)
            ?: SessionEntity(
                sessionId = sessionId,
                projectId = "",
                displayName = "",
                status = status,
                lastAckEventId = null,
                updatedAt = now(),
            )
        daos.sessions.upsert(session.copy(status = status, updatedAt = now()))
    }

    // -------------------------------------------------------------------
    // Block (de)serialization
    // -------------------------------------------------------------------

    private fun textBlocks(text: String): List<JsonObject> = listOf(
        buildJsonObject {
            put(KIND, "text")
            put("text", text)
        },
    )

    private fun noteBlock(text: String): JsonObject = buildJsonObject {
        put(KIND, "system_note")
        put("text", text)
    }

    private fun outputBlock(text: String): JsonObject = buildJsonObject {
        put(KIND, BLOCK_TOOL_OUTPUT)
        put("text", text)
    }

    private fun blocksToJson(blocks: List<JsonObject>): String = JsonArray(blocks).toString()

    private fun parseBlocks(contentJson: String): MutableList<JsonObject> =
        runCatching {
            (lenientJson.parseToJsonElement(contentJson) as? JsonArray)
                ?.filterIsInstance<JsonObject>()
                ?.toMutableList()
        }.getOrNull() ?: mutableListOf()

    private fun accumulatedText(row: MessageEntity): String =
        parseBlocks(row.contentJson).lastOrNull { it[KIND]?.jsonPrimitive?.contentOrNull == "text" }
            ?.get("text")?.jsonPrimitive?.contentOrNull ?: ""

    /** Claude stream-json frame → delta text (content_block_delta / text_delta). */
    private fun extractDeltaText(frame: JsonObject?): String {
        if (frame == null) return ""
        if (frame["type"]?.jsonPrimitive?.contentOrNull != "content_block_delta") return ""
        val delta = frame["delta"] as? JsonObject ?: return ""
        if (delta["type"]?.jsonPrimitive?.contentOrNull != "text_delta") return ""
        return delta["text"]?.jsonPrimitive?.contentOrNull ?: ""
    }

    /**
     * Completed assistant message → text block + one tool_use block per tool
     * call. GLM-class models emit tool-only turns (content is all tool_use);
     * dropping the tool blocks would leave a blank row that renders as an
     * empty bubble.
     */
    private fun messageBlocks(message: JsonElement?): List<JsonObject> {
        val content = (message as? JsonObject)?.get("content") as? JsonArray ?: return textBlocks("")
        val text = StringBuilder()
        val toolUses = mutableListOf<JsonObject>()
        for (item in content.filterIsInstance<JsonObject>()) {
            when (item["type"]?.jsonPrimitive?.contentOrNull) {
                "text" -> text.append(item["text"]?.jsonPrimitive?.contentOrNull ?: "")
                "tool_use" -> toolUses.add(
                    buildJsonObject {
                        put(KIND, BLOCK_TOOL_USE)
                        item["id"]?.jsonPrimitive?.contentOrNull?.let { put("toolUseId", it) }
                        item["name"]?.jsonPrimitive?.contentOrNull?.let { put("toolName", it) }
                        item["input"]?.let { put("input", it) }
                    },
                )
            }
        }
        return listOf(textBlocks(text.toString()).single()) + toolUses
    }

    private fun outputText(output: JsonElement): String =
        (output as? JsonPrimitive)?.contentOrNull ?: output.toString()

    private fun fallbackStreamingId(sessionId: String) = "$FALLBACK_PREFIX$sessionId"

    private fun systemNoteId(event: ProtocolEvent) = "event-${event.eventId.value}"

    // -------------------------------------------------------------------
    // Local payload data classes (App-side contract for loose v1 payloads)
    // -------------------------------------------------------------------

    /** Lenient decoding: loose v1 payloads evolve independently of the app. */
    private val lenientJson = Json { ignoreUnknownKeys = true }

    private inline fun <reified T> parse(payload: JsonElement): T? =
        runCatching { lenientJson.decodeFromJsonElement<T>(payload) }.getOrNull()

    @Serializable
    data class SessionStateChangedPayload(
        val previousStatus: String? = null,
        val status: String,
    )

    @Serializable
    data class AssistantMessageDeltaPayload(
        val messageUuid: String? = null,
        val frame: JsonElement? = null,
    )

    @Serializable
    data class AssistantMessageCompletedPayload(
        val messageUuid: String? = null,
        val message: JsonElement? = null,
    )

    @Serializable
    data class ToolStartedPayload(
        val toolUseId: String,
        val toolName: String? = null,
        val input: JsonElement? = null,
    )

    @Serializable
    data class ToolOutputDeltaPayload(
        val toolUseId: String,
        val delta: String? = null,
        val text: String? = null,
    )

    @Serializable
    data class ToolCompletedPayload(
        val toolUseId: String,
        val status: String? = null,
        val output: JsonElement? = null,
    )

    @Serializable
    data class PermissionRequestedPayload(
        val permissionRequestId: String,
        val toolName: String? = null,
        val input: JsonElement? = null,
        val toolUseId: String? = null,
        val requestedAt: String? = null,
        val expiresAt: String? = null,
        val displayCategory: String? = null,
    )

    @Serializable
    data class PermissionResolvedPayload(
        val permissionRequestId: String,
        val behavior: String,
        val reason: String? = null,
        val message: String? = null,
    )

    @Serializable
    data class ProcessStderrSummaryPayload(
        val summary: String? = null,
        val text: String? = null,
    )

    @Serializable
    data class SessionInterruptedPayload(val reason: String? = null)

    @Serializable
    data class SessionFailedPayload(
        val message: String? = null,
        val error: JsonElement? = null,
    )

    companion object {
        const val KIND = "kind"
        const val BLOCK_TOOL_USE = "tool_use"
        const val BLOCK_TOOL_OUTPUT = "tool_output"
        const val BLOCK_TOOL_RESULT = "tool_result"

        const val ROLE_ASSISTANT = "assistant"
        const val ROLE_TOOL = "tool"
        const val ROLE_SYSTEM = "system"
        const val ROLE_PERMISSION = "permission"

        const val STATUS_STREAMING = "streaming"
        const val STATUS_COMPLETE = "complete"
        const val STATUS_FAILED = "failed"
        const val STATUS_RUNNING = "running"
        const val STATUS_PENDING = "pending"
        const val STATUS_RESOLVED = "resolved"
        const val STATUS_INTERRUPTED = "interrupted"

        /** Placeholder lifecycle state of a minimal cursor row (§8.5). */
        const val STATUS_UNKNOWN = "unknown"

        const val REVISION_LIVE = "live"
        const val FALLBACK_PREFIX = "streaming-assistant:"
    }
}

/**
 * The DAO bundle a reducer call operates on. Callers construct it from an
 * [dev.clauderemote.android.data.local.AppDatabase] and run [EventReducer.apply]
 * inside one Room transaction (see SessionRepository).
 */
class ProjectionDaos(
    val sessions: SessionDao,
    val messages: MessageDao,
    val commands: CommandEventDao,
    val pendingEvents: PendingLiveEventDao,
)
