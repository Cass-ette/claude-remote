plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

android {
    namespace = "dev.clauderemote.android"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.clauderemote.android"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Debug/CI default bridge endpoint: the emulator's alias for the host
        // loopback, on the bridge's DEFAULT_BRIDGE_PORT (bridge/src/config.ts).
        // Production installs override this with the user-entered host on the
        // ConnectionScreen (persisted via BridgeHostStore).
        buildConfigField("String", "DEFAULT_BRIDGE_BASE_URL", "\"http://10.0.2.2:43111\"")

        // Required by the AppAuth library manifest merger
        // (net.openid.appauth.RedirectUriReceiverActivity uses
        // ${appAuthRedirectScheme} as the redirect URI scheme).
        manifestPlaceholders["appAuthRedirectScheme"] = "dev.clauderemote.android"
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = libs.versions.composeCompiler.get()
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

// Export Room schemas next to Migrations.kt's history: every version bump
// writes app/schemas/dev.clauderemote.android.data.local.AppDatabase/<n>.json
// so future migrations can be validated with MigrationTestHelper.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    // Compose UI shell.
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)

    // Room projection storage (populated by later tasks).
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    // Bridge HTTP/WebSocket transport.
    implementation(libs.okhttp)

    // Cloudflare Access OAuth user agent.
    implementation(libs.appauth)
    implementation(libs.androidx.browser)

    // Protocol v1 JSON models and coroutines.
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    // Encrypted token storage.
    implementation(libs.androidx.security.crypto)

    // JVM unit tests.
    testImplementation(libs.junit)

    // Instrumented tests (Room projection DAO contract tests, Compose UI).
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)

    // Embedded HTTP+WS fake bridge for the E2E instrumented suite.
    androidTestImplementation(libs.mockwebserver)
}
