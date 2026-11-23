/**
 * Wire constants. The packet layout is normative and mirrored in docs/protocol.md.
 */

/** Fixed packet header size in bytes. */
export const HEADER_LEN = 20;
/** Authentication tag appended by AES-256-GCM. */
export const AUTH_TAG_LEN = 16;
/** Conservative MTU that survives IPv6 minimum MTU and PPPoE tunnels. */
export const MTU = 1200;
/** Usable plaintext payload per datagram. */
export const MAX_PAYLOAD = MTU - HEADER_LEN - AUTH_TAG_LEN;

export const PROTOCOL_VERSION = 1;

export const Channel = {
  Control: 0,
  Video: 1,
  Audio: 2,
  Input: 3,
  File: 4,
} as const;
export type ChannelId = (typeof Channel)[keyof typeof Channel];

export const PacketFlags = {
  Key: 0x01,
  SliceEnd: 0x02,
  FecParity: 0x04,
  Retransmit: 0x08,
  FecProtected: 0x10,
  Handshake: 0x40,
} as const;

export const Codec = {
  H264: 1,
  HEVC: 2,
  AV1: 3,
  Opus: 4,
  Raw: 5,
  Lz4: 6,
} as const;
export type CodecId = (typeof Codec)[keyof typeof Codec];

export const FrameFlags = {
  Key: 0x01,
  EndOfStream: 0x02,
  Config: 0x04,
} as const;
