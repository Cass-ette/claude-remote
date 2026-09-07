// Top-level build file. Plugins are DECLARED here but NOT applied per the
// convention recommended by AGP — they get applied with `apply false` so the
// `:app` module can apply the version that matches its own needs, resolved
// through the version catalog in gradle/libs.versions.toml.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
}
