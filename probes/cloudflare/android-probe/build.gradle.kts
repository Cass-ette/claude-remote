// Top-level build file. Plugins are DECLARED here but NOT applied per the
// convention recommended by AGP — they get applied with `apply false` so the
// `:app` module can apply the version that matches its own needs.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "1.9.24" apply false
}
