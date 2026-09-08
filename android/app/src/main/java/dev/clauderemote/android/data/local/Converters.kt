package dev.clauderemote.android.data.local

import androidx.room.TypeConverter
import java.time.Instant

/**
 * Room type conversions for the projection schema.
 *
 * - Long: event IDs and positions are native Room columns; no converter.
 * - JSON: content/result/envelope columns store the exact wire string, so
 *   envelopes can be re-emitted without re-serialization drift; no converter.
 * - Instant: java.time.Instant columns (updatedAt/expiresAt/receivedAt) are
 *   stored as epoch-millisecond Longs (minSdk 28 ships java.time natively).
 */
class Converters {

    @TypeConverter
    fun instantToEpochMillis(value: Instant): Long = value.toEpochMilli()

    @TypeConverter
    fun epochMillisToInstant(value: Long): Instant = Instant.ofEpochMilli(value)
}
