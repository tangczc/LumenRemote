plugins {
    id("com.android.application")
}

android {
    namespace = "com.lumen.remote"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.lumen.remote"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
                // Signed with the local debug key so the APK installs without a
                // keystore; replace with a real signing config before publishing.
                signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}
