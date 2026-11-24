package com.lumen.remote.media

import android.media.MediaCodec
import android.media.MediaFormat
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * H.264 decoder feeding a SurfaceView through MediaCodec.
 *
 * The desktop host sends Annex-B with SPS/PPS inline before every IDR, so the
 * decoder needs no out-of-band csd buffers. Resolution can change between
 * sessions (1080p laptop vs 4K desktop), so the codec is recreated whenever a
 * keyframe's SPS reports a different size.
 */
class H264Decoder(
    private var surface: Surface,
    private val log: (String) -> Unit,
    private val onSize: (width: Int, height: Int) -> Unit,
    private val onNeedKeyframe: () -> Unit,
) {
    private class Item(val data: ByteArray, val keyframe: Boolean)

    private val queue = ArrayBlockingQueue<Item>(3)
    private var codec: MediaCodec? = null
    private var worker: Thread? = null

    @Volatile
    private var running = false

    @Volatile
    private var currentWidth = 0

    @Volatile
    private var currentHeight = 0

    @Volatile
    private var awaitingKeyframe = true

    private var framesIn = 0L
    private var framesOut = 0L
    private var dropped = 0L

    fun start() {
        if (running) return
        running = true
        worker = Thread({ loop() }, "h264-decoder").apply {
            priority = Thread.MAX_PRIORITY
            isDaemon = true
            start()
        }
    }

    fun updateSurface(newSurface: Surface?) {
        if (newSurface == null) return
        surface = newSurface
        // The codec keeps the old Surface; recreate on the next keyframe.
        releaseCodec()
        awaitingKeyframe = true
    }

    fun submit(data: ByteArray, keyframe: Boolean) {
        if (keyframe) {
            val sps = findNal(data, 7)
            if (sps != null) {
                val dims = SpsParser.parse(sps)
                if (dims != null && (dims.first != currentWidth || dims.second != currentHeight || codec == null)) {
                    currentWidth = dims.first
                    currentHeight = dims.second
                    releaseCodec()
                    onSize(dims.first, dims.second)
                }
            }
            awaitingKeyframe = false
        } else if (awaitingKeyframe) {
            return
        }

        if (!queue.offer(Item(data, keyframe))) {
            // Decoding is behind. Dropping a P-frame leaves the reference chain
            // broken, so clear everything and wait for a fresh IDR.
            queue.clear()
            awaitingKeyframe = true
            dropped++
            onNeedKeyframe()
            queue.offer(Item(data, keyframe))
        }
    }

    private fun loop() {
        val info = MediaCodec.BufferInfo()
        while (running) {
            // stop() interrupts this thread; an escaping InterruptedException
            // would crash the process instead of ending the loop.
            val item = try {
                queue.poll(200, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                break
            }
            try {
                val c = codec ?: ensureCodec()
                if (c == null) continue

                if (item != null) {
                    val inIndex = c.dequeueInputBuffer(10_000)
                    if (inIndex >= 0) {
                        val buf: ByteBuffer = c.getInputBuffer(inIndex)!!
                        buf.clear()
                        buf.put(item.data)
                        val pts = framesIn * 16_666L
                        framesIn++
                        c.queueInputBuffer(inIndex, 0, item.data.size, pts, 0)
                    } else {
                        // No input buffer yet: re-queue and drain output first.
                        queue.offer(item)
                    }
                }

                while (true) {
                    val outIndex = c.dequeueOutputBuffer(info, 0)
                    when {
                        outIndex >= 0 -> {
                            c.releaseOutputBuffer(outIndex, true)
                            framesOut++
                        }
                        outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            val fmt = c.outputFormat
                            val w = fmt.getInteger(MediaFormat.KEY_WIDTH)
                            val h = fmt.getInteger(MediaFormat.KEY_HEIGHT)
                            if (w > 0 && h > 0 && (w != currentWidth || h != currentHeight)) {
                                currentWidth = w
                                currentHeight = h
                                onSize(w, h)
                            }
                        }
                        else -> break
                    }
                }
            } catch (e: Exception) {
                log("解码异常: ${e.message}")
                releaseCodec()
                awaitingKeyframe = true
                // stop() interrupts this thread; an escaping InterruptedException
                // would take the process down instead of ending the loop.
                try {
                    Thread.sleep(120)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }
        releaseCodec()
    }

    private fun ensureCodec(): MediaCodec? {
        if (currentWidth <= 0 || currentHeight <= 0) return null
        return try {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, currentWidth, currentHeight)
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 2 * 1024 * 1024)
            // Ask the codec not to hold frames for reordering/smoothing:
            // several devices otherwise add 2-4 frames of decode latency.
            try {
                format.setInteger("low-latency", 1)
            } catch (_: Exception) {
            }
            val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.configure(format, surface, null, 0)
            c.start()
            codec = c
            log("解码器就绪 ${currentWidth}x$currentHeight")
            c
        } catch (e: Exception) {
            log("无法创建解码器: ${e.message}")
            null
        }
    }

    private fun releaseCodec() {
        val c = codec ?: return
        codec = null
        try {
            c.stop()
        } catch (_: Exception) {
        }
        try {
            c.release()
        } catch (_: Exception) {
        }
    }

    fun stop() {
        running = false
        queue.clear()
        worker?.interrupt()
        releaseCodec()
    }

    fun counters(): Triple<Long, Long, Long> = Triple(framesIn, framesOut, dropped)

    private fun findNal(data: ByteArray, target: Int): ByteArray? {
        var i = 0
        while (i + 3 < data.size) {
            if (data[i].toInt() == 0 && data[i + 1].toInt() == 0 && data[i + 2].toInt() == 1) {
                val type = data[i + 3].toInt() and 0x1f
                if (type == target) {
                    val start = i + 4
                    var end = start
                    while (end + 2 < data.size) {
                        if (data[end].toInt() == 0 && data[end + 1].toInt() == 0 && data[end + 2].toInt() == 1) break
                        end++
                    }
                    if (end + 2 >= data.size) end = data.size
                    return data.copyOfRange(start, end)
                }
                i += 3
            } else {
                i++
            }
        }
        return null
    }
}

/** Just enough SPS parsing to learn the coded picture size. */
object SpsParser {
    fun parse(nal: ByteArray): Pair<Int, Int>? = try {
        val rbsp = unescape(nal)
        val profile = rbsp[0].toInt() and 0xff
        val r = BitReader(rbsp)
        r.u(8) // profile_idc
        r.u(8) // constraint flags
        r.u(8) // level_idc
        r.ue() // seq_parameter_set_id
        var chromaFormatIdc = 1
        if (PROFILES.contains(profile)) {
            chromaFormatIdc = r.ue().toInt()
            if (chromaFormatIdc == 3) r.u(1)
            r.ue() // bit_depth_luma_minus8
            r.ue() // bit_depth_chroma_minus8
            r.u(1) // qpprime_y_zero_transform_bypass_flag
            if (r.u(1) == 1) {
                val lists = if (chromaFormatIdc == 3) 12 else 8
                for (i in 0 until lists) {
                    if (r.u(1) == 1) {
                        val size = if (i < 6) 16 else 64
                        var lastScale = 8
                        var nextScale = 8
                        for (j in 0 until size) {
                            if (nextScale != 0) {
                                val delta = r.se()
                                nextScale = (lastScale + delta + 256) % 256
                            }
                            if (nextScale != 0) lastScale = nextScale
                        }
                    }
                }
            }
        }
        r.ue() // log2_max_frame_num_minus4
        val pocType = r.ue().toInt()
        if (pocType == 0) {
            r.ue()
        } else if (pocType == 1) {
            r.u(1)
            r.se()
            r.se()
            val n = r.ue().toInt()
            for (i in 0 until n) r.se()
        }
        r.ue() // max_num_ref_frames
        r.u(1) // gaps_in_frame_num_value_allowed_flag
        val widthMbs = r.ue().toInt() + 1
        val heightMapUnits = r.ue().toInt() + 1
        val frameMbsOnly = r.u(1)
        if (frameMbsOnly == 0) r.u(1)
        r.u(1) // direct_8x8_inference_flag
        var cropLeft = 0
        var cropRight = 0
        var cropTop = 0
        var cropBottom = 0
        if (r.u(1) == 1) {
            cropLeft = r.ue().toInt()
            cropRight = r.ue().toInt()
            cropTop = r.ue().toInt()
            cropBottom = r.ue().toInt()
        }
        val subWidthC = if (chromaFormatIdc == 3) 1 else 2
        val subHeightC = if (chromaFormatIdc == 1) 2 else 1
        val width = widthMbs * 16 - (cropLeft + cropRight) * subWidthC
        val height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropTop + cropBottom) * subHeightC * (2 - frameMbsOnly)
        if (width > 0 && height > 0) Pair(width, height) else null
    } catch (_: Exception) {
        null
    }

    private val PROFILES = setOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)

    private fun unescape(nal: ByteArray): ByteArray {
        val out = ByteArray(nal.size)
        var len = 0
        var zeros = 0
        for (b in nal) {
            val v = b.toInt() and 0xff
            if (zeros >= 2 && v == 3) {
                zeros = 0
                continue
            }
            out[len++] = b
            zeros = if (v == 0) zeros + 1 else 0
        }
        return out.copyOfRange(0, len)
    }

    private class BitReader(private val data: ByteArray) {
        private var bitPos = 0

        fun u(n: Int): Int {
            var v = 0
            for (i in 0 until n) {
                val byte = if (bitPos / 8 < data.size) data[bitPos / 8].toInt() and 0xff else 0
                val bit = (byte ushr (7 - bitPos % 8)) and 1
                v = (v shl 1) or bit
                bitPos++
            }
            return v
        }

        fun ue(): Int {
            var zeros = 0
            while (u(1) == 0) {
                zeros++
                if (zeros > 32) throw IllegalStateException("bad exp-golomb")
            }
            if (zeros == 0) return 0
            return (1 shl zeros) - 1 + u(zeros)
        }

        fun se(): Int {
            val k = ue()
            return if (k % 2 == 0) -(k / 2) else (k + 1) / 2
        }
    }
}
