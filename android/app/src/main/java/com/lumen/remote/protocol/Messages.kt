package com.lumen.remote.protocol

import org.json.JSONArray
import org.json.JSONObject

/** Control-plane messages carried on Channel.CONTROL as JSON. */
object Messages {
    fun ping(n: Long, t1: Long): ByteArray = JSONObject()
        .put("t", "ping").put("n", n).put("t1", t1).toString().toByteArray(Charsets.UTF_8)

    fun pong(n: Long, t1: Long, t2: Long, t3: Long): ByteArray = JSONObject()
        .put("t", "pong").put("n", n).put("t1", t1).put("t2", t2).put("t3", t3)
        .toString().toByteArray(Charsets.UTF_8)

    fun hello(
        sessionId: String,
        isHost: Boolean,
        deviceId: String,
        ephBase64: String,
        display: Triple<Int, Int, Int>?,
    ): ByteArray {
        val o = JSONObject()
            .put("t", "hello")
            .put("v", Wire.PROTOCOL_VERSION)
            .put("sessionId", sessionId)
            .put("role", if (isHost) "host" else "controller")
            .put("deviceId", deviceId)
            .put("eph", ephBase64)
            .put("caps", JSONArray(listOf("h264")))
        if (display != null) {
            o.put(
                "display",
                JSONObject().put("width", display.first).put("height", display.second).put("fps", display.third),
            )
        }
        return o.toString().toByteArray(Charsets.UTF_8)
    }

    fun report(hi: Long, lost: Int, received: Int, gradientUs: Long, jitterUs: Long, nowUs: Long): ByteArray =
        JSONObject()
            .put("t", "report")
            .put(
                "report",
                JSONObject()
                    .put("hi", hi)
                    .put("lost", lost)
                    .put("received", received)
                    .put("delayGradientUs", gradientUs)
                    .put("jitterUs", jitterUs)
                    .put("nowUs", nowUs),
            )
            .toString().toByteArray(Charsets.UTF_8)

    fun nack(entries: List<NackEntry>): ByteArray {
        val arr = JSONArray()
        for (e in entries) {
            val frags = JSONArray()
            for (f in e.frags) frags.put(f)
            arr.put(JSONObject().put("channel", e.channel).put("frameId", e.frameId).put("frags", frags))
        }
        return JSONObject().put("t", "nack").put("entries", arr).toString().toByteArray(Charsets.UTF_8)
    }

    fun idr(): ByteArray = JSONObject().put("t", "idr").toString().toByteArray(Charsets.UTF_8)

    fun bye(reason: String = "closed"): ByteArray =
        JSONObject().put("t", "bye").put("reason", reason).toString().toByteArray(Charsets.UTF_8)

    fun inputMove(nx: Float, ny: Float): ByteArray = JSONObject()
        .put("k", "ma").put("nx", nx.toDouble()).put("ny", ny.toDouble())
        .toString().toByteArray(Charsets.UTF_8)

    fun inputButton(button: Int, down: Boolean): ByteArray = JSONObject()
        .put("k", "mb").put("b", button).put("down", down)
        .toString().toByteArray(Charsets.UTF_8)

    fun inputWheel(delta: Int): ByteArray = JSONObject()
        .put("k", "mw").put("delta", delta)
        .toString().toByteArray(Charsets.UTF_8)

    fun inputMoveRelative(dx: Int, dy: Int): ByteArray = JSONObject()
        .put("k", "mm").put("dx", dx).put("dy", dy)
        .toString().toByteArray(Charsets.UTF_8)

    /**
     * `scan` is the PC set-1 make code, `vk` the low byte of the Windows virtual
     * key; bit 0x100 marks an extended key (arrows, right ctrl, win, ...).
     */
    fun inputKey(scan: Int, vk: Int, down: Boolean): ByteArray = JSONObject()
        .put("k", if (down) "kd" else "ku")
        .put("scan", scan)
        .put("vk", vk)
        .toString().toByteArray(Charsets.UTF_8)

    fun inputText(text: String): ByteArray = JSONObject()
        .put("k", "kr").put("text", text)
        .toString().toByteArray(Charsets.UTF_8)

    fun parse(buf: ByteArray): JSONObject? = try {
        JSONObject(String(buf, Charsets.UTF_8))
    } catch (_: Exception) {
        null
    }
}

data class NackEntry(val channel: Int, val frameId: Int, val frags: List<Int>)
