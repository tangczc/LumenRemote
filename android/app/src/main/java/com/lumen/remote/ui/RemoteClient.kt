package com.lumen.remote.ui

import android.content.Context
import com.lumen.remote.protocol.Crypto
import com.lumen.remote.protocol.Handshake
import com.lumen.remote.protocol.Messages
import com.lumen.remote.signaling.Candidate
import com.lumen.remote.signaling.SignalingClient
import com.lumen.remote.transport.Endpoint
import com.lumen.remote.transport.IncomingFrame
import com.lumen.remote.transport.Session
import com.lumen.remote.transport.SessionStats
import com.lumen.remote.transport.UdpLink
import org.json.JSONObject
import java.util.Base64
import kotlin.concurrent.thread

/**
 * Controller side of the app: registers with signalling, punches to the peer,
 * runs the encrypted session and hands video frames to the decoder.
 *
 * Android only controls here. Hosting an Android screen would need
 * MediaProjection plus a system input injector, which is a separate feature.
 */
class RemoteClient(
    private val context: Context,
    private val log: (String) -> Unit,
    private val onStatus: (String) -> Unit,
    private val onSessionStarted: (peerName: String, sas: String) -> Unit,
    private val onSessionEnded: (reason: String) -> Unit,
    private val onFrame: (IncomingFrame) -> Unit,
    private val onStats: (SessionStats) -> Unit,
    private val onSignalingFailed: (host: String) -> Unit = {},
    private val onDisplays: (List<DisplayOption>, Int) -> Unit = { _, _ -> },
    private val onSecureDesktop: (Boolean) -> Unit = {},
) {
    private var signaling: SignalingClient? = null
    private var link: UdpLink? = null
    private var session: Session? = null
    private var udpTokenSent = false

    @Volatile
    var deviceCode: String = ""
        private set

    @Volatile
    var inSession: Boolean = false
        private set

    /** Host the signalling link is actually registered with, `null` while down. */
    @Volatile
    var signalingHost: String? = null
        private set

    private var afterWelcome: (() -> Unit)? = null
    private var currentHost: String? = null

    val deviceId: String = loadDeviceId(context)

    fun connectSignaling(host: String, port: Int, after: (() -> Unit)? = null) {
        closeAll()
        signalingHost = null
        afterWelcome = after
        currentHost = host
        onStatus("正在连接信令服务器…")
        thread(name = "signal-connect") {
            try {
                val udp = UdpLink(onPacket = { pkt -> session?.let { s -> s.onDatagram(pkt) } })
                link = udp

                // Discovery must run before the receive loop starts: the token has
                // to describe this exact socket, and two readers on one socket
                // would race for the reply.
                val discovery = udp.discoverEndpoint(host, port + 1)
                udp.start()
                log("UDP 本地端口 ${udp.localPort}")

                val client = SignalingClient(
                    host = host,
                    port = port,
                    deviceId = deviceId,
                    preferredCode = loadPreferredCode(context),
                    deviceName = android.os.Build.MODEL ?: "Android",
                    onMessage = { msg -> onSignalingMessage(msg) },
                    onClosed = { reason ->
                        signalingHost = null
                        onStatus(reason)
                        onSessionEnded(reason)
                    },
                    log = log,
                )
                // Only publish the client once the TCP session is up: a broken
                // instance in `signaling` would swallow every later send.
                client.connect()
                signaling = client

                if (discovery != null) {
                    client.sendUdpToken(discovery.first, discovery.second.address, discovery.second.port)
                    log("UDP 端点 ${discovery.second}")
                } else {
                    log("UDP 端点发现失败，将只能使用中继")
                }
            } catch (e: Exception) {
                val detail = "${e.javaClass.simpleName}: ${e.message}"
                log("信令连接失败 $detail")
                onStatus("无法连接信令服务器 ($host:$port) — $detail")
                appendHint(host)
                onSignalingFailed(host)
            }
        }
    }

    /** A wrong-but-well-formed address is the most common failure, so say so. */
    private fun appendHint(host: String) {
        val local = com.lumen.remote.signaling.LanDiscovery.localIpv4()
        if (local.isEmpty()) return
        val sameSubnet = local.any { it.substringBeforeLast('.') == host.substringBeforeLast('.') }
        log(
            if (sameSubnet) "本机 $local 与 $host 同网段，检查电脑防火墙是否放行 7801"
            else "本机 $local 与 $host 不在同一网段，地址可能填错了",
        )
    }

    private fun onSignalingMessage(msg: JSONObject) {
        log("信令 ← ${msg.optString("t")}")
        when (msg.optString("t")) {
            "welcome" -> {
                // The code is still needed for signalling bookkeeping, but it is
                // never shown: this device cannot be dialled.
                deviceCode = msg.optString("code")
                savePreferredCode(context, deviceCode)
                signalingHost = currentHost
                onStatus("已连接信令服务器 · 可以连接 Windows 电脑")
                afterWelcome?.let { it() }
                afterWelcome = null
            }
            "ready" -> {
                val ready = SignalingClient.parseReady(msg) ?: return
                startSession(ready)
            }
            "rejected" -> {
                val reason = msg.optString("reason", "连接被拒绝")
                log("信令 ← rejected: $reason")
                onStatus(reason)
                onSessionEnded(reason)
            }
            "error" -> {
                val message = msg.optString("message")
                log("信令 ← error: $message")
                onStatus(message)
            }
            "bye" -> {
                val reason = msg.optString("reason", "对方已断开")
                onStatus(reason)
                onSessionEnded(reason)
                teardownSession()
            }
        }
    }

    fun connectToPeer(targetCode: String, password: String, display: Triple<Int, Int, Int>) {
        val client = signaling ?: run {
            onStatus("尚未连接信令服务器，请先填写正确的服务器地址")
            log("连接被拒: 信令未建立")
            return
        }
        val udp = link ?: return
        val local = Crypto.generateEphemeral()
        pendingPrivate = local.first
        pendingPublic = local.second
        pendingSessionId = randomId()
        pendingPassword = password

        val candidates = ArrayList<Candidate>()
        for (c in UdpLink.hostCandidates(udp.localPort)) {
            candidates.add(Candidate("host", c.address, c.port, 100))
        }
        onStatus("正在请求 ${SignalingClient.formatCode(targetCode)}")
        log("信令 → connect ${SignalingClient.digitsOnly(targetCode)}")
        client.sendConnect(
            sessionId = pendingSessionId,
            targetCode = targetCode,
            password = password,
            ephBase64 = Base64.getEncoder().encodeToString(local.second),
            candidates = candidates,
            display = display,
        )
        log("候选 ${candidates.size} 个 · 本地端口 ${udp.localPort}")
    }

    private var pendingPrivate: ByteArray? = null
    private var pendingPublic: ByteArray? = null
    private var pendingSessionId: String = ""
    private var pendingPassword: String = ""

    private fun startSession(ready: com.lumen.remote.signaling.PeerReady) {
        val udp = link ?: return
        val priv = pendingPrivate ?: run {
            onStatus("会话状态异常")
            return
        }
        val localPub = pendingPublic ?: return
        val peerPub = try {
            Base64.getDecoder().decode(ready.peerEph)
        } catch (e: Exception) {
            onStatus("对方密钥无效")
            return
        }
        if (peerPub.size != 32) {
            onStatus("对方密钥长度错误")
            return
        }

        val keys = Handshake.deriveKeys(
            sessionId = ready.sessionId,
            localPrivate = priv,
            localPublic = localPub,
            peerPublic = peerPub,
            isHost = false,
            password = pendingPassword,
        )

        val s = Session(
            sessionId = ready.sessionId,
            isHost = false,
            keys = keys,
            link = udp,
            initialBitrateBps = 40_000_000,
            maxBitrateBps = 60_000_000,
            log = log,
            onFrame = onFrame,
            onControl = { msg ->
                when (msg.optString("t")) {
                    "idr" -> session?.requestKeyframe()
                    "secure-desktop" -> {
                        val activeNow = msg.optBoolean("active")
                        log(if (activeNow) "对方屏幕被系统安全提示占用（UAC/锁屏），画面暂停" else "对方已确认系统提示，画面恢复")
                        onSecureDesktop(activeNow)
                    }
                    "displays" -> {
                        val arr = msg.optJSONArray("displays")
                        val list = ArrayList<DisplayOption>()
                        if (arr != null) {
                            for (i in 0 until arr.length()) {
                                val o = arr.optJSONObject(i) ?: continue
                                list.add(
                                    DisplayOption(
                                        index = o.optInt("index", i),
                                        name = o.optString("name"),
                                        primary = o.optBoolean("primary"),
                                        width = o.optInt("width"),
                                        height = o.optInt("height"),
                                        refreshRate = o.optInt("refreshRate", 60),
                                    ),
                                )
                            }
                        }
                        log("对方 ${list.size} 块屏幕，当前第 ${msg.optInt("active", 0) + 1} 块")
                        onDisplays(list, msg.optInt("active", 0))
                    }
                }
            },
            onStats = onStats,
        )
        session = s
        s.start()

        // Punch every candidate at once; both peers latch onto the first reply.
        val candidates = ready.peerCandidates
            .filter { it.address.isNotEmpty() && it.port > 0 }
            .sortedByDescending { it.priority }
            .map { Endpoint(it.address, it.port) }
        if (candidates.isNotEmpty()) udp.setCandidates(candidates)

        thread(name = "path-select") {
            // An exception here used to kill the thread silently and leave the UI
            // stuck on the connect form even though media was already flowing.
            try {
                val before = s.packetsReceived()
                Thread.sleep(400)
                val p2p = s.latched() || s.packetsReceived() > before
                if (!p2p && ready.relay.address.isNotEmpty()) {
                    val relay = relayEndpoint(ready.relay.address, ready.relay.port, candidates.map { it.address })
                    udp.setRemote(relay)
                    Thread.sleep(200)
                    onStatus("数据通道 中继转发 $relay")
                } else {
                    val ep = udp.remoteEndpoint()
                    onStatus("数据通道 P2P 直连 $ep")
                }
                s.sendHello(Base64.getEncoder().encodeToString(localPub))
                inSession = true
                log("会话就绪 SAS=${keys.sas}")
                onSessionStarted(ready.peer.name, keys.sas)
                s.requestKeyframe()
            } catch (e: Exception) {
                log("建立会话失败 ${e.javaClass.simpleName}: ${e.message}")
                onStatus("会话建立失败，请重试")
            }
        }
    }

    /**
     * Relay traffic must go to the signalling server this client dialled.
     *
     * A server behind 1:1 NAT advertises its private NIC address (10.x/192.168.x) and
     * an older build advertised the peer's own address; media sent to either place
     * never arrives, so both sides time out after 8 s with "对方已离线".
     */
    private fun relayEndpoint(advertised: String, port: Int, peerAddresses: List<String>): Endpoint {
        val dialled = currentHost?.trim().orEmpty()
        if (dialled.isEmpty()) return Endpoint(advertised, port)
        val suspect = peerAddresses.contains(advertised) || unroutableRelay(advertised)
        return if (suspect) Endpoint(dialled, port) else Endpoint(advertised, port)
    }

    fun sendInput(payload: ByteArray) {
        session?.sendInput(payload)
    }

    fun requestKeyframe() {
        session?.requestKeyframe()
    }

    fun selectDisplay(index: Int) {
        session?.selectDisplay(index)
    }

    fun setPointerLock(locked: Boolean) {
        session?.pointerLock(locked)
    }

    fun disconnect() {
          val s = session
          // The notification has to be queued before the teardown below: the old
          // order cleared `session` first, the worker thread then saw null, and the
          // host kept streaming into a session nobody was watching.
          val sid = pendingSessionId
          if (s != null) {
              try {
                  signaling?.sendBye(sid, "本机结束会话")
                  s.notifyBye("本机结束会话")
              } catch (_: Exception) {
              }
          }
          // close() sleeps briefly to let the datagram leave, so it stays off the UI thread.
        thread(name = "disconnect") {
              try {
                  s?.close("本机结束会话")
              } catch (_: Exception) {
            }
        }
        teardownSession()
    }

    private fun teardownSession() {
        inSession = false
        session = null
        pendingPrivate = null
        pendingPublic = null
    }

    fun closeAll() {
        teardownSession()
        signaling?.close()
        signaling = null
        link?.close()
        link = null
    }

    companion object {
        private const val PREFS = "lumen-remote"

        fun loadDeviceId(context: Context): String {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val existing = prefs.getString("deviceId", null)
            if (!existing.isNullOrEmpty()) return existing
            val fresh = randomId()
            prefs.edit().putString("deviceId", fresh).apply()
            return fresh
        }

        fun loadPreferredCode(context: Context): String? =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("deviceCode", null)

        fun savePreferredCode(context: Context, code: String) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("deviceCode", code).apply()
        }

        private fun randomId(): String {
            val bytes = ByteArray(8)
            java.security.SecureRandom().nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}

/** Addresses no client can reach a relay on: private, loopback, link-local, CGNAT. */
private fun unroutableRelay(address: String): Boolean {
    val dotted = if (address.startsWith("::ffff:")) address.removePrefix("::ffff:") else address
    if (dotted == "::1" || dotted.startsWith("127.") || dotted == "localhost") return true
    if (dotted.startsWith("169.254.") || dotted.startsWith("fe80:")) return true
    if (dotted.startsWith("10.") || dotted.startsWith("192.168.")) return true
    if (Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(dotted)) return true
    if (Regex("^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.").containsMatchIn(dotted)) return true
    return false
}

/** One display attached to the host, as offered by the screen picker. */
data class DisplayOption(
    val index: Int,
    val name: String,
    val primary: Boolean,
    val width: Int,
    val height: Int,
    val refreshRate: Int,
)
