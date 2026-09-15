package dev.clauderemote.android.protocol.v1

import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Protocol v1 Kotlin model tests, mirroring the contracts/v1 JSON Schemas and
 * the bridge's validator.test.ts: every command variant round-trips with the
 * commandType discriminator and protocolVersion const; eventId parses from
 * decimal strings into Long and rejects the unsigned-64 space above
 * Long.MAX_VALUE (the client is Long-bounded); sentAt/timestamp are RFC3339
 * with Z or an explicit offset; response conditional shapes hold.
 */
class ProtocolModelsTest {

    private val uuid = "019122ab-c100-7000-8000-000000000001"
    private val uuid2 = "019122ab-c100-7000-8000-000000000002"
    private val rfc3339Z = "2026-08-02T12:00:00Z"
    private val rfc3339Offset = "2026-08-02T12:00:00+08:00"

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    private fun roundTrip(command: ProtocolCommand): JsonObject {
        val text = ProtocolJson.json.encodeToString(ProtocolCommand.serializer(), command)
        val tree = ProtocolJson.json.parseToJsonElement(text).jsonObject
        assertEquals(command, ProtocolJson.json.decodeFromString(ProtocolCommand.serializer(), text))
        return tree
    }

    private fun roundTrip(response: ProtocolResponse): JsonObject {
        val text = ProtocolJson.json.encodeToString(ProtocolResponse.serializer(), response)
        val tree = ProtocolJson.json.parseToJsonElement(text).jsonObject
        assertEquals(response, ProtocolJson.json.decodeFromString(ProtocolResponse.serializer(), text))
        return tree
    }

    private fun commandJson(
        commandType: String = "session.list",
        sentAt: String = rfc3339Z,
    ): String =
        """{"protocolVersion":"claude-remote.v1","requestId":"$uuid","idempotencyKey":"idem-1",""" +
            """"commandType":"$commandType","sessionId":null,"sentAt":"$sentAt","payload":{}}"""

    private fun eventJson(
        eventId: String = "1234567890123456789",
        eventType: String = "session.state.changed",
        timestamp: String = rfc3339Z,
    ): String =
        """{"protocolVersion":"claude-remote.v1","eventId":"$eventId","sessionId":"$uuid",""" +
            """"eventType":"$eventType","timestamp":"$timestamp","payload":{"state":"running"}}"""

    // -------------------------------------------------------------------
    // Commands: envelope + all 16 payload variants
    // -------------------------------------------------------------------

    @Test
    fun everyCommandVariantRoundTripsWithDiscriminatorAndProtocolVersion() {
        val cases: List<Pair<ProtocolCommand, String>> = listOf(
            ProjectListCommand(requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z) to "project.list",
            SessionListCommand(requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z) to "session.list",
            SessionScanImportsCommand(
                requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z,
                payload = SessionScanImportsPayload(projectId = uuid2),
            ) to "session.scan_imports",
            SessionImportCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = SessionImportPayload(sessionId = uuid, projectId = uuid2),
            ) to "session.import",
            SessionCreateCommand(
                requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z,
                payload = SessionCreatePayload(projectId = uuid2),
            ) to "session.create",
            SessionCreateCommand(
                requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z,
                payload = SessionCreatePayload(projectId = uuid2, displayName = "chat"),
            ) to "session.create",
            SessionResumeCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = SessionRefPayload(sessionId = uuid),
            ) to "session.resume",
            SessionStopCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = SessionRefPayload(sessionId = uuid),
            ) to "session.stop",
            SessionReleaseCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = SessionRefPayload(sessionId = uuid),
            ) to "session.release",
            SessionStateGetCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = SessionRefPayload(sessionId = uuid),
            ) to "session.state.get",
            SessionSnapshotBeginCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = SessionRefPayload(sessionId = uuid),
            ) to "session.snapshot.begin",
            SessionSnapshotPageCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = SessionSnapshotPagePayload(sessionId = uuid, cursor = "abc"),
            ) to "session.snapshot.page",
            SessionSnapshotCommitCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = SessionSnapshotCommitPayload(
                    sessionId = uuid,
                    snapshotId = "snap-1",
                    historyRevision = "rev-1",
                    deliveryWatermark = Long.MAX_VALUE,
                    idempotencyKey = "idem-2",
                ),
            ) to "session.snapshot.commit",
            MessageSendCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = MessageSendPayload(sessionId = uuid, text = "hello"),
            ) to "message.send",
            CommandCancelCommand(
                requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z,
                payload = CommandRefPayload(requestId = uuid2),
            ) to "command.cancel",
            CommandRetryIndeterminateCommand(
                requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z,
                payload = CommandRefPayload(requestId = uuid2),
            ) to "command.retry_indeterminate",
            PermissionResolveCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = PermissionResolvePayload(
                    permissionRequestId = "perm-1",
                    sessionId = uuid,
                    decision = PermissionDecision.DENY,
                ),
            ) to "permission.resolve",
            EventsAckCommand(
                requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                payload = EventsAckPayload(sessionId = uuid, lastEventId = 42L),
            ) to "events.ack",
        )
        assertEquals(18, cases.size) // 17 variants, session.create twice (displayName optional)

        for ((command, wire) in cases) {
            val tree = roundTrip(command)
            assertEquals("claude-remote.v1", tree.getValue("protocolVersion").jsonPrimitive.content)
            assertEquals(wire, tree.getValue("commandType").jsonPrimitive.content)
            assertEquals(uuid, tree.getValue("requestId").jsonPrimitive.content)
            assertEquals("idem-1", tree.getValue("idempotencyKey").jsonPrimitive.content)
            assertEquals(rfc3339Z, tree.getValue("sentAt").jsonPrimitive.content)
            assertEquals(wire, command.commandType.wire)
        }

        // uint64String fields ride the wire as decimal strings.
        val commitTree = roundTrip(cases.first { it.second == "session.snapshot.commit" }.first)
        assertEquals(
            "9223372036854775807",
            commitTree.getValue("payload").jsonObject.getValue("deliveryWatermark").jsonPrimitive.content,
        )
        val ackTree = roundTrip(cases.first { it.second == "events.ack" }.first)
        assertEquals(
            "42",
            ackTree.getValue("payload").jsonObject.getValue("lastEventId").jsonPrimitive.content,
        )
    }

    @Test
    fun commandTypeEnumMirrorsTheSeventeenSchemaWireNames() {
        val expected = setOf(
            "project.list",
            "session.list",
            "session.scan_imports",
            "session.import",
            "session.create",
            "session.resume",
            "session.stop",
            "session.release",
            "session.state.get",
            "session.snapshot.begin",
            "session.snapshot.page",
            "session.snapshot.commit",
            "message.send",
            "command.cancel",
            "command.retry_indeterminate",
            "permission.resolve",
            "events.ack",
        )
        assertEquals(17, CommandType.values().size)
        assertEquals(expected, CommandType.values().map { it.wire }.toSet())
    }

    @Test
    fun unknownCommandTypeIsRejected() {
        try {
            ProtocolJson.json.decodeFromString(
                ProtocolCommand.serializer(),
                commandJson(commandType = "session.explode"),
            )
            fail("expected unknown commandType to be rejected")
        } catch (expected: SerializationException) {
        }
    }

    @Test
    fun unknownEnvelopeFieldIsRejected() {
        val extraField =
            """{"protocolVersion":"claude-remote.v1","requestId":"$uuid","idempotencyKey":"idem-1",""" +
                """"commandType":"session.list","sessionId":null,"sentAt":"$rfc3339Z","payload":{},"extra":1}"""
        try {
            ProtocolJson.json.decodeFromString(ProtocolCommand.serializer(), extraField)
            fail("expected unknown envelope field to be rejected")
        } catch (expected: SerializationException) {
        }
    }

    @Test
    fun sentAtAcceptsRfc3339WithZOrExplicitOffset() {
        val offset = SessionListCommand(requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Offset)
        val text = ProtocolJson.json.encodeToString(ProtocolCommand.serializer(), offset)
        val decoded = ProtocolJson.json.decodeFromString(ProtocolCommand.serializer(), text)
        assertEquals(rfc3339Offset, decoded.sentAt)

        val fromZ = ProtocolJson.json.decodeFromString(
            ProtocolCommand.serializer(),
            commandJson(sentAt = rfc3339Z),
        )
        assertEquals(rfc3339Z, fromZ.sentAt)
    }

    @Test
    fun sentAtRejectsNonRfc3339Values() {
        listOf("2026-08-02 12:00:00", "not-a-date").forEach { bad ->
            try {
                ProtocolJson.json.decodeFromString(ProtocolCommand.serializer(), commandJson(sentAt = bad))
                fail("expected sentAt '$bad' to be rejected")
            } catch (expected: SerializationException) {
            }
        }
    }

    @Test
    fun sessionIdNullIsEncodedExplicitlyForGlobalCommands() {
        val tree = roundTrip(SessionListCommand(requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z))
        assertTrue("sessionId must be present as null, not omitted", tree.getValue("sessionId") is JsonNull)
    }

    @Test
    fun optionalDisplayNameOmittedWhenNull() {
        val without = roundTrip(
            SessionCreateCommand(
                requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z,
                payload = SessionCreatePayload(projectId = uuid2),
            ),
        )
        assertFalse(without.getValue("payload").jsonObject.containsKey("displayName"))
        val with = roundTrip(
            SessionCreateCommand(
                requestId = uuid, idempotencyKey = "idem-1", sentAt = rfc3339Z,
                payload = SessionCreatePayload(projectId = uuid2, displayName = "chat"),
            ),
        )
        assertEquals(
            "chat",
            with.getValue("payload").jsonObject.getValue("displayName").jsonPrimitive.content,
        )
    }

    @Test
    fun permissionDecisionRoundTripsBothWays() {
        PermissionDecision.values().forEach { decision ->
            val expectedWire = if (decision == PermissionDecision.ALLOW) "allow" else "deny"
            val tree = roundTrip(
                PermissionResolveCommand(
                    requestId = uuid, idempotencyKey = "idem-1", sessionId = uuid, sentAt = rfc3339Z,
                    payload = PermissionResolvePayload(
                        permissionRequestId = "perm-1",
                        sessionId = uuid,
                        decision = decision,
                    ),
                ),
            )
            assertEquals(
                expectedWire,
                tree.getValue("payload").jsonObject.getValue("decision").jsonPrimitive.content,
            )
        }
    }

    // -------------------------------------------------------------------
    // eventId: decimal-string <-> Long
    // -------------------------------------------------------------------

    @Test
    fun eventIdParsesNineteenDigitDecimalString() {
        val decoded = ProtocolJson.json.decodeFromString(
            ProtocolEvent.serializer(),
            eventJson(eventId = "9223372036854775807"),
        )
        assertEquals(Long.MAX_VALUE, decoded.eventId.value)
    }

    @Test
    fun eventIdRejectsValuesAboveSignedLongRange() {
        // The schema pattern allows 20 digits (uint64 space) but the Android
        // client is bounded by the signed Kotlin Long, so these are protocol errors.
        listOf("99999999999999999999", "18446744073709551615").forEach { raw ->
            try {
                ProtocolJson.json.decodeFromString(ProtocolEvent.serializer(), eventJson(eventId = raw))
                fail("expected eventId '$raw' to be rejected as above Long.MAX_VALUE")
            } catch (expected: SerializationException) {
            }
        }
    }

    @Test
    fun eventIdRejectsNonDecimalStrings() {
        listOf("0x10", "1.5", "-5", "").forEach { raw ->
            try {
                ProtocolJson.json.decodeFromString(ProtocolEvent.serializer(), eventJson(eventId = raw))
                fail("expected eventId '$raw' to be rejected")
            } catch (expected: SerializationException) {
            }
        }
    }

    @Test
    fun eventIdSerializesBackToDecimalString() {
        val event = ProtocolEvent(
            eventId = EventId(42L),
            sessionId = uuid,
            eventType = EventType.SESSION_STATE_CHANGED,
            timestamp = rfc3339Z,
            payload = ProtocolJson.json.parseToJsonElement("""{"state":"running"}"""),
        )
        val tree = ProtocolJson.json.encodeToJsonElement(ProtocolEvent.serializer(), event).jsonObject
        assertEquals("42", tree.getValue("eventId").jsonPrimitive.content)
    }

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------

    @Test
    fun eventRoundTripsWithLoosePayload() {
        val event = ProtocolEvent(
            eventId = EventId(1234567890123456789L),
            sessionId = uuid,
            eventType = EventType.SESSION_STATE_CHANGED,
            timestamp = rfc3339Z,
            payload = ProtocolJson.json.parseToJsonElement("""{"state":"running"}"""),
        )
        assertEquals(event, ProtocolJson.json.decodeFromString(ProtocolEvent.serializer(), eventJson()))
        assertEquals(1234567890123456789L, event.eventId.value)
    }

    @Test
    fun everyEventTypeRoundTrips() {
        assertEquals(12, EventType.values().size)
        EventType.values().forEach { type ->
            val event = ProtocolEvent(
                eventId = EventId(1L),
                sessionId = uuid,
                eventType = type,
                timestamp = rfc3339Z,
                payload = JsonObject(emptyMap()),
            )
            val text = ProtocolJson.json.encodeToString(ProtocolEvent.serializer(), event)
            assertEquals(type, ProtocolJson.json.decodeFromString(ProtocolEvent.serializer(), text).eventType)
        }
    }

    @Test
    fun eventRejectsUnknownEventType() {
        try {
            ProtocolJson.json.decodeFromString(ProtocolEvent.serializer(), eventJson(eventType = "magic.happened"))
            fail("expected unknown eventType to be rejected")
        } catch (expected: SerializationException) {
        }
    }

    @Test
    fun eventTimestampAcceptsRfc3339Offset() {
        val decoded = ProtocolJson.json.decodeFromString(
            ProtocolEvent.serializer(),
            eventJson(timestamp = rfc3339Offset),
        )
        assertEquals(rfc3339Offset, decoded.timestamp)
    }

    @Test
    fun commandStatusChangedPayloadDecodesAsTypedView() {
        val payload = ProtocolJson.json.decodeFromJsonElement(
            CommandStatusChangedPayload.serializer(),
            ProtocolJson.json.parseToJsonElement(
                """{"requestId":"$uuid2","idempotencyKey":"idem-1",""" +
                    """"commandType":"session.resume","commandStatus":"dispatched","result":{"queued":true}}""",
            ),
        )
        assertEquals(uuid2, payload.requestId)
        assertEquals("idem-1", payload.idempotencyKey)
        assertEquals("session.resume", payload.commandType) // free string per schema, not the 16-enum
        assertEquals(CommandStatus.DISPATCHED, payload.commandStatus)
        assertEquals("""{"queued":true}""", payload.result.toString())

        val failed = ProtocolJson.json.decodeFromJsonElement(
            CommandStatusChangedPayload.serializer(),
            ProtocolJson.json.parseToJsonElement(
                """{"requestId":"$uuid2","idempotencyKey":"idem-1","commandType":"message.send",""" +
                    """"commandStatus":"failed","error":{"code":"E_BAD","message":"bad","retryable":false}}""",
            ),
        )
        assertEquals(CommandStatus.FAILED, failed.commandStatus)
        assertEquals(ResponseError(code = "E_BAD", message = "bad", retryable = false), failed.error)

        try {
            ProtocolJson.json.decodeFromJsonElement(
                CommandStatusChangedPayload.serializer(),
                ProtocolJson.json.parseToJsonElement(
                    """{"requestId":"$uuid2","idempotencyKey":"idem-1",""" +
                        """"commandType":"x","commandStatus":"weird"}""",
                ),
            )
            fail("expected invalid commandStatus to be rejected")
        } catch (expected: SerializationException) {
        }
    }

    // -------------------------------------------------------------------
    // Responses
    // -------------------------------------------------------------------

    @Test
    fun everyCommandStatusRoundTrips() {
        assertEquals(7, CommandStatus.values().size)
        CommandStatus.values().forEach { status ->
            val response = ProtocolResponse(
                requestId = uuid,
                responseType = ResponseType.COMMAND_STATUS,
                commandStatus = status,
            )
            val text = ProtocolJson.json.encodeToString(ProtocolResponse.serializer(), response)
            assertEquals(status, ProtocolJson.json.decodeFromString(ProtocolResponse.serializer(), text).commandStatus)
        }
    }

    @Test
    fun commandStatusResponseKeepsConditionalShape() {
        val tree = roundTrip(
            ProtocolResponse(
                requestId = uuid,
                responseType = ResponseType.COMMAND_STATUS,
                commandStatus = CommandStatus.ACCEPTED,
                result = ProtocolJson.json.parseToJsonElement("""{"queued":true}"""),
            ),
        )
        assertEquals("command.status", tree.getValue("responseType").jsonPrimitive.content)
        assertEquals("accepted", tree.getValue("commandStatus").jsonPrimitive.content)
        assertTrue(tree.containsKey("result"))
        assertFalse("command.status responses must not carry error", tree.containsKey("error"))
    }

    @Test
    fun commandErrorResponseKeepsConditionalShape() {
        val tree = roundTrip(
            ProtocolResponse(
                requestId = uuid,
                responseType = ResponseType.COMMAND_ERROR,
                error = ResponseError(code = "E_BAD", message = "bad", retryable = false),
            ),
        )
        assertEquals("command.error", tree.getValue("responseType").jsonPrimitive.content)
        assertFalse("command.error responses must not carry commandStatus", tree.containsKey("commandStatus"))
        assertFalse("command.error responses must not carry result", tree.containsKey("result"))
        val errorTree = tree.getValue("error").jsonObject
        assertEquals("E_BAD", errorTree.getValue("code").jsonPrimitive.content)
        assertEquals("bad", errorTree.getValue("message").jsonPrimitive.content)
        assertEquals(false, errorTree.getValue("retryable").jsonPrimitive.boolean)

        // retryable is optional and omitted when null.
        val withoutRetryable = roundTrip(
            ProtocolResponse(
                requestId = uuid,
                responseType = ResponseType.COMMAND_ERROR,
                error = ResponseError(code = "E_X", message = "x"),
            ),
        )
        assertFalse(withoutRetryable.getValue("error").jsonObject.containsKey("retryable"))
    }

    @Test
    fun responseRejectsUnknownResponseType() {
        try {
            ProtocolJson.json.decodeFromString(
                ProtocolResponse.serializer(),
                """{"protocolVersion":"claude-remote.v1","requestId":"$uuid","responseType":"magic"}""",
            )
            fail("expected unknown responseType to be rejected")
        } catch (expected: SerializationException) {
        }
    }
}
