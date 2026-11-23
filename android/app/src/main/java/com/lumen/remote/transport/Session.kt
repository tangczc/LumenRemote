package com.lumen.remote.transport

import com.lumen.remote.protocol.Channel
import com.lumen.remote.protocol.Fec
import com.lumen.remote.protocol.FrameHeaderCodec
import com.lumen.remote.protocol.FrameFlags
import com.lumen.remote.protocol.Fragmenter
import com.lumen.remote.protocol.Handshake
import com.lumen.remote.protocol.HeaderCodec
import com.lumen.remote.protocol.Messages
import com.lumen.remote.protocol.NackEntry
import com.lumen.remote.protocol.PacketFlags
import com.lumen.remote.protocol.Reassembler
import com.lumen.remote.protocol.SessionKeys
import com.lumen.remote.protocol.Wire
import com.lumen.remote.protocol.tsDelta32
import com.lumen.remote.protocol.unwrapTs32
import java.util.concurrent.atomic.AtomicLong

data class IncomingFrame(
    val channel: Int,
    val frameId: Int,
    val codec: Int,
    val flags: Int,
    val captureTsUs: Long,
    val payload: ByteArray,
    val oneWayUs: Long,
    val recovered: Boolean,
    val totalFrags: Int,
)

data class SessionStats(
    val rttMs: Double,
    val oneWayMs: Double,
    val lossPct: Double,
    val jitterMs: Double,
    val targetKbps: Long,
    val recvMbps: Double,
    val fps: Int,
    val frames: Long,
    val recoveredFrames: Long,
    val droppedFrames: Long,
    val clockSamples: Int,
    val sas: String,
)

/**
 * Controller endpoint of a session: sequencing, AEAD, FEC, retransmission,
 * congestion feedback and QoE accounting. Byte-compatible with
 * `src/transport/session.ts`.
 */
class Session(
    val sessionId: String,
    val isHost: Boolean,
    keys: SessionKeys,
    private val link: UdpLink,
    initialBitrateBps: Long = 8_000_000,
    maxBitrateBps: Long = 40_000_000,
    private val log: (String) -> Unit = {},
    private val onFrame: (IncomingFrame) -> Unit,
    private val onInput: (org.json.JSONObject) -> Unit = {},
    private val onControl: (org.json.JSONObject) -> Unit = {},
    private val onStats: (SessionStats) -> Unit = {},
) {
    val sas: String = keys.sas

    private val dirKeys = Handshake.directional(keys, isHost)
    private val pacer = Pacer(
        rateBps = initialBitrateBps,
        send = { p ->
            txBytes.addAndGet(p.size.toLong())
            txPackets.addAndGet(1)
            link.send(p)
        },
    )
    private val cc = CongestionController(initialBps = initialBitrateBps.toDouble(), maxBps = maxBitrateBps.toDouble())
    private val reassembler = Reassembler(400)
    private val clock = ClockSync()
    private val gradient = DelayGradientEstimator()
    private val jitter = JitterEstimator()

    private val parity = HashMap<Long, ParityEntry>()
    private val retx = HashMap<String, RetxEntry>()
    private val nackSentAt = HashMap<Long, Long>()
    private val completed = LinkedHashSet<Long>()

    private var txSeq = (Math.random() * 0xffff_ffffL).toLong() and 0xffff_ffffL
    private var txFrameId = (Math.random() * 0xffff).toInt() and 0xffff
    private var txInputSeq = 0
    private var rxInputSeq = -1

    private val txBytes = AtomicLong()
    private val txPackets = AtomicLong()
    private var rxBytes = 0L
    private var rxPackets = 0L
    private var authFailures = 0L
    @Volatile
    private var packetsReceived = 0L
    private var framesReceived = 0L
    private var recoveredFrames = 0L
    private var droppedFrames = 0L
    private var intervalFrames = 0
    private var lastFpsAt = Mono.ms()
    private var fps = 0

    private var rxHighest = -1L
    private var rxBaseline = -1L
    private val rxWindow = ByteArray(RX_WINDOW)
    private val rxWindowSeq = LongArray(RX_WINDOW)
    private var lastLossPct = 0.0

    @Volatile
    private var closed = false

    private var ticker: Thread? = null
    private var pingCounter = 0L

    private class ParityEntry(val fragCnt: Int, val createdAtMs: Long) {
        val parities = HashMap<Int, ByteArray>()
        var r = 0
    }

    private class RetxEntry(
        val channel: Int,
        val frameId: Int,
        val fragIdx: Int,
        val fragCnt: Int,
        val flags: Int,
        val payload: ByteArray,
        val expiresAtMs: Long,
    )

    fun start() {
        link.start()
        sendPing()
        val started = Mono.ms()
        ticker = Thread({
            var nextPump = Mono.us()
            while (!closed) {
                val nowUs = Mono.us()
                if (nowUs >= nextPump) {
                    pacer.pump()
                    nextPump = nowUs + 1_000
                }
                val nowMs = Mono.ms()
                if (nowMs - lastReportMs >= REPORT_INTERVAL_MS) {
                    lastReportMs = nowMs
                    sendReport()
                }
                if (nowMs - lastNackMs >= NACK_INTERVAL_MS) {
                    lastNackMs = nowMs
                    sendNacks()
                }
                if (nowMs - lastPingMs >= PING_INTERVAL_MS) {
                    lastPingMs = nowMs
                    sendPing()
                }
                if (nowMs - lastStatsMs >= STATS_INTERVAL_MS) {
                    lastStatsMs = nowMs
                    emitStats()
                }
                if (nowMs - lastSweepMs >= SWEEP_INTERVAL_MS) {
                    lastSweepMs = nowMs
                    sweep()
                }
                val sleepUs = nextPump - Mono.us()
                if (sleepUs > 200) {
                    // Thread.sleep(0, nanos) rejects nanos > 999_999, and the old
                    // clamp allowed exactly 1_000_000, which killed this thread —
                    // and with it the whole process — about a second into every
                    // session.
                    val millis = sleepUs / 1000
                    val nanos = ((sleepUs % 1000) * 1000).toInt().coerceIn(0, 999_999)
                    try {
                        Thread.sleep(millis, nanos)
                    } catch (_: InterruptedException) {
                        break
                    }
                }
            }
            log("ticker stopped after ${Mono.ms() - started}ms")
        }, "session-tick").apply {
            priority = Thread.MAX_PRIORITY
            isDaemon = true
            start()
        }
    }

    private var lastReportMs = 0L
    private var lastNackMs = 0L
    private var lastPingMs = 0L
    private var lastStatsMs = 0L
    private var lastSweepMs = 0L

    fun close(reason: String = "closed") {
        if (closed) return
        closed = true
        try {
            sendControl(Messages.bye(reason))
            // Give the datagram a moment to leave before the socket closes.
            Thread.sleep(30)
        } catch (_: Exception) {
        }
        link.close()
    }

    fun requestKeyframe() = sendControl(Messages.idr())

    /** Queue a bye immediately; the outgoing queue is thread-safe. */
    fun notifyBye(reason: String) = sendControl(Messages.bye(reason))

    fun sendHello(ephBase64: String, display: Triple<Int, Int, Int>? = null) {
        sendControl(Messages.hello(sessionId, isHost, "", ephBase64, display))
    }

    fun packetsReceived(): Long = packetsReceived

    fun latched(): Boolean = link.latched()

    /** Entry point from the UDP receive thread. */
    fun onDatagram(packet: ByteArray) = onPacket(packet)

    // ------------------------------------------------------------------ sending

    @Synchronized
    fun sendInput(payload: ByteArray) {
        txInputSeq = (txInputSeq + 1) and 0xffff
        val body = ByteArray(2 + payload.size)
        body[0] = ((txInputSeq ushr 8) and 0xff).toByte()
        body[1] = (txInputSeq and 0xff).toByte()
        System.arraycopy(payload, 0, body, 2, payload.size)
        // Three redundant copies, deduplicated by sequence at the receiver, so a
        // single lost datagram never drops a click or a keystroke.
        for (i in 0 until 3) {
            if (closed) return
            sendPacket(Channel.INPUT, 0, 0, i, 3, 0, body, 0)
        }
    }

    fun sendControl(payload: ByteArray) {
        if (payload.size > Wire.MAX_PAYLOAD - 8) {
            log("control message too large: ${payload.size}")
            return
        }
        sendPacket(Channel.CONTROL, 0, 0, 0, 1, 0, payload, 0)
    }

    private fun sendPacket(
        channel: Int,
        frameId: Int,
        flags: Int,
        fragIdx: Int,
        fragCnt: Int,
        fecIdx: Int,
        payload: ByteArray,
        priority: Int,
    ) {
        val size = Wire.HEADER_LEN + payload.size + Wire.AUTH_TAG_LEN
        val build = {
            txSeq = (txSeq + 1) and 0xffff_ffffL
            val seq = txSeq
            val header = HeaderCodec.encode(
                com.lumen.remote.protocol.PacketHeader(
                    seq = seq,
                    sendTsUs = Mono.us() and 0xffff_ffffL,
                    channel = channel,
                    frameId = frameId,
                    flags = flags,
                    fragIdx = fragIdx,
                    fragCnt = fragCnt,
                    fecIdx = fecIdx,
                ),
            )
            val sealed = dirKeys.tx.seal(seq, header, payload)
            val out = ByteArray(header.size + sealed.size)
            System.arraycopy(header, 0, out, 0, header.size)
            System.arraycopy(sealed, 0, out, header.size, sealed.size)
            out
        }
        if (!pacer.enqueue(build, size, priority)) return
        if (priority == 0) pacer.flushImmediately()
    }

    // ---------------------------------------------------------------- receiving

    private fun onPacket(packet: ByteArray) {
        if (closed || packet.size <= Wire.HEADER_LEN) return
        val header = try {
            HeaderCodec.decode(packet)
        } catch (_: Exception) {
            return
        }
        val aad = packet.copyOfRange(0, Wire.HEADER_LEN)
        val sealed = packet.copyOfRange(Wire.HEADER_LEN, packet.size)
        val payload = dirKeys.rx.open(header.seq, aad, sealed) ?: run {
            authFailures++
            return
        }

        rxBytes += packet.size
        rxPackets++
        packetsReceived++

        val slot = (header.seq and (RX_WINDOW - 1).toLong()).toInt()
        if (rxWindow[slot].toInt() != 1 || rxWindowSeq[slot] != header.seq) {
            rxWindowSeq[slot] = header.seq
            rxWindow[slot] = 1
        }
        val delta = if (rxHighest < 0) 0 else tsDelta32(header.seq, rxHighest)
        if (rxHighest < 0 || delta > 0) rxHighest = header.seq
        if (rxBaseline < 0) rxBaseline = header.seq

        val receiveUs = Mono.us()
        val sendAbs = unwrapTs32(header.sendTsUs, receiveUs)
        gradient.add(receiveUs, sendAbs)
        jitter.add(receiveUs, sendAbs)

        when (header.channel) {
            Channel.CONTROL -> handleControl(payload, receiveUs)
            Channel.INPUT -> {
                if (payload.size < 3) return
                val seq = ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff)
                val d = if (rxInputSeq < 0) 1 else (((seq - rxInputSeq) shl 16) shr 16)
                if (d <= 0) return
                rxInputSeq = seq
                Messages.parse(payload.copyOfRange(2, payload.size))?.let(onInput)
            }
            Channel.VIDEO, Channel.AUDIO, Channel.FILE -> handleMedia(header, payload, receiveUs)
        }
    }

    private fun handleControl(payload: ByteArray, receiveUs: Long) {
        val msg = Messages.parse(payload) ?: return
        when (msg.optString("t")) {
            "report" -> {
                val r = msg.optJSONObject("report") ?: return
                val lost = r.optInt("lost")
                val received = r.optInt("received")
                if (lost == 0 && received == 0) return
                cc.onSample(
                    lossRate = lost.toDouble() / maxOf(1, lost + received),
                    delayGradientUs = r.optDouble("delayGradientUs", 0.0),
                    rttUs = maxOf(1L, clock.rttUs().takeIf { it > 0 } ?: 30_000L),
                )
                val target = cc.targetBps()
                if (Math.abs(target - pacer.rateBps()) / maxOf(1.0, pacer.rateBps().toDouble()) > 0.03) {
                    pacer.setRate(target)
                }
                return
            }
            "nack" -> {
                onNack(msg)
                return
            }
            "ping" -> {
                sendControl(Messages.pong(msg.optLong("n"), msg.optLong("t1"), receiveUs, Mono.us()))
                return
            }
            "pong" -> {
                clock.addSample(ClockSample(msg.optLong("t1"), msg.optLong("t2"), msg.optLong("t3"), receiveUs))
                return
            }
            "bye" -> {
                closed = true
                return
            }
        }
        onControl(msg)
    }

    private fun handleMedia(header: com.lumen.remote.protocol.PacketHeader, payload: ByteArray, receiveUs: Long) {
        val channel = header.channel
        val frameId = header.frameId
        val frameKey = (channel.toLong() shl 16) or frameId.toLong()

        if (completed.contains(frameKey)) return

        if (header.flags and PacketFlags.FEC_PARITY != 0) {
            val entry = parity.getOrPut(frameKey) { ParityEntry(header.fragCnt, System.currentTimeMillis()) }
            entry.parities[header.fecIdx] = payload
            entry.r = maxOf(entry.r, header.fecIdx + 1)
            tryRecover(channel, frameId, receiveUs)
            return
        }

        val done = reassembler.push(channel, frameId, header.fragIdx, header.fragCnt, payload)
        if (done != null) {
            emitFrame(
                IncomingFrame(
                    channel = channel,
                    frameId = frameId,
                    codec = done.codec,
                    flags = done.flags,
                    captureTsUs = done.captureTsUs,
                    payload = done.payload,
                    oneWayUs = 0,
                    recovered = false,
                    totalFrags = done.totalFrags,
                ),
                receiveUs,
            )
            markComplete(frameKey)
            return
        }
        tryRecover(channel, frameId, receiveUs)
    }

    private fun tryRecover(channel: Int, frameId: Int, receiveUs: Long) {
        val key = (channel.toLong() shl 16) or frameId.toLong()
        val entry = parity[key] ?: return
        if (entry.parities.isEmpty()) return
        val parts = reassembler.parts(channel, frameId) ?: return

        val header = reassembler.header(channel, frameId)
        val lengthOf: (Int) -> Int = { i ->
            if (header == null) {
                Wire.MAX_PAYLOAD
            } else {
                val payloadLen = header.totalLen - Wire.FRAME_HEADER_LEN
                if (header.fragCount == 1) {
                    payloadLen
                } else {
                    val firstPayload =
                        minOf(Wire.MAX_PAYLOAD, Wire.FRAME_HEADER_LEN + payloadLen) - Wire.FRAME_HEADER_LEN
                    val consumed = firstPayload + (i - 1) * Wire.MAX_PAYLOAD
                    if (i == 0) firstPayload else maxOf(0, minOf(Wire.MAX_PAYLOAD, payloadLen - consumed))
                }
            }
        }

        val recovered = Fec.recoverMissing(parts, entry.parities, entry.r, lengthOf)
        if (recovered.isEmpty()) return

        var completedFrame: com.lumen.remote.protocol.AssembledFrame? = null
        for ((idx, raw) in recovered) {
            var data = raw
            if (idx == 0 && data.size >= Wire.FRAME_HEADER_LEN) {
                try {
                    val h = FrameHeaderCodec.decode(data, 0)
                    val payloadLen = h.totalLen - Wire.FRAME_HEADER_LEN
                    val firstPayload = minOf(Wire.MAX_PAYLOAD, Wire.FRAME_HEADER_LEN + payloadLen) - Wire.FRAME_HEADER_LEN
                    data = data.copyOfRange(0, Wire.FRAME_HEADER_LEN + firstPayload)
                } catch (_: Exception) {
                }
            }
            val out = reassembler.push(channel, frameId, idx, entry.fragCnt, data)
            if (out != null) completedFrame = out
        }

        val done = completedFrame ?: return
        recoveredFrames++
        emitFrame(
            IncomingFrame(
                channel = channel,
                frameId = frameId,
                codec = done.codec,
                flags = done.flags,
                captureTsUs = done.captureTsUs,
                payload = done.payload,
                oneWayUs = 0,
                recovered = true,
                totalFrags = done.totalFrags,
            ),
            receiveUs,
        )
        markComplete(key)
    }

    private fun markComplete(frameKey: Long) {
        completed.add(frameKey)
        parity.remove(frameKey)
        nackSentAt.remove(frameKey)
        if (completed.size > 512) {
            val it = completed.iterator()
            if (it.hasNext()) {
                it.next()
                it.remove()
            }
        }
    }

    private fun emitFrame(frame: IncomingFrame, receiveUs: Long) {
        framesReceived++
        intervalFrames++
        var oneWay = 0L
        if (clock.synced()) {
            val captureLocal = clock.toLocal(frame.captureTsUs)
            if (captureLocal > 0) oneWay = maxOf(0L, receiveUs - captureLocal)
        }
        onFrame(frame.copy(oneWayUs = oneWay))
    }

    private fun onNack(msg: org.json.JSONObject) {
        val now = System.currentTimeMillis()
        val entries = msg.optJSONArray("entries") ?: return
        var budget = maxOf(4, entries.length() * 2)
        for (i in 0 until entries.length()) {
            val e = entries.optJSONObject(i) ?: continue
            val ch = e.optInt("channel")
            val frameId = e.optInt("frameId")
            val frags = e.optJSONArray("frags") ?: continue
            for (j in 0 until frags.length()) {
                if (budget-- <= 0) return
                val entry = retx["$ch:$frameId:${frags.optInt(j)}"] ?: continue
                if (entry.expiresAtMs < now) continue
                sendPacket(
                    entry.channel,
                    entry.frameId,
                    entry.flags or PacketFlags.RETRANSMIT,
                    entry.fragIdx,
                    entry.fragCnt,
                    0,
                    entry.payload,
                    1,
                )
            }
        }
    }

    private fun measureLoss(): Triple<Int, Int, Double> {
        if (rxHighest < 0) return Triple(0, 0, 0.0)
        val hi = rxHighest - RX_REORDER_SLACK
        val lo = maxOf(rxBaseline, hi - RX_MEASURE_WINDOW + 1)
        var received = 0
        var total = 0
        var seq = lo
        while (seq <= hi) {
            total++
            val slot = (seq and (RX_WINDOW - 1).toLong()).toInt()
            if (rxWindow[slot].toInt() == 1 && rxWindowSeq[slot] == seq) received++
            seq++
        }
        if (total == 0) return Triple(0, 0, 0.0)
        val lost = total - received
        return Triple(lost, received, lost.toDouble() / total)
    }

    private fun sendReport() {
        val (lost, received, ratio) = measureLoss()
        lastLossPct = minOf(100.0, ratio * 100)
        sendControl(
            Messages.report(
                hi = if (rxHighest < 0) 0 else rxHighest,
                lost = lost,
                received = received,
                gradientUs = gradient.take(),
                jitterUs = jitter.valueUs(),
                nowUs = Mono.us(),
            ),
        )
    }

    private fun sendNacks() {
        val now = System.currentTimeMillis()
        val entries = ArrayList<NackEntry>()
        val queueDelayMs = pacer.pendingBytes() * 8.0 / maxOf(1.0, pacer.rateBps().toDouble()) * 1000
        val graceMs = maxOf(30.0, clock.rttUs() / 1000.0 + queueDelayMs * 0.5)
        for ((channel, frameId, firstSeen) in reassembler.pendingFrames()) {
            val missing = reassembler.missing(channel, frameId) ?: continue
            if (missing.isEmpty()) continue
            val key = (channel.toLong() shl 16) or frameId.toLong()
            val last = nackSentAt[key] ?: 0L
            if (now - last < NACK_THROTTLE_MS) continue
            if (now - firstSeen < graceMs) continue
            nackSentAt[key] = now
            entries.add(NackEntry(channel, frameId, missing.take(8)))
            if (entries.size >= 8) break
        }
        if (entries.isNotEmpty()) sendControl(Messages.nack(entries))
    }

    private fun sendPing() {
        pingCounter = (pingCounter + 1) and 0xffff_ffffL
        sendControl(Messages.ping(pingCounter, Mono.us()))
    }

    private fun sweep() {
        for ((channel, frameId) in reassembler.sweep()) {
            droppedFrames++
            val key = (channel.toLong() shl 16) or frameId.toLong()
            parity.remove(key)
            nackSentAt.remove(key)
        }
        val now = System.currentTimeMillis()
        val pit = parity.entries.iterator()
        while (pit.hasNext()) {
            if (now - pit.next().value.createdAtMs > PARITY_TTL_MS) pit.remove()
        }
        val rit = retx.entries.iterator()
        while (rit.hasNext()) {
            if (rit.next().value.expiresAtMs < now) rit.remove()
        }
    }

    private fun emitStats() {
        val now = Mono.ms()
        if (now - lastFpsAt >= 500) {
            fps = (intervalFrames * 1000.0 / (now - lastFpsAt)).toInt()
            intervalFrames = 0
            lastFpsAt = now
        }
        onStats(
            SessionStats(
                rttMs = clock.rttUs() / 1000.0,
                oneWayMs = 0.0,
                lossPct = lastLossPct,
                jitterMs = jitter.valueUs() / 1000.0,
                targetKbps = pacer.rateBps() / 1000,
                recvMbps = 0.0,
                fps = fps,
                frames = framesReceived,
                recoveredFrames = recoveredFrames,
                droppedFrames = droppedFrames,
                clockSamples = clock.sampleCount(),
                sas = sas,
            ),
        )
    }

    /** Video frame sink used by the controller; kept for symmetry with the host. */
    fun sendVideoFrame(codec: Int, flags: Int, payload: ByteArray): Int {
        if (closed) return -1
        val frameId = txFrameId
        txFrameId = (txFrameId + 1) and 0xffff
        val fragments = Fragmenter.fragment(frameId, codec, flags, Mono.us(), payload)
        for (f in fragments) {
            val pktFlags = if (flags and FrameFlags.KEY != 0) PacketFlags.KEY else 0
            sendPacket(Channel.VIDEO, frameId, pktFlags, f.fragIdx, f.fragCnt, 0, f.data, 1)
            retx["${Channel.VIDEO}:$frameId:${f.fragIdx}"] = RetxEntry(
                Channel.VIDEO,
                frameId,
                f.fragIdx,
                f.fragCnt,
                pktFlags,
                f.data,
                System.currentTimeMillis() + maxOf(200, clock.rttUs() / 1000 * 2),
            )
        }
        return frameId
    }

    companion object {
        private const val REPORT_INTERVAL_MS = 20L
        private const val NACK_INTERVAL_MS = 10L
        private const val PING_INTERVAL_MS = 250L
        private const val STATS_INTERVAL_MS = 500L
        private const val SWEEP_INTERVAL_MS = 200L
        private const val NACK_THROTTLE_MS = 20L
        private const val PARITY_TTL_MS = 500L
        private const val RX_WINDOW = 2048
        private const val RX_MEASURE_WINDOW = 1024L
        private const val RX_REORDER_SLACK = 128L
    }
}
