package com.lumen.remote.transport

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress

data class Endpoint(val address: String, val port: Int) {
    override fun toString(): String = "$address:$port"
}

/**
 * UDP endpoint with candidate fan-out.
 *
 * Every outgoing datagram goes to all candidates until a reply arrives; the
 * first inbound source is adopted as the peer. Both sides opening all of their
 * pinholes in the same instant is what makes a symmetric-NAT punch succeed —
 * probing candidates one at a time lets earlier bindings expire.
 */
class UdpLink(
    private val socket: DatagramSocket = DatagramSocket().apply { soTimeout = 0 },
    private val onPacket: (ByteArray) -> Unit,
) {
    @Volatile
    private var remote: Endpoint? = null

    @Volatile
    private var candidates: List<Endpoint> = emptyList()

    @Volatile
    private var latch = true

    @Volatile
    private var running = false

    private var thread: Thread? = null
    private var txThread: Thread? = null
    private val outbox = java.util.concurrent.ArrayBlockingQueue<ByteArray>(1024)
    private var droppedWrites = 0L

    val localPort: Int get() = socket.localPort

    fun start() {
        if (running) return
        running = true
        try {
            socket.broadcast = true
            socket.receiveBufferSize = 4 * 1024 * 1024
            socket.sendBufferSize = 1024 * 1024
        } catch (_: Exception) {
            // Best effort: the defaults still work, just with less headroom.
        }
        // Android forbids socket I/O on the main thread, and input events are
        // produced there, so every datagram goes through this sender thread.
        txThread = Thread({
            while (running) {
                // close() interrupts this thread; an uncaught InterruptedException
                // on a background thread kills the whole process on Android.
                val packet = try {
                    outbox.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    break
                }
                if (packet == null) continue
                writeNow(packet)
            }
        }, "udp-tx").apply {
            priority = Thread.MAX_PRIORITY
            isDaemon = true
            start()
        }
        thread = Thread({
            val buf = ByteArray(65536)
            while (running) {
                try {
                    val packet = DatagramPacket(buf, buf.size)
                    socket.receive(packet)
                    val from = Endpoint(packet.address.hostAddress ?: "", packet.port)
                    if (latch) {
                        remote = from
                        candidates = emptyList()
                    }
                    onPacket(buf.copyOfRange(0, packet.length))
                } catch (_: Exception) {
                    if (!running) break
                }
            }
        }, "udp-rx").apply {
            priority = Thread.MAX_PRIORITY
            isDaemon = true
            start()
        }
    }

    @Synchronized
    fun setRemote(endpoint: Endpoint?) {
        remote = endpoint
        if (endpoint != null) candidates = emptyList()
    }

    @Synchronized
    fun setCandidates(list: List<Endpoint>) {
        candidates = list.filter { it.port > 0 }
        remote = null
    }

    fun remoteEndpoint(): Endpoint? = remote

    fun latched(): Boolean = remote != null && candidates.isEmpty()

    fun addCandidate(endpoint: Endpoint) {
        if (remote != null) return
        candidates = candidates + endpoint
    }

    fun send(packet: ByteArray) {
        if (!running) {
            writeNow(packet)
            return
        }
        if (!outbox.offer(packet)) droppedWrites++
    }

    fun droppedWriteCount(): Long = droppedWrites

    private fun writeNow(packet: ByteArray) {
        val targets = remote?.let { listOf(it) } ?: candidates
        for (t in targets) {
            try {
                socket.send(
                    DatagramPacket(packet, packet.size, InetSocketAddress(InetAddress.getByName(t.address), t.port)),
                )
            } catch (_: Exception) {
                // A failed datagram is indistinguishable from loss; the session retries.
            }
        }
    }

    fun close() {
        running = false
        try {
            socket.close()
        } catch (_: Exception) {
        }
        thread?.interrupt()
        txThread?.interrupt()
        outbox.clear()
    }

    /**
     * Ask the signalling service for our public UDP endpoint. The 0x01 probe must
     * leave from this same socket, otherwise the token would describe a mapping
     * nobody uses.
     */
    fun discoverEndpoint(host: String, port: Int, timeoutMs: Int = 2000): Pair<String, Endpoint>? {
        return try {
            val previousTimeout = socket.soTimeout
            socket.soTimeout = timeoutMs
            val probe = byteArrayOf(0x01)
            socket.send(DatagramPacket(probe, probe.size, InetSocketAddress(InetAddress.getByName(host), port)))
            val buf = ByteArray(1024)
            val packet = DatagramPacket(buf, buf.size)
            socket.receive(packet)
            val text = String(buf, 0, packet.length, Charsets.UTF_8)
            val json = org.json.JSONObject(text)
            val token = json.optString("token")
            val ep = json.optJSONObject("endpoint") ?: return null
            socket.soTimeout = previousTimeout
            if (token.isEmpty()) null
            else Pair(token, Endpoint(ep.optString("address"), ep.optInt("port")))
        } catch (_: Exception) {
            null
        } finally {
            try {
                socket.soTimeout = 0
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        /** Local IPv4 addrs a peer on the same network can reach. */
        fun hostCandidates(port: Int): List<Endpoint> {
            val out = ArrayList<Endpoint>()
            try {
                for (iface in java.net.NetworkInterface.getNetworkInterfaces()) {
                    if (!iface.isUp || iface.isLoopback) continue
                    for (addr in iface.inetAddresses) {
                        val host = addr.hostAddress ?: continue
                        if (host.contains(':')) continue
                        out.add(Endpoint(host, port))
                    }
                }
            } catch (_: Exception) {
            }
            out.add(Endpoint("127.0.0.1", port))
            return out
        }
    }
}
