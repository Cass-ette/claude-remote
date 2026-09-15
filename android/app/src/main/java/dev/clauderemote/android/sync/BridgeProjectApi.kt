package dev.clauderemote.android.sync

import dev.clauderemote.android.network.BridgeCommandApi
import dev.clauderemote.android.protocol.v1.ProjectListCommand
import dev.clauderemote.android.protocol.v1.ProjectListPayload
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * One authorized project as the bridge returns it over `project.list`
 * (spec §7.2 step 1): the client-safe {projectId, displayName} subset —
 * the bridge never sends paths or filesystem identity.
 */
data class BridgeProject(val projectId: String, val displayName: String)

/** Seam for the §12.4 new-session/import project pickers. */
interface ProjectListApi {
    suspend fun listProjects(): List<BridgeProject>
}

/**
 * [ProjectListApi] over the §8.2 command endpoint. Result shape mirrors the
 * bridge dispatcher exactly: `{projects: [{projectId, displayName}]}`.
 */
class BridgeProjectApi(
    val commands: BridgeCommandApi,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val nowMillis: () -> Long = System::currentTimeMillis,
) : ProjectListApi {

    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun listProjects(): List<BridgeProject> {
        val response = commands.postCommand(
            ProjectListCommand(
                requestId = newId(),
                idempotencyKey = newId(),
                sentAt = Instant.ofEpochMilli(nowMillis()).toString(),
                payload = ProjectListPayload,
            ),
        )
        val result = response.result
            ?: throw IllegalStateException("project.list response carried no result envelope")
        return json.decodeFromJsonElement(WireProjectListResult.serializer(), result)
            .projects
            .map { BridgeProject(projectId = it.projectId, displayName = it.displayName) }
    }
}

@Serializable
private data class WireProjectListResult(val projects: List<WireProject> = emptyList()) {
    @Serializable
    data class WireProject(
        @SerialName("projectId") val projectId: String,
        @SerialName("displayName") val displayName: String,
    )
}
