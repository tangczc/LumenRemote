package com.lumen.remote.protocol

/** Frame header carried in fragment 0. Matches `src/protocol/frame.ts`. */
data class FrameHeader(
    val frameId: Int,
    val codec: Int,
    val flags: Int,
    val captureTsUs: Long,
    val totalLen: Int,
    val fragCount: Int,
)

object FrameHeaderCodec {
    fun encode(h: FrameHeader): ByteArray {
        val b = ByteArray(Wire.FRAME_HEADER_LEN)
        Bytes.putU16(b, 0, h.frameId)
        b[2] = (h.codec and 0xff).toByte()
        b[3] = (h.flags and 0xff).toByte()
        Bytes.putU64(b, 4, h.captureTsUs)
        Bytes.putU32(b, 12, h.totalLen.toLong())
        Bytes.putU16(b, 16, h.fragCount)
        return b
    }

    fun decode(b: ByteArray, offset: Int = 0): FrameHeader {
        require(b.size >= offset + Wire.FRAME_HEADER_LEN) { "frame header truncated" }
        return FrameHeader(
            frameId = Bytes.getU16(b, offset),
            codec = b[offset + 2].toInt() and 0xff,
            flags = b[offset + 3].toInt() and 0xff,
            captureTsUs = Bytes.getU64(b, offset + 4),
            totalLen = Bytes.getU32(b, offset + 12).toInt(),
            fragCount = Bytes.getU16(b, offset + 16),
        )
    }
}

data class Fragment(val fragIdx: Int, val fragCnt: Int, val data: ByteArray)

/**
 * Split a frame into MTU-sized fragments. Fragment 0 carries the frame header
 * and only the final fragment may be shorter than MAX_PAYLOAD, which lets the FEC
 * layer derive every fragment length from the frame header alone.
 */
object Fragmenter {
    fun fragment(
        frameId: Int,
        codec: Int,
        flags: Int,
        captureTsUs: Long,
        payload: ByteArray,
    ): List<Fragment> {
        val total = Wire.FRAME_HEADER_LEN + payload.size
        val firstCap = Wire.MAX_PAYLOAD - Wire.FRAME_HEADER_LEN

        if (payload.size <= firstCap) {
            val header = FrameHeader(frameId, codec, flags, captureTsUs, total, 1)
            val data = ByteArray(total)
            System.arraycopy(FrameHeaderCodec.encode(header), 0, data, 0, Wire.FRAME_HEADER_LEN)
            System.arraycopy(payload, 0, data, Wire.FRAME_HEADER_LEN, payload.size)
            return listOf(Fragment(0, 1, data))
        }

        val remaining = payload.size - firstCap
        val fragCnt = 1 + (remaining + Wire.MAX_PAYLOAD - 1) / Wire.MAX_PAYLOAD
        val header = FrameHeader(frameId, codec, flags, captureTsUs, total, fragCnt)

        val out = ArrayList<Fragment>(fragCnt)
        val first = ByteArray(Wire.FRAME_HEADER_LEN + firstCap)
        System.arraycopy(FrameHeaderCodec.encode(header), 0, first, 0, Wire.FRAME_HEADER_LEN)
        System.arraycopy(payload, 0, first, Wire.FRAME_HEADER_LEN, firstCap)
        out.add(Fragment(0, fragCnt, first))

        var offset = firstCap
        for (i in 1 until fragCnt) {
            val end = minOf(offset + Wire.MAX_PAYLOAD, payload.size)
            out.add(Fragment(i, fragCnt, payload.copyOfRange(offset, end)))
            offset = end
        }
        return out
    }
}

data class AssembledFrame(
    val frameId: Int,
    val codec: Int,
    val flags: Int,
    val captureTsUs: Long,
    val payload: ByteArray,
    val totalFrags: Int,
)

private class PendingFrame(var header: FrameHeader?, val parts: Array<ByteArray?>, val firstSeenMs: Long) {
    var received = 0
}

/**
 * Reassembles fragments per (channel, frameId). Mirrors `Reassembler` in TS.
 */
class Reassembler(private val ttlMs: Long = 500) {
    private val pending = HashMap<Long, PendingFrame>()

    private fun key(channel: Int, frameId: Int): Long =
        (channel.toLong() shl 16) or (frameId.toLong() and 0xffff)

    @Synchronized
    fun push(
        channel: Int,
        frameId: Int,
        fragIdx: Int,
        fragCnt: Int,
        data: ByteArray,
        nowMs: Long = System.currentTimeMillis(),
    ): AssembledFrame? {
        val k = key(channel, frameId)
        val entry = pending.getOrPut(k) { PendingFrame(null, arrayOfNulls(maxOf(fragCnt, 1)), nowMs) }
        if (fragIdx >= entry.parts.size || entry.parts[fragIdx] != null) return null

        if (fragIdx == 0) {
            if (data.size < Wire.FRAME_HEADER_LEN) return null
            entry.header = FrameHeaderCodec.decode(data, 0)
            entry.parts[0] = data.copyOfRange(Wire.FRAME_HEADER_LEN, data.size)
        } else {
            entry.parts[fragIdx] = data
        }
        entry.received++
        val header = entry.header ?: return null
        if (entry.received != entry.parts.size) return null

        pending.remove(k)
        var total = 0
        for (p in entry.parts) total += p?.size ?: 0
        val payload = ByteArray(total)
        var at = 0
        for (p in entry.parts) {
            if (p == null) continue
            System.arraycopy(p, 0, payload, at, p.size)
            at += p.size
        }
        return AssembledFrame(frameId, header.codec, header.flags, header.captureTsUs, payload, entry.parts.size)
    }

    @Synchronized
    fun missing(channel: Int, frameId: Int): IntArray? {
        val entry = pending[key(channel, frameId)] ?: return null
        val out = ArrayList<Int>()
        for (i in entry.parts.indices) if (entry.parts[i] == null) out.add(i)
        return out.toIntArray()
    }

    @Synchronized
    fun parts(channel: Int, frameId: Int): Array<ByteArray?>? =
        pending[key(channel, frameId)]?.parts?.copyOf()

    @Synchronized
    fun header(channel: Int, frameId: Int): FrameHeader? = pending[key(channel, frameId)]?.header

    @Synchronized
    fun fragCount(channel: Int, frameId: Int): Int = pending[key(channel, frameId)]?.parts?.size ?: 0

    @Synchronized
    fun sweep(nowMs: Long = System.currentTimeMillis()): List<Pair<Int, Int>> {
        val evicted = ArrayList<Pair<Int, Int>>()
        val it = pending.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (nowMs - e.value.firstSeenMs > ttlMs) {
                evicted.add(Pair((e.key ushr 16).toInt(), (e.key and 0xffff).toInt()))
                it.remove()
            }
        }
        return evicted
    }

    @Synchronized
    fun pendingFrames(): List<Triple<Int, Int, Long>> {
        val out = ArrayList<Triple<Int, Int, Long>>(pending.size)
        for ((k, v) in pending) {
            out.add(Triple((k ushr 16).toInt(), (k and 0xffff).toInt(), v.firstSeenMs))
        }
        return out
    }

    @Synchronized
    fun clear() = pending.clear()
}
