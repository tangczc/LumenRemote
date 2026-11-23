import { AUTH_TAG_LEN, HEADER_LEN } from './constants.ts';

export interface PacketHeader {
  seq: number;
  sendTsUs: number;
  channel: number;
  frameId: number;
  flags: number;
  fragIdx: number;
  fragCnt: number;
  fecIdx: number;
}

export function encodeHeader(h: PacketHeader): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_LEN);
  buf.writeUInt32BE(h.seq >>> 0, 0);
  buf.writeUInt32BE(h.sendTsUs >>> 0, 4);
  buf.writeUInt16BE(h.channel & 0xffff, 8);
  buf.writeUInt16BE(h.frameId & 0xffff, 10);
  buf.writeUInt8(h.flags & 0xff, 12);
  buf.writeUInt16BE(h.fragIdx & 0xffff, 13);
  buf.writeUInt16BE(h.fragCnt & 0xffff, 15);
  buf.writeUInt8(h.fecIdx & 0xff, 17);
  buf.writeUInt8(0, 18); // reserved
  buf.writeUInt8(0, 19); // reserved
  return buf;
}

export function decodeHeader(buf: Buffer, offset = 0): PacketHeader {
  if (buf.length < offset + HEADER_LEN) {
    throw new RangeError(`packet too short: ${buf.length - offset} < ${HEADER_LEN}`);
  }
  return {
    seq: buf.readUInt32BE(offset),
    sendTsUs: buf.readUInt32BE(offset + 4),
    channel: buf.readUInt16BE(offset + 8),
    frameId: buf.readUInt16BE(offset + 10),
    flags: buf.readUInt8(offset + 12),
    fragIdx: buf.readUInt16BE(offset + 13),
    fragCnt: buf.readUInt16BE(offset + 15),
    fecIdx: buf.readUInt8(offset + 17),
  };
}

/** Wrap-aware difference between two 32-bit microsecond timestamps. */
export function tsDelta32(later: number, earlier: number): number {
  return (later - earlier) | 0;
}

export function packetSize(payloadLen: number): number {
  return HEADER_LEN + payloadLen + AUTH_TAG_LEN;
}
