import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The app shares the server's version: 0.21.0 is version code 21000. The
// container build (scripts/build-apk.sh) uses the same formula for the
// download's metadata.
val serverVersion = (JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>)["version"] as String
val serverVersionCode = serverVersion.split(".").map { it.toInt() }.let { (major, minor, patch) ->
    major * 1_000_000 + minor * 1_000 + patch
}

android {
    namespace = "io.github.mrksrus.unihub"
    compileSdk = 35

    defaultConfig {
        // Never change: Android only installs an update over an app with the
        // same id and signing key.
        applicationId = "io.github.mrksrus.unihub"
        minSdk = 29
        targetSdk = 35
        versionCode = serverVersionCode
        versionName = serverVersion
    }

    // Release signing comes from the container build (a CI secret, or a
    // throwaway key for local images). Without it, release builds are unsigned.
    val keystore = System.getenv("UNIHUB_KEYSTORE")
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("UNIHUB_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("UNIHUB_KEY_ALIAS") ?: "unihub"
                keyPassword = System.getenv("UNIHUB_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    dependenciesInfo {
        // The APK is downloaded from the user's own server, not a store.
        includeInApk = false
        includeInBundle = false
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    // JVM tests of code without Android classes (PushCrypto), run by scripts/build-apk.sh.
    testImplementation("junit:junit:4.13.2")
}
