package com.lumen.remote.util

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * File-backed logger so a bad session on a phone can be diagnosed after the
 * fact: Logcat is gone once the app dies, and users cannot run adb. Lines go
 * to Logcat, a bounded ring in memory, and filesDir/logs/lumen.log with
 * rotation (2 MB x 3). Export bundles the tail via the share sheet.
 */
object LLog {
    private const val TAG = "LumenRemote"
    private const val MAX_FILE_BYTES = 2L * 1024 * 1024
    private const val MAX_FILES = 3
    private const val MAX_RING = 2000

    private var file: File? = null
    private var dir: File? = null
    private val ring = ArrayDeque<String>()
    private val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    @Synchronized
    fun init(context: Context) {
        if (file != null) return
        try {
            val d = File(context.filesDir, "logs").apply { mkdirs() }
            dir = d
            file = File(d, "lumen.log")
        } catch (_: Exception) {
            file = null
        }
    }

    @Synchronized
    fun log(level: String, tag: String, message: String) {
        val line = "${fmt.format(Date())} [${level.padEnd(5)}] [$tag] $message"
        when (level) {
            "ERROR" -> Log.e(TAG, line)
            "WARN" -> Log.w(TAG, line)
            "DEBUG" -> Log.d(TAG, line)
            else -> Log.i(TAG, line)
        }
        ring.addLast(line)
        while (ring.size > MAX_RING) ring.removeFirst()
        val f = file ?: return
        try {
            if (f.exists() && f.length() > MAX_FILE_BYTES) rotate()
            f.appendText(line + "\n")
        } catch (_: Exception) {
            // Logging must never crash the app; the ring still backs export.
        }
    }

    fun i(tag: String, message: String) = log("INFO", tag, message)
    fun w(tag: String, message: String) = log("WARN", tag, message)
    fun e(tag: String, message: String) = log("ERROR", tag, message)
    fun d(tag: String, message: String) = log("DEBUG", tag, message)

    private fun rotate() {
        val d = dir ?: return
        try {
            for (i in MAX_FILES - 1 downTo 1) {
                val from = if (i == 1) File(d, "lumen.log") else File(d, "lumen.${i - 1}.log")
                if (from.exists()) from.renameTo(File(d, "lumen.$i.log"))
            }
        } catch (_: Exception) {
        }
    }

    /** Log tail for the export bundle: disk when readable, ring otherwise. */
    @Synchronized
    fun exportText(header: String, maxChars: Int = 512 * 1024): String {
        val body = try {
            val f = file
            if (f != null && f.exists()) {
                val raw = f.readText()
                if (raw.length > maxChars) "…（前略）…\n" + raw.takeLast(maxChars) else raw.trimEnd()
            } else {
                ring.joinToString("\n")
            }
        } catch (_: Exception) {
            ring.joinToString("\n")
        }
        return "$header\n\n===== 应用日志 =====\n$body\n"
    }
}
