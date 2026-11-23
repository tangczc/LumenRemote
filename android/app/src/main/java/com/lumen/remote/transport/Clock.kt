package com.lumen.remote.transport

/** Monotonic microsecond clock; immune to wall-clock jumps. */
object Mono {
    private val originNs = System.nanoTime()

    fun us(): Long = (System.nanoTime() - originNs) / 1000
    fun ms(): Long = (System.nanoTime() - originNs) / 1_000_000
}

data class ClockSample(val t1: Long, val t2: Long, val t3: Long, val t4: Long)

/**
 * NTP-style offset estimation with a minimum-RTT filter. Using the lowest-RTT
 * sample removes the queueing bias that would otherwise inflate the offset
 * whenever the link is congested.
 */
class ClockSync(private val window: Int = 16) {
    private val samples = ArrayList<ClockSample>(window)

    @Synchronized
    fun addSample(s: ClockSample) {
        if (s.t4 < s.t1) return
        samples.add(s)
        if (samples.size > window) samples.removeAt(0)
    }

    @Synchronized
    fun clear() = samples.clear()

    @Synchronized
    fun sampleCount(): Int = samples.size

    @Synchronized
    fun rttUs(): Long {
        val b = best() ?: return 0
        return b.t4 - b.t1 - (b.t3 - b.t2)
    }

    @Synchronized
    fun offsetUs(): Long {
        val b = best() ?: return 0
        return (b.t2 - b.t1 + (b.t3 - b.t4)) / 2
    }

    @Synchronized
    fun synced(): Boolean = samples.size >= 3

    @Synchronized
    fun toLocal(peerUs: Long): Long = peerUs - offsetUs()

    private fun best(): ClockSample? {
        var best: ClockSample? = null
        var bestRtt = Long.MAX_VALUE
        for (s in samples) {
            val rtt = s.t4 - s.t1 - (s.t3 - s.t2)
            if (rtt >= 0 && rtt < bestRtt) {
                bestRtt = rtt
                best = s
            }
        }
        return best
    }
}

/**
 * RFC3550-style jitter estimator over (arrival, sendTs) pairs.
 */
class JitterEstimator {
    private var jitterUs = 0.0
    private var lastTransitUs = 0L

    @Synchronized
    fun add(arrivalUs: Long, sendTsUs: Long) {
        val transit = arrivalUs - sendTsUs
        if (lastTransitUs != 0L) {
            val d = kotlin.math.abs(transit - lastTransitUs).toDouble()
            jitterUs += (d - jitterUs) / 16.0
        }
        lastTransitUs = transit
    }

    @Synchronized
    fun valueUs(): Long = jitterUs.toLong()
}

/**
 * Inter-arrival delay gradient. Signed accumulation matters: reordering
 * produces negative deltas that cancel the matching positive ones, so the
 * estimate stays unbiased on a healthy link.
 */
class DelayGradientEstimator {
    private var prevArrivalUs = 0L
    private var prevSendTsUs = 0L
    private var accumulatedUs = 0.0
    private var samples = 0

    @Synchronized
    fun add(arrivalUs: Long, sendTsUs: Long) {
        if (prevArrivalUs == 0L) {
            prevArrivalUs = arrivalUs
            prevSendTsUs = sendTsUs
            return
        }
        val arrivalDelta = arrivalUs - prevArrivalUs
        val sendDelta = sendTsUs - prevSendTsUs
        prevArrivalUs = arrivalUs
        prevSendTsUs = sendTsUs
        if (arrivalDelta == 0L && sendDelta == 0L) return
        accumulatedUs += (arrivalDelta - sendDelta).toDouble()
        samples++
    }

    @Synchronized
    fun take(): Long {
        val v = if (samples == 0) 0.0 else accumulatedUs / samples
        accumulatedUs = 0.0
        samples = 0
        return v.toLong()
    }
}

/**
 * Dual-signal congestion controller: delay gradient catches queue build-up
 * before loss appears, loss catches what delay cannot see.
 */
class CongestionController(
    initialBps: Double = 8_000_000.0,
    private val minBps: Double = 400_000.0,
    private val maxBps: Double = 60_000_000.0,
) {
    private var target = initialBps
    private var trendUs = 0.0
    private var lastDecreaseMs = -1_000_000_000L
    private var lastIncreaseMs = -1_000_000_000L
    private var lastReportMs = -1_000_000_000L
    private var hasReport = false
    private var consecutiveClean = 0
    private var overuseStreak = 0

    var srttUs = 0.0
        private set
    var lossRate = 0.0
        private set

    @Synchronized
    fun targetBps(): Long = Math.round(target)

    @Synchronized
    fun onSample(lossRate: Double, delayGradientUs: Double, rttUs: Long) {
        val now = System.currentTimeMillis()
        val sinceReport = now - lastReportMs
        lastReportMs = now

        this.lossRate = lossRate
        srttUs = if (srttUs == 0.0) rttUs.toDouble() else srttUs * 0.9 + rttUs * 0.1

        if (!hasReport || (sinceReport > 0 && sinceReport < 500)) {
            trendUs = trendUs * (1 - 0.15) + delayGradientUs * 0.15
        }
        hasReport = true

        val overusing = trendUs > 20_000
        val lossy = lossRate > 0.05
        val mildlyLossy = lossRate > 0.02

        if (overusing || lossy) {
            overuseStreak = if (overusing) overuseStreak + 1 else 0
            val sustained = lossy || overuseStreak >= 3
            if (sustained && now - lastDecreaseMs > 200) {
                target = maxOf(minBps, target * (if (lossy) 0.75 else 0.9))
                lastDecreaseMs = now
                consecutiveClean = 0
            }
            return
        }

        overuseStreak = 0
        if (mildlyLossy) {
            consecutiveClean = 0
            return
        }

        val queueGrowing = trendUs > 5_000
        consecutiveClean = if (queueGrowing) 0 else consecutiveClean + 1
        if (!queueGrowing && consecutiveClean >= 2 && now - lastDecreaseMs > 300 && now - lastIncreaseMs > 120) {
            target = minOf(maxBps, target * 1.25 + 48_000)
            lastIncreaseMs = now
        }
    }

    @Synchronized
    fun setTarget(bps: Long) {
        target = minOf(maxBps, maxOf(minBps, bps.toDouble()))
    }
}
