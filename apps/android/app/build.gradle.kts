import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// versionName follows the wrapped extension's manifest so the APK and the
// extension build it ships are easy to correlate.
val extensionManifest = rootProject.file("../extension/public/manifest.json")
val extensionVersion: String = extensionManifest.takeIf { it.isFile }
    ?.readText()
    ?.let { Regex("\"version\"\\s*:\\s*\"([0-9.]+)\"").find(it)?.groupValues?.get(1) }
    ?: "0.0.0"
val extensionVersionCode: Int = extensionVersion.split(".").map { it.toIntOrNull() ?: 0 }
    .let { p -> (p.getOrElse(0) { 0 } * 10000) + (p.getOrElse(1) { 0 } * 100) + p.getOrElse(2) { 0 } }
    .coerceAtLeast(1)

// Release signing material lives in apps/android/keystore/ (gitignored).
val keystorePropsFile = rootProject.file("keystore/keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.isFile) keystorePropsFile.inputStream().use { load(it) }
}
val hasReleaseKeystore = keystorePropsFile.isFile && keystoreProps.getProperty("storeFile") != null

android {
    namespace = "com.walletchan.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.walletchan.android"
        minSdk = 26
        targetSdk = 35
        versionCode = extensionVersionCode
        versionName = extensionVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = rootProject.file("keystore/" + keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            // R8 is off on purpose: the app is tiny, and this avoids any risk of
            // stripping WebView bridge callbacks. Revisit if APK size matters.
            isMinifyEnabled = false
            isShrinkResources = false
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                logger.warn(
                    "WalletChan: keystore/keystore.properties not found; release APK will be UNSIGNED. " +
                        "See apps/android/README.md (Signing)."
                )
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        // The wrapped extension's assets are generated; don't lint them.
        ignoreTestSources = true
    }

    packaging {
        resources {
            excludes += setOf("META-INF/*.kotlin_module", "META-INF/versions/**", "DebugProbesKt.bin")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.webkit:webkit:1.14.0")
    // Biometric unlock (BiometricPrompt + Class 3 CryptoObject). 1.1.0 is the latest stable.
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Embedded ZXing scanner (no Google Play Services dependency).
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
    // Real org.json for JVM unit tests (android.jar only ships stubs).
    testImplementation("org.json:json:20250517")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
