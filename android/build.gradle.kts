// AGP 9 ships built-in Kotlin support: applying org.jetbrains.kotlin.android as
// well registers a duplicate `kotlin` extension and fails configuration.
plugins {
    id("com.android.application") version "9.1.0" apply false
}
