package dev.clauderemote.android.data.local

import androidx.room.migration.Migration

/**
 * Room schema migration history for [AppDatabase].
 *
 * The schema is at version 1 (initial release), so no migrations exist yet.
 * Every future schema change must:
 *
 * 1. Bump [AppDatabase.VERSION].
 * 2. Add a [Migration] here and include it in [ALL].
 * 3. Commit the exported app/schemas/.../<n>.json file it produces, keeping
 *    the schema history complete for MigrationTestHelper validation.
 *
 * NEVER modify an already-released version's schema JSON or its migration —
 * the projection DB is the owner of rendered history on user devices.
 */
object Migrations {

    val ALL: Array<Migration> = emptyArray()
}
