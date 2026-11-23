package com.lumen.remote.protocol

/**
 * Interleaved XOR FEC. Data packet `i` belongs to parity group `i % r`, so a
 * block repairs up to one loss per group. Mirrors `src/protocol/fec.ts`.
 */
object Fec {
    fun xorInto(acc: ByteArray, src: ByteArray) {
        val n = minOf(acc.size, src.size)
        for (i in 0 until n) acc[i] = (acc[i].toInt() xor src[i].toInt()).toByte()
    }

    /** Build `r` parity buffers for `data` (indexed by fragment index). */
    fun buildParity(data: List<ByteArray?>, r: Int): List<ByteArray> {
        if (r <= 0) return emptyList()
        var maxLen = 0
        for (d in data) if (d != null && d.size > maxLen) maxLen = d.size
        val parity = ArrayList<ByteArray>(r)
        repeat(r) { parity.add(ByteArray(maxLen)) }
        for (i in data.indices) {
            val d = data[i] ?: continue
            xorInto(parity[i % r], d)
        }
        return parity
    }

    /**
     * Recover missing fragments using parity. Returns index -> buffer.
     */
    fun recoverMissing(
        parts: Array<ByteArray?>,
        parity: Map<Int, ByteArray>,
        r: Int,
        lengthOf: (Int) -> Int,
    ): Map<Int, ByteArray> {
        val recovered = HashMap<Int, ByteArray>()
        if (r <= 0) return recovered

        for (j in 0 until r) {
            val par = parity[j] ?: continue
            val members = ArrayList<Int>()
            val missing = ArrayList<Int>()
            var i = j
            while (i < parts.size) {
                members.add(i)
                if (parts[i] == null) missing.add(i)
                i += r
            }
            if (missing.size != 1) continue

            val acc = par.copyOf()
            for (m in members) {
                val d = parts[m]
                if (d != null) xorInto(acc, d)
            }
            val target = missing[0]
            val len = lengthOf(target).coerceIn(0, acc.size)
            recovered[target] = acc.copyOfRange(0, len)
        }
        return recovered
    }

    fun parityCountFor(fragCount: Int, lossRate: Double, minRatio: Double = 0.125, maxRatio: Double = 0.5): Int {
        if (fragCount <= 1) return 0
        val ratio = minOf(maxRatio, maxOf(minRatio, lossRate * 2.5 + minRatio))
        return maxOf(1, minOf((fragCount * ratio).toInt(), 64))
    }
}
