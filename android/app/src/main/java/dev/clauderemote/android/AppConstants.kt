package dev.clauderemote.android

/**
 * Build-independent constants asserted by unit tests. BuildConfig does not
 * expose minSdk, so the supported floor is mirrored here and kept in sync
 * with app/build.gradle.kts via [VersionTest].
 */
object AppConstants {
    const val MIN_SDK: Int = 28
}
