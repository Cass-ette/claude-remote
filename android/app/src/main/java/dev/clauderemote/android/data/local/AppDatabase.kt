package dev.clauderemote.android.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

/**
 * The projection database (spec §6.1). Room is the persistence owner of
 * already-rendered history on this install; all protocol-atomic operations
 * (revision replace, guarded ACK, checkpoint commit) are provided by the
 * DAOs' @Transaction methods.
 *
 * Schemas are exported to app/schemas/ (see the room.schemaLocation KSP arg
 * in build.gradle.kts) so future migrations can be regression-tested with
 * MigrationTestHelper against committed history.
 */
@Database(
    entities = [
        SessionEntity::class,
        MessageEntity::class,
        CommandEventEntity::class,
        PendingLiveEventEntity::class,
        CheckpointCommitPendingEntity::class,
        DeviceSessionEntity::class,
        ConnectionStateEntity::class,
    ],
    version = AppDatabase.VERSION,
    exportSchema = true,
)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase() {

    abstract fun sessionDao(): SessionDao
    abstract fun messageDao(): MessageDao
    abstract fun commandEventDao(): CommandEventDao
    abstract fun checkpointDao(): CheckpointDao
    abstract fun pendingLiveEventDao(): PendingLiveEventDao
    abstract fun deviceSessionDao(): DeviceSessionDao
    abstract fun connectionStateDao(): ConnectionStateDao

    companion object {
        const val VERSION = 1

        /** Production database file name; tests build their own named DBs. */
        const val NAME = "claude-remote.db"
    }
}
