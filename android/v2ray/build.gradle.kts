import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.zip.ZipFile

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Pinned to AndroidLibXrayLite ea96a7f9c33d6e18021386db96bf95680e853c93.
val prepareXray by tasks.registering {
    val target = layout.projectDirectory.file("libs/libv2ray.aar").asFile
    val expected = "cf71680b776b9ca583747ba652f816b047a655eab875d8951e6141636d88bbd6"
    val classes = layout.projectDirectory.file("libs/libv2ray.jar").asFile
    outputs.files(target, classes)
    fun digest(file: File) = MessageDigest.getInstance("SHA-256")
        .digest(file.readBytes()).joinToString("") { "%02x".format(it) }
    outputs.upToDateWhen { target.exists() && classes.exists() && digest(target) == expected }
    doLast {
        target.parentFile.mkdirs()
        val temporary = File(target.parentFile, "libv2ray.download")
        try {
            if (!target.exists() || digest(target) != expected) {
            URI("https://github.com/2dust/AndroidLibXrayLite/releases/download/v26.9.30/libv2ray.aar")
                .toURL().openConnection().apply { connectTimeout = 30000; readTimeout = 120000 }
                .getInputStream().use { input -> temporary.outputStream().use { input.copyTo(it) } }
            check(digest(temporary) == expected) { "Xray SHA-256 mismatch" }
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
            ZipFile(target).use { zip -> zip.getInputStream(zip.getEntry("classes.jar")).use { input -> classes.outputStream().use { input.copyTo(it) } } }
        } finally { temporary.delete() }
    }
}

val prepareGeoData by tasks.registering {
    val assets = layout.projectDirectory.dir("src/main/assets")
    outputs.files(assets.file("geoip.dat"), assets.file("geosite.dat"))
    doLast {
        val checksums = mapOf(
            "geoip.dat" to "391b522361c52804e486a98b53d97f3d9c1d3e4e4217bb34954774a0b456b9fd",
            "geosite.dat" to "f574a55e779133682583ca8e8fd052f2a70d9d010431a5579cf1a6c93ef6e910"
        )
        assets.asFile.mkdirs()
        checksums.forEach { (name, expected) ->
            val target = File(assets.asFile, name)
            URI("https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202610052207/$name")
                .toURL().openConnection().apply { connectTimeout = 30000; readTimeout = 120000 }
                .getInputStream().use { input -> target.outputStream().use { input.copyTo(it) } }
            val actual = MessageDigest.getInstance("SHA-256").digest(target.readBytes()).joinToString("") { "%02x".format(it) }
            check(actual == expected) { "Geodata SHA-256 mismatch: $name" }
        }
    }
}

android {
    namespace = "com.v2ray.ang"
    compileSdk = 37
    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
        buildConfigField("String", "APPLICATION_ID", "\"app.xvi.note\"")
        buildConfigField("String", "VERSION_NAME", "\"2.3.10-embedded\"")
        buildConfigField("String", "DISTRIBUTION", "\"Embedded\"")
    }
    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
    buildFeatures { buildConfig = true; compose = true }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    // Core Libraries
    compileOnly(files("libs/libv2ray.jar").builtBy(prepareXray))
    testImplementation(files("libs/libv2ray.jar").builtBy(prepareXray))

    // AndroidX Core Libraries
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)

    // Compose Libraries
    implementation(platform(libs.androidx.compose.bom))

    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.coil.compose)

    debugImplementation(libs.androidx.compose.ui.tooling)

    // Data and Storage Libraries
    implementation(libs.mmkv.static)
    implementation(libs.gson)
    implementation(libs.okhttp)

    // Reactive and Utility Libraries
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.core)

    // QR Code: CameraX + ZXing
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.compose)
    implementation(libs.core) // zxing core

    // AndroidX Lifecycle and Architecture Components
    implementation(libs.lifecycle.viewmodel.ktx)
    implementation(libs.lifecycle.runtime.ktx)

    // Background Task Libraries
    implementation(libs.work.runtime.ktx)
    implementation(libs.work.multiprocess)

    // Reorderable list
    implementation(libs.reorderable)

    // Testing Libraries
    coreLibraryDesugaring(libs.desugar.jdk.libs)
}

tasks.named("preBuild") { dependsOn(prepareGeoData) }
