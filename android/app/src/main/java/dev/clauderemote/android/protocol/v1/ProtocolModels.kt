@file:OptIn(ExperimentalSerializationApi::class)

package dev.clauderemote.android.protocol.v1

import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * Protocol v1 Kotlin models, mirroring contracts/v1/{command,event,response}.schema.json
 * (the cross-language source of truth; the bridge's schema-drift test keeps the
 * TypeScript types aligned with the same files).
 *
 * Wire enums: 16 command types (Section 8.1), 12 event types (Section 8.4),
 * 7 command statuses (Section 8.3/8.4). eventId and the other uint64String
 * fields ride the wire as decimal strings and parse into Kotlin Long.
 */
const val PROTOCOL_VERSION = "claude-remote.v1"

/**
 * Shared Json for all protocol v1 encoding/decoding.
 *
 * - [classDiscriminator] "commandType" makes the sealed [ProtocolCommand]
 *   hierarchy discriminate exactly like the schema's allOf if/then chain.
 * - [Json.ignoreUnknownKeys] stays false to mirror additionalProperties: false.
 * - [encodeDefaults] true keeps required envelope fields (protocolVersion,
 *   payload, explicit sessionId:null) on the wire; optional fields opt out
 *   of default encoding with @EncodeDefault(NEVER).
 */
object ProtocolJson {
    val json: Json = Json {
        classDiscriminator = "commandType"
        encodeDefaults = true
        ignoreUnknownKeys = false
    }
}

/**
 * Parses decimal-stringified integers (schema pattern ^[0-9]{1,20}$, the full
 * unsigned 64-bit space). The Android client is bounded by the signed Kotlin
 * Long, so values above Long.MAX_VALUE are rejected as protocol errors
 * instead of wrapping around.
 */
internal object DecimalStringLong {
    private val PATTERN = Regex("^[0-9]{1,20}$")

    fun parse(raw: String): Long {
        if (!PATTERN.matches(raw)) {
            throw SerializationException("expected a decimal string of 1-20 digits, got: \"$raw\"")
        }
        return raw.toLongOrNull()
            ?: throw SerializationException("value exceeds the signed 64-bit Long range: \"$raw\"")
    }

    fun format(value: Long): String = value.toString()
}

/** Serializes a Long as a decimal string (uint64String in the schemas). */
object DecimalStringLongSerializer : KSerializer<Long> {
    override val descriptor =
        PrimitiveSerialDescriptor("dev.clauderemote.android.protocol.v1.decimalStringLong", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Long = DecimalStringLong.parse(decoder.decodeString())

    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeString(DecimalStringLong.format(value))
}

/**
 * Event identifier: decimal-stringified on the wire, parsed to a Long on
 * decode. 20-digit values above Long.MAX_VALUE (e.g. the uint64 maximum
 * 18446744073709551615) are rejected.
 */
@Serializable(with = EventIdSerializer::class)
@JvmInline
value class EventId(val value: Long) {
    companion object {
        fun parse(raw: String): EventId = EventId(DecimalStringLong.parse(raw))
    }
}

object EventIdSerializer : KSerializer<EventId> {
    override val descriptor =
        PrimitiveSerialDescriptor("dev.clauderemote.android.protocol.v1.EventId", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): EventId = EventId.parse(decoder.decodeString())

    override fun serialize(encoder: Encoder, value: EventId) =
        encoder.encodeString(DecimalStringLong.format(value.value))
}

/**
 * RFC3339 date-time (format "date-time" in the schemas): accepted with a
 * trailing Z or an explicit +/-HH:MM offset, mirroring the bridge validator.
 * Invalid values fail fast as SerializationException in both directions.
 */
object Rfc3339Serializer : KSerializer<String> {
    override val descriptor =
        PrimitiveSerialDescriptor("dev.clauderemote.android.protocol.v1.rfc3339", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): String = validate(decoder.decodeString())

    override fun serialize(encoder: Encoder, value: String) = encoder.encodeString(validate(value))

    private fun validate(raw: String): String {
        try {
            OffsetDateTime.parse(raw)
        } catch (e: DateTimeParseException) {
            throw SerializationException("expected an RFC3339 date-time, got: \"$raw\"", e)
        }
        return raw
    }
}

// ---------------------------------------------------------------------------
// Wire enums
// ---------------------------------------------------------------------------

/** Section 8.1 commandType enum; values mirror the sealed @SerialName discriminators. */
enum class CommandType(val wire: String) {
    SESSION_LIST("session.list"),
    SESSION_SCAN_IMPORTS("session.scan_imports"),
    SESSION_IMPORT("session.import"),
    SESSION_CREATE("session.create"),
    SESSION_RESUME("session.resume"),
    SESSION_STOP("session.stop"),
    SESSION_RELEASE("session.release"),
    SESSION_STATE_GET("session.state.get"),
    SNAPSHOT_BEGIN("session.snapshot.begin"),
    SNAPSHOT_PAGE("session.snapshot.page"),
    SNAPSHOT_COMMIT("session.snapshot.commit"),
    MESSAGE_SEND("message.send"),
    COMMAND_CANCEL("command.cancel"),
    COMMAND_RETRY_INDETERMINATE("command.retry_indeterminate"),
    PERMISSION_RESOLVE("permission.resolve"),
    EVENTS_ACK("events.ack"),
}

/** Section 8.4 eventType enum (12 values). */
enum class EventType {
    @SerialName("session.state.changed") SESSION_STATE_CHANGED,
    @SerialName("command.status.changed") COMMAND_STATUS_CHANGED,
    @SerialName("assistant.message.delta") ASSISTANT_MESSAGE_DELTA,
    @SerialName("assistant.message.completed") ASSISTANT_MESSAGE_COMPLETED,
    @SerialName("tool.started") TOOL_STARTED,
    @SerialName("tool.output.delta") TOOL_OUTPUT_DELTA,
    @SerialName("tool.completed") TOOL_COMPLETED,
    @SerialName("permission.requested") PERMISSION_REQUESTED,
    @SerialName("permission.resolved") PERMISSION_RESOLVED,
    @SerialName("process.stderr.summary") PROCESS_STDERR_SUMMARY,
    @SerialName("session.interrupted") SESSION_INTERRUPTED,
    @SerialName("session.failed") SESSION_FAILED,
}

/** Section 8.3/8.4 commandStatus enum (7 values). */
enum class CommandStatus {
    @SerialName("accepted") ACCEPTED,
    @SerialName("dispatching") DISPATCHING,
    @SerialName("dispatched") DISPATCHED,
    @SerialName("indeterminate") INDETERMINATE,
    @SerialName("interrupted") INTERRUPTED,
    @SerialName("completed") COMPLETED,
    @SerialName("failed") FAILED,
}

/** Section 8.3 responseType enum. */
enum class ResponseType {
    @SerialName("command.status") COMMAND_STATUS,
    @SerialName("command.error") COMMAND_ERROR,
}

/** permission.resolve decision enum. */
enum class PermissionDecision {
    @SerialName("allow") ALLOW,
    @SerialName("deny") DENY,
}

// ---------------------------------------------------------------------------
// Command payloads (Section 8.1 $defs)
// ---------------------------------------------------------------------------

@Serializable
object SessionListPayload

@Serializable
data class SessionScanImportsPayload(val projectId: String)

@Serializable
data class SessionImportPayload(val sessionId: String, val projectId: String)

@Serializable
data class SessionCreatePayload(
    val projectId: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val displayName: String? = null,
)

/** Shared by session.resume/stop/release/state.get/snapshot.begin. */
@Serializable
data class SessionRefPayload(val sessionId: String)

@Serializable
data class SessionSnapshotPagePayload(val sessionId: String, val cursor: String)

@Serializable
data class SessionSnapshotCommitPayload(
    val sessionId: String,
    val snapshotId: String,
    val historyRevision: String,
    @Serializable(with = DecimalStringLongSerializer::class) val deliveryWatermark: Long,
    val idempotencyKey: String,
)

@Serializable
data class MessageSendPayload(val sessionId: String, val text: String)

/** Shared by command.cancel and command.retry_indeterminate. */
@Serializable
data class CommandRefPayload(val requestId: String)

@Serializable
data class PermissionResolvePayload(
    val permissionRequestId: String,
    val sessionId: String,
    val decision: PermissionDecision,
)

@Serializable
data class EventsAckPayload(
    val sessionId: String,
    @Serializable(with = DecimalStringLongSerializer::class) val lastEventId: Long,
)

// ---------------------------------------------------------------------------
// Command envelope (Section 8.1), discriminated on commandType
// ---------------------------------------------------------------------------

/**
 * Command envelope sent from Android to the bridge. The sealed hierarchy plus
 * ProtocolJson's classDiscriminator reproduce the schema's commandType
 * if/then payload dispatch; unknown commandType values fail to decode.
 * The bridge additionally enforces format constraints (uuid, minLength,
 * 256 KiB cap) at its validator boundary.
 */
@Serializable
sealed class ProtocolCommand {
    abstract val protocolVersion: String
    abstract val requestId: String
    abstract val idempotencyKey: String

    /** Null for global commands (session.list, scan_imports, import, create). */
    abstract val sessionId: String?

    abstract val sentAt: String

    /** Wire discriminator of this variant (matches [CommandType.wire]). */
    abstract val commandType: CommandType
}

@Serializable
@SerialName("session.list")
data class SessionListCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionListPayload = SessionListPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SESSION_LIST
}

@Serializable
@SerialName("session.scan_imports")
data class SessionScanImportsCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionScanImportsPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SESSION_SCAN_IMPORTS
}

@Serializable
@SerialName("session.import")
data class SessionImportCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionImportPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SESSION_IMPORT
}

@Serializable
@SerialName("session.create")
data class SessionCreateCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionCreatePayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SESSION_CREATE
}

@Serializable
@SerialName("session.resume")
data class SessionResumeCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionRefPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SESSION_RESUME
}

@Serializable
@SerialName("session.stop")
data class SessionStopCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionRefPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SESSION_STOP
}

@Serializable
@SerialName("session.release")
data class SessionReleaseCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionRefPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SESSION_RELEASE
}

@Serializable
@SerialName("session.state.get")
data class SessionStateGetCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionRefPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SESSION_STATE_GET
}

@Serializable
@SerialName("session.snapshot.begin")
data class SessionSnapshotBeginCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionRefPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SNAPSHOT_BEGIN
}

@Serializable
@SerialName("session.snapshot.page")
data class SessionSnapshotPageCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionSnapshotPagePayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SNAPSHOT_PAGE
}

@Serializable
@SerialName("session.snapshot.commit")
data class SessionSnapshotCommitCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: SessionSnapshotCommitPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.SNAPSHOT_COMMIT
}

@Serializable
@SerialName("message.send")
data class MessageSendCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: MessageSendPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.MESSAGE_SEND
}

@Serializable
@SerialName("command.cancel")
data class CommandCancelCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: CommandRefPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.COMMAND_CANCEL
}

@Serializable
@SerialName("command.retry_indeterminate")
data class CommandRetryIndeterminateCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: CommandRefPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.COMMAND_RETRY_INDETERMINATE
}

@Serializable
@SerialName("permission.resolve")
data class PermissionResolveCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: PermissionResolvePayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.PERMISSION_RESOLVE
}

@Serializable
@SerialName("events.ack")
data class EventsAckCommand(
    override val protocolVersion: String = PROTOCOL_VERSION,
    override val requestId: String,
    override val idempotencyKey: String,
    override val sessionId: String? = null,
    @Serializable(with = Rfc3339Serializer::class) override val sentAt: String,
    val payload: EventsAckPayload,
) : ProtocolCommand() {
    override val commandType: CommandType get() = CommandType.EVENTS_ACK
}

// ---------------------------------------------------------------------------
// Response (Section 8.3)
// ---------------------------------------------------------------------------

/** Error block shared by responses and command.status.changed event payloads. */
@Serializable
data class ResponseError(
    val code: String,
    val message: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val retryable: Boolean? = null,
)

/**
 * Response envelope returned by the bridge. The schema's allOf/if-then
 * conditionals mean command.status always carries commandStatus (and an
 * optional result) while command.error always carries error; here both are
 * nullable and callers branch on [responseType].
 */
@Serializable
data class ProtocolResponse(
    val protocolVersion: String = PROTOCOL_VERSION,
    val requestId: String,
    val responseType: ResponseType,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val commandStatus: CommandStatus? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val result: JsonElement? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val error: ResponseError? = null,
)

// ---------------------------------------------------------------------------
// Event (Section 8.4)
// ---------------------------------------------------------------------------

/**
 * Typed view of the command.status.changed event payload. Per the schema,
 * commandType is a free string (minLength 1), not restricted to the 16
 * command types.
 */
@Serializable
data class CommandStatusChangedPayload(
    val requestId: String,
    val idempotencyKey: String,
    val commandType: String,
    val commandStatus: CommandStatus,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val result: JsonElement? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val error: ResponseError? = null,
)

/**
 * Event envelope streamed from the bridge. Other than command.status.changed,
 * payload shapes are intentionally loose in v1 Chunk 2, so [payload] stays a
 * JsonElement; decode it with
 * ProtocolJson.json.decodeFromJsonElement(CommandStatusChangedPayload.serializer(), ...).
 */
@Serializable
data class ProtocolEvent(
    val protocolVersion: String = PROTOCOL_VERSION,
    val eventId: EventId,
    val sessionId: String,
    val eventType: EventType,
    @Serializable(with = Rfc3339Serializer::class) val timestamp: String,
    val payload: JsonElement,
)
