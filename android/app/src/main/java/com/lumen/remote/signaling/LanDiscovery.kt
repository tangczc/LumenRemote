package com.lumen.remote.signaling

import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

/**
 * Finds Lumen hosts on the local network.
 *
 * The desktop client already listens on UDP `tcpPort + 1` and answers any
 * datagram whose first byte is `0x01` (`DISCOVER_PREFIX` in `server.ts`) with a
 * JSON body containing the caller's reflexive endpoint plus the TCP port to
 * dial. The reply is unicast, so the packet's source address is the host's own
 * reachable address — exactly what the user would otherwise have to type in by
 * hand, including getting the subnet right.
 */
object LanDiscovery {
    private const val PROBE = 0x01.toByte()
    private const val DEFAULT_TCP_PORT = 7801
    private const val DEFAULT_UDP_PORT = 7802

    data class Host(val address: String, val tcpPort: Int) {
        val display: String get() = "$address:$tcpPort"
    }

    /**
     * Broadcasts a probe and collects replies. Must not run on the main thread:
     * Android throws for any socket I/O there.
     */
    fun scan(timeoutMs: Int = 1800, log: (String) -> Unit = {}): List<Host> {
        val found = LinkedHashMap<String, Host>()
        val socket = DatagramSocket(null)
        try {
            socket.reuseAddress = true
            socket.broadcast = true
            socket.bind(InetSocketAddress(0))
            socket.soTimeout = 250

            val probe = byteArrayOf(PROBE)
            val targets = broadcastTargets().ifEmpty { listOf(InetAddress.getByName("255.255.255.255")) }
            for (target in targets) {
                try {
                    socket.send(DatagramPacket(probe, probe.size, target, DEFAULT_UDP_PORT))
                } catch (e: Exception) {
                    log("发现探测失败 ${target.hostAddress}: ${e.javaClass.simpleName}")
                }
            }

            val deadline = System.currentTimeMillis() + timeoutMs
            val buf = ByteArray(1024)
            while (System.currentTimeMillis() < deadline) {
                val packet = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(packet)
                } catch (_: SocketTimeoutException) {
                    continue
                } catch (e: Exception) {
                    log("发现接收失败 ${e.javaClass.simpleName}")
                    break
                }
                val from = packet.address.hostAddress ?: continue
                val port = parseTcpPort(String(packet.data, 0, packet.length, Charsets.UTF_8))
                val host = Host(from, port)
                found[host.display] = host
            }
        } catch (e: Exception) {
            log("局域网发现不可用 ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {
            }
        }
        return found.values.toList()
    }

    private fun parseTcpPort(body: String): Int = try {
        JSONObject(body).optInt("tcpPort", DEFAULT_TCP_PORT).takeIf { it in 1..65535 } ?: DEFAULT_TCP_PORT
    } catch (_: Exception) {
        DEFAULT_TCP_PORT
    }

    /**
     * Every interface broadcast address we can derive. The global
     * `255.255.255.255` probe covers the common case; the per-interface ones
     * still work when the router drops limited broadcasts.
     */
    private fun broadcastTargets(): List<InetAddress> {
        val out = LinkedHashSet<InetAddress>()
        try {
            InetAddress.getByName("255.255.255.255").let { out.add(it) }
        } catch (_: Exception) {
        }
        try {
            for (nic in NetworkInterface.getNetworkInterfaces()) {
                if (!nic.isUp || nic.isLoopback) continue
                for (ia in nic.interfaceAddresses) {
                    val b = ia.broadcast ?: continue
                    out.add(b)
                }
            }
        } catch (_: Exception) {
        }
        return out.toList()
    }

    /** Local IPv4 addresses, so a subnet mismatch can be spotted in the log. */
    fun localIpv4(): List<String> {
        val out = ArrayList<String>()
        try {
            for (nic in NetworkInterface.getNetworkInterfaces()) {
                if (!nic.isUp || nic.isLoopback) continue
                for (ia in nic.interfaceAddresses) {
                    val address = ia.address ?: continue
                    if (address.address.size == 4) out.add(address.hostAddress ?: continue)
                }
            }
        } catch (_: Exception) {
        }
        return out
    }
}
