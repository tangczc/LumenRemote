package com.lumen.remote.protocol

/**
 * Wire constants. Mirrors `src/protocol/constants.ts`; the packet layout is
 * normative and both clients must agree byte for byte.
 */
object Wire {
    const val HEADER_LEN = 20
    const val AUTH_TAG_LEN = 16
    const val MTU = 1200
    const val MAX_PAYLOAD = MTU - HEADER_LEN - AUTH_TAG_LEN
    const val PROTOCOL_VERSION = 1
    const val FRAME_HEADER_LEN = 20
}

object Channel {
    const val CONTROL = 0
    const val VIDEO = 1
    const val AUDIO = 2
    const val INPUT = 3
    const val FILE = 4
}

object PacketFlags {
    const val KEY = 0x01
    const val SLICE_END = 0x02
    const val FEC_PARITY = 0x04
    const val RETRANSMIT = 0x08
    const val FEC_PROTECTED = 0x10
    const val HANDSHAKE = 0x40
}

object Codec {
    const val H264 = 1
    const val HEVC = 2
    const val AV1 = 3
    const val OPUS = 4
    const val RAW = 5
}

object FrameFlags {
    const val KEY = 0x01
    const val END_OF_STREAM = 0x02
    const val CONFIG = 0x04
}
