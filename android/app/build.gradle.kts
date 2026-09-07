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
}
