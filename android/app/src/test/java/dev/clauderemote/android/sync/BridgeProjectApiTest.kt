package dev.clauderemote.android.sync

import dev.clauderemote.android.network.BridgeCommandApi
import dev.clauderemote.android.protocol.v1.ProtocolResponse
import dev.clauderemote.android.protocol.v1.ResponseType
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * BridgeProjectApi contract: the project.list envelope carries the §8.1 wire
 * discriminator and the result decodes as the bridge dispatcher's exact shape
 * {projects:[{projectId,displayName}]} — unknown fields tolerated, missing
 * result envelope rejected.
 */
class BridgeProjectApiTest {

    private class RecordingApi(private val response: ProtocolResponse) : BridgeCommandApi {
        var sent: dev.clauderemote.android.protocol.v1.ProtocolCommand? = null
        override suspend fun postCommand(command: dev.clauderemote.android.protocol.v1.ProtocolCommand): ProtocolResponse {
            sent = command
            return response
        }
    }

    private fun resultResponse(json: String) = ProtocolResponse(
        requestId = "req-1",
        responseType = ResponseType.COMMAND_STATUS,
        commandStatus = dev.clauderemote.android.protocol.v1.CommandStatus.COMPLETED,
        result = Json.parseToJsonElement(json),
    )

    @Test
    fun sendsProjectListEnvelopeAndDecodesTheBridgeShape() = runBlocking {
        val api = RecordingApi(
            resultResponse(
                """{"projects":[{"projectId":"019122ab-c100-7000-8000-000000000001","displayName":"My project"},""" +
                    """{"projectId":"019122ab-c100-7000-8000-000000000002","displayName":"另一个"}]}""",
            ),
        )
        val projects = BridgeProjectApi(api, newId = { "req-1" }, nowMillis = { 1_700_000_000_000L }).listProjects()
        assertEquals(
            listOf(
                BridgeProject("019122ab-c100-7000-8000-000000000001", "My project"),
                BridgeProject("019122ab-c100-7000-8000-000000000002", "另一个"),
            ),
            projects,
        )
        assertEquals("project.list", api.sent!!.commandType.wire)
        assertEquals(null, api.sent!!.sessionId)
    }

    @Test
    fun toleratesUnknownResultFieldsAndMissingProjectsKey() = runBlocking {
        val api = RecordingApi(resultResponse("""{"projects":[],"extra":1}"""))
        assertEquals(emptyList<BridgeProject>(), BridgeProjectApi(api).listProjects())
        val missing = RecordingApi(resultResponse("""{"future":true}"""))
        assertEquals(emptyList<BridgeProject>(), BridgeProjectApi(missing).listProjects())
    }

    @Test(expected = IllegalStateException::class)
    fun rejectsAResponseWithoutResultEnvelope(): Unit = runBlocking {
        val api = RecordingApi(
            ProtocolResponse(requestId = "req-1", responseType = ResponseType.COMMAND_STATUS, commandStatus = dev.clauderemote.android.protocol.v1.CommandStatus.COMPLETED),
        )
        BridgeProjectApi(api).listProjects()
    }
}
