package com.lumen.remote.protocol

/** Fixed 20-byte packet header. Field order matches `encodeHeader` in TS. */
data class PacketHeader(
    val seq: Long,
    val sendTsUs: Long,
    val channel: Int,
    val frameId: Int,
    val flags: Int,
    val fragIdx: Int,
    val fragCnt: Int,
    val fecIdx: Int,
)

object Bytes {
    fun putU16(b: ByteArray, at: Int, v: Int) {
        b[at] = ((v ushr 8) and 0xff).toByte()
        b[at + 1] = (v and 0xff).toByte()
    }

    fun putU32(b: ByteArray, at: Int, v: Long) {
        b[at] = ((v ushr 24) and 0xff).toByte()
        b[at + 1] = ((v ushr 16) and 0xff).toByte()
        b[at + 2] = ((v ushr 8) and 0xff).toByte()
        b[at + 3] = (v and 0xff).toByte()
    }

    fun putU64(b: ByteArray, at: Int, v: Long) {
        for (i in 0 until 8) b[at + i] = ((v ushr (56 - i * 8)) and 0xff).toByte()
    }

    fun getU16(b: ByteArray, at: Int): Int =
        ((b[at].toInt() and 0xff) shl 8) or (b[at + 1].toInt() and 0xff)

    fun getU32(b: ByteArray, at: Int): Long =
        ((b[at].toLong() and 0xff) shl 24) or
            ((b[at + 1].toLong() and 0xff) shl 16) or
            ((b[at + 2].toLong() and 0xff) shl 8) or
            (b[at + 3].toLong() and 0xff)

    fun getU64(b: ByteArray, at: Int): Long {
        var v = 0L
        for (i in 0 until 8) v = (v shl 8) or (b[at + i].toLong() and 0xff)
        return v
    }
}

object HeaderCodec {
    fun encode(h: PacketHeader): ByteArray {
        val b = ByteArray(Wire.HEADER_LEN)
        Bytes.putU32(b, 0, h.seq)
        Bytes.putU32(b, 4, h.sendTsUs)
        Bytes.putU16(b, 8, h.channel)
        Bytes.putU16(b, 10, h.frameId)
        b[12] = (h.flags and 0xff).toByte()
        Bytes.putU16(b, 13, h.fragIdx)
        Bytes.putU16(b, 15, h.fragCnt)
        b[17] = (h.fecIdx and 0xff).toByte()
        return b
    }

    fun decode(b: ByteArray, offset: Int = 0): PacketHeader {
        require(b.size >= offset + Wire.HEADER_LEN) { "packet too short" }
        return PacketHeader(
            seq = Bytes.getU32(b, offset),
            sendTsUs = Bytes.getU32(b, offset + 4),
            channel = Bytes.getU16(b, offset + 8),
            frameId = Bytes.getU16(b, offset + 10),
            flags = b[offset + 12].toInt() and 0xff,
            fragIdx = Bytes.getU16(b, offset + 13),
            fragCnt = Bytes.getU16(b, offset + 15),
            fecIdx = b[offset + 17].toInt() and 0xff,
        )
    }
}

/** Wrap-aware signed difference between two 32-bit sequence/timestamp values. */
fun tsDelta32(later: Long, earlier: Long): Int = (later - earlier).toInt()

/**
 * Rebuild a full 32-bit timestamp from a wrapped one, choosing the epoch nearest
 * to [refAbs].
 */
fun unwrapTs32(ts32: Long, refAbs: Long): Long {
    val two32 = 0x1_0000_0000L
    val base = Math.floorDiv(refAbs, two32) * two32
    var v = base + (ts32 and 0xffff_ffffL)
    if (v > refAbs + two32 / 2) v -= two32
    if (v < refAbs - two32 / 2) v += two32
    return v
}
