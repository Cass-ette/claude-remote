plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "dev.clauderemote.probe"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.clauderemote.probe"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Placeholder for the verified App Link hostname. The real value is
        // supplied by the runner (run-real-gate.ts) via -PprobeHostname=...
        // at install time, but the manifest placeholder default must be set
        // so the build does not fail.
        manifestPlaceholders["probeHostname"] = "probe.example.com"
        // Required by the AppAuth library manifest merger
        // (net.openid.appauth.RedirectUriReceiverActivity uses
        // ${appAuthRedirectScheme} as the redirect URI scheme).
        manifestPlaceholders["appAuthRedirectScheme"] = "dev.clauderemote.probe"
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

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // AppAuth-Android — Authorization Code + PKCE.
    implementation("net.openid:appauth:0.11.1")
    // OkHttp — bearer HTTP and bearer WebSocket Upgrade.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // AndroidX Browser — custom tabs for the OAuth user agent.
    implementation("androidx.browser:browser:1.8.0")
    // Kotlin serialization — evidence file JSON.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    // JVM unit tests — PKCE / state / URI logic.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.0")

    // Instrumented tests — real OAuth + HTTP + WebSocket + App Link.
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.1")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("com.squareup.okhttp3:okhttp:4.12.0")
    androidTestImplementation("net.openid:appauth:0.11.1")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
}
