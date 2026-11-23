package com.lumen.remote.transport

/**
 * Token-bucket pacer with two priorities.
 *
 * Packets are queued as builders so the header (and therefore the send
 * timestamp and AEAD nonce) is produced at the instant of transmission.
 * Stamping at enqueue time would make the pacer's own queue look like network
 * queueing to the delay-gradient controller.
 */
class Pacer(
    rateBps: Long,
    private val maxQueueMs: Long = 70,
    private val burstMs: Long = 200,
    private val maxQueueBytes: Long = 4_000_000,
    private val send: (ByteArray) -> Unit,
) {
    private class Item(val build: () -> ByteArray, val size: Int)

    private val high = ArrayDeque<Item>()
    private val low = ArrayDeque<Item>()
    private var tokens = 0.0
    private var lastTickUs = Mono.us()

    @Volatile
    private var rate = rateBps.toDouble()

    private var queuedBytes = 0L
    private var minQueueBytes = 0L
    var droppedBytes = 0L
        private set

    @Synchronized
    fun setRate(bps: Long) {
        rate = maxOf(8_000.0, bps.toDouble())
    }

    @Synchronized
    fun rateBps(): Long = Math.round(rate)

    @Synchronized
    fun pendingBytes(): Long = queuedBytes

    private fun queueBudgetBytes(): Long = maxOf(
        minQueueBytes,
        minOf(maxQueueBytes, maxOf(4_000L, (rate / 8.0 * (burstMs / 1000.0)).toLong())),
    )

    @Synchronized
    fun queueBudget(): Long = queueBudgetBytes()

    /**
     * Tell the pacer how large the biggest expected frame is, so keyframes are
     * never larger than the queue budget and their own fragments are not shed.
     */
    @Synchronized
    fun setFrameSizeHint(bytes: Int) {
        minQueueBytes = maxOf(0L, (bytes * 1.1).toLong())
    }

    @Synchronized
    fun wouldOverflow(size: Int): Boolean = queuedBytes + size > queueBudgetBytes()

    @Synchronized
    fun clearMedia() {
        for (item in low) queuedBytes -= item.size
        low.clear()
    }

    /** @param priority 0 = control/input, 1 = media */
    @Synchronized
    fun enqueue(build: () -> ByteArray, size: Int, priority: Int): Boolean {
        if (priority == 1 && queuedBytes + size > queueBudgetBytes()) {
            droppedBytes += size
            return false
        }
        (if (priority == 0) high else low).addLast(Item(build, size))
        queuedBytes += size
        pump()
        return true
    }

    /** Send high-priority traffic immediately, bypassing the token bucket. */
    @Synchronized
    fun flushImmediately() {
        while (high.isNotEmpty()) {
            val item = high.removeFirst()
            queuedBytes -= item.size
            emit(item)
        }
    }

    private fun emit(item: Item) {
        val packet = item.build()
        send(packet)
    }

    @Synchronized
    fun pump() {
        val now = Mono.us()
        val elapsedUs = now - lastTickUs
        lastTickUs = now
        if (elapsedUs > 0) tokens += rate / 8.0 * (elapsedUs / 1_000_000.0)
        tokens = minOf(tokens, rate / 8.0 * 0.02)

        while (high.isNotEmpty() && tokens >= high.first().size) {
            val item = high.removeFirst()
            tokens -= item.size
            queuedBytes -= item.size
            emit(item)
        }
        while (high.isEmpty() && low.isNotEmpty() && tokens >= low.first().size) {
            val item = low.removeFirst()
            tokens -= item.size
            queuedBytes -= item.size
            emit(item)
        }
    }
}
