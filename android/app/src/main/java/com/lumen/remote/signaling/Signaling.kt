package com.lumen.remote.signaling

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket

data class DeviceInfo(val deviceId: String, val code: String, val name: String, val os: String)
data class PeerReady(
    val sessionId: String,
    val role: String,
    val peer: DeviceInfo,
    val peerEph: String,
    val peerCandidates: List<Candidate>,
    val relay: Candidate,
    val password: String?,
)

data class Candidate(val kind: String, val address: String, val port: Int, val priority: Int)

/**
 * TCP client for the signalling service: newline-delimited JSON, same message
 * shapes as `src/signaling/protocol.ts`.
 */
class SignalingClient(
    private val host: String,
    private val port: Int,
    private val deviceId: String,
    private val preferredCode: String?,
    private val deviceName: String,
    private val onMessage: (JSONObject) -> Unit,
    private val onClosed: (String) -> Unit,
    private val log: (String) -> Unit = {},
) {
    private var socket: Socket? = null
    private var writer: OutputStream? = null
    private var readerThread: Thread? = null
    private var writerThread: Thread? = null
    private val outbox = java.util.concurrent.ArrayBlockingQueue<String>(64)

    @Volatile
    private var closed = false

    fun connect(timeoutMs: Int = 8000) {
        val s = Socket()
        s.tcpNoDelay = true
        s.connect(InetSocketAddress(host, port), timeoutMs)
        socket = s
        writer = s.getOutputStream()

        // Android forbids socket writes on the main thread, and callers (button
        // handlers) are on it, so every message goes through one writer thread.
        writerThread = Thread({
            while (!closed) {
                // close() interrupts this thread; letting InterruptedException
                // escape would take the whole process down.
                val line = try {
                    outbox.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    break
                }
                if (line == null) continue
                val out = writer ?: continue
                try {
                    out.write((line + "\n").toByteArray(Charsets.UTF_8))
                    out.flush()
                } catch (e: Exception) {
                    log("信令写入失败 ${e.javaClass.simpleName}: ${e.message}")
                }
            }
        }, "signal-tx").apply {
            isDaemon = true
            start()
        }

        readerThread = Thread({
            try {
                val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
                while (!closed) {
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    try {
                        onMessage(JSONObject(line))
                    } catch (_: Exception) {
                        // Ignore malformed lines rather than dropping the link.
                    }
                }
            } catch (_: Exception) {
            }
            if (!closed) onClosed("信令连接已断开")
        }, "signal-rx").apply {
            isDaemon = true
            start()
        }

        send(
            JSONObject()
                .put("t", "hello")
                .put("deviceId", deviceId)
                .apply { if (!preferredCode.isNullOrEmpty()) put("preferredCode", preferredCode) }
                .put("name", deviceName)
                .put("os", "android")
                // Android is a controller-only build: it must never be dialled.
                .put("hostable", false),
        )
    }

    /** Serialises on the caller thread and hands the line to the writer thread. */
    fun send(msg: JSONObject) {
        if (closed) return
        val text = try {
            msg.toString()
        } catch (e: Exception) {
            log("信令序列化失败 ${e.javaClass.simpleName}")
            return
        }
        if (!outbox.offer(text)) log("信令发送队列已满，丢弃 ${msg.optString("t")}")
    }

    fun sendUdpToken(token: String, address: String, udpPort: Int) {
        send(
            JSONObject()
                .put("t", "udp-token")
                .put("token", token)
                .put("endpoint", JSONObject().put("address", address).put("port", udpPort)),
        )
    }

    fun sendConnect(
        sessionId: String,
        targetCode: String,
        password: String?,
        ephBase64: String,
        candidates: List<Candidate>,
        display: Triple<Int, Int, Int>,
    ) {
        val arr = JSONArray()
        for (c in candidates) {
            arr.put(
                JSONObject()
                    .put("kind", c.kind)
                    .put("address", c.address)
                    .put("port", c.port)
                    .put("priority", c.priority),
            )
        }
        send(
            JSONObject()
                .put("t", "connect")
                .put("sessionId", sessionId)
                .put("targetCode", digitsOnly(targetCode))
                .apply { if (!password.isNullOrEmpty()) put("password", password) }
                .put("eph", ephBase64)
                .put("candidates", arr)
                .put(
                    "display",
                    JSONObject().put("width", display.first).put("height", display.second).put("fps", display.third),
                ),
        )
    }

    fun sendBye(sessionId: String, reason: String) {
        send(JSONObject().put("t", "bye").put("sessionId", sessionId).put("reason", reason))
    }

    fun close() {
        closed = true
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        socket = null
        writer = null
        readerThread?.interrupt()
        writerThread?.interrupt()
        outbox.clear()
    }

    companion object {
        fun digitsOnly(code: String): String = code.filter { it.isDigit() }.take(9)

        fun formatCode(code: String): String {
            val d = digitsOnly(code)
            if (d.length != 9) return code
            return "${d.substring(0, 3)} ${d.substring(3, 6)} ${d.substring(6)}"
        }

        fun parseReady(msg: JSONObject): PeerReady? {
            val peer = msg.optJSONObject("peer") ?: return null
            val relayObj = msg.optJSONObject("relay")
            val candidates = ArrayList<Candidate>()
            msg.optJSONArray("peerCandidates")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val c = arr.optJSONObject(i) ?: continue
                    candidates.add(
                        Candidate(
                            kind = c.optString("kind", "host"),
                            address = c.optString("address"),
                            port = c.optInt("port"),
                            priority = c.optInt("priority", 0),
                        ),
                    )
                }
            }
            return PeerReady(
                sessionId = msg.optString("sessionId"),
                role = msg.optString("role", "controller"),
                peer = DeviceInfo(
                    deviceId = peer.optString("deviceId"),
                    code = peer.optString("code"),
                    name = peer.optString("name"),
                    os = peer.optString("os"),
                ),
                peerEph = msg.optString("peerEph"),
                peerCandidates = candidates,
                relay = Candidate(
                    kind = "relay",
                    address = relayObj?.optString("address") ?: "",
                    port = relayObj?.optInt("port") ?: 0,
                    priority = 0,
                ),
                password = if (msg.has("password")) msg.optString("password") else null,
            )
        }
    }
}
