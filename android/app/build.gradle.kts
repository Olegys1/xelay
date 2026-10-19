import java.util.Properties
import java.util.Base64
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val local = Properties().apply {
    rootProject.file("local.properties").takeIf { it.isFile }?.inputStream()?.use { load(it) }
}
fun publicSetting(property: String, environment: String) =
    (local.getProperty(property) ?: System.getenv(environment) ?: "").trim()
val supabaseUrl = publicSetting("xelay.supabaseUrl", "XELAY_SUPABASE_URL")
val supabaseKey = publicSetting("xelay.supabaseAnonKey", "XELAY_SUPABASE_ANON_KEY")
// Validate configuration without echoing a key into logs.
require(supabaseUrl.matches(Regex("https://[a-z0-9-]+\\.supabase\\.co"))) {
    "Set xelay.supabaseUrl to the HTTPS project URL in local.properties."
}
require(supabaseKey.isNotBlank() && !supabaseKey.startsWith("sb_secret_")) {
    "Set the public anon/publishable key. Secret keys must never enter a mobile app."
}
if (supabaseKey.startsWith("eyJ")) {
    val payload = runCatching {
        String(Base64.getUrlDecoder().decode(supabaseKey.split('.')[1]))
    }.getOrDefault("")
    require(Regex("\"role\"\\s*:\\s*\"anon\"").containsMatchIn(payload)) {
        "Only the anon JWT is allowed in a mobile build."
    }
} else require(supabaseKey.startsWith("sb_publishable_")) { "A public Supabase key is required." }
fun literal(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "ink.xelay.android"
    compileSdk = 36
    defaultConfig {
        applicationId = "ink.xelay.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "0.1.2"
        buildConfigField("String", "SUPABASE_URL", literal(supabaseUrl))
        buildConfigField("String", "SUPABASE_ANON_KEY", literal(supabaseKey))
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}
kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
