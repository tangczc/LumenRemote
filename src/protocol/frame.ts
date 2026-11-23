import { MAX_PAYLOAD } from './constants.ts';

export const FRAME_HEADER_LEN = 20;

export interface FrameHeader {
  frameId: number;
  codec: number;
  flags: number;
  /** Sender monotonic session clock, microseconds. */
  captureTsUs: bigint;
  totalLen: number;
  fragCount: number;
}

export function encodeFrameHeader(h: FrameHeader): Buffer {
  const buf = Buffer.allocUnsafe(FRAME_HEADER_LEN);
  buf.writeUInt16BE(h.frameId & 0xffff, 0);
  buf.writeUInt8(h.codec & 0xff, 2);
  buf.writeUInt8(h.flags & 0xff, 3);
  buf.writeBigUInt64BE(BigInt(h.captureTsUs), 4);
  buf.writeUInt32BE(h.totalLen >>> 0, 12);
  buf.writeUInt16BE(h.fragCount & 0xffff, 16);
  buf.writeUInt16BE(0, 18);
  return buf;
}

export function decodeFrameHeader(buf: Buffer, offset = 0): FrameHeader {
  if (buf.length < offset + FRAME_HEADER_LEN) {
    throw new RangeError('frame header truncated');
  }
  return {
    frameId: buf.readUInt16BE(offset),
    codec: buf.readUInt8(offset + 2),
    flags: buf.readUInt8(offset + 3),
    captureTsUs: buf.readBigUInt64BE(offset + 4),
    totalLen: buf.readUInt32BE(offset + 12),
    fragCount: buf.readUInt16BE(offset + 16),
  };
}

export interface Fragment {
  fragIdx: number;
  fragCnt: number;
  data: Buffer;
}

/**
 * Split a frame into MTU-sized fragments. Fragment 0 carries the frame header.
 * Only the final fragment may be shorter than MAX_PAYLOAD, which lets the FEC
 * layer derive every expected fragment length from the frame header alone.
 */
export function fragmentFrame(
  frameId: number,
  codec: number,
  flags: number,
  captureTsUs: bigint,
  payload: Buffer,
): { fragments: Fragment[]; header: FrameHeader } {
  const total = FRAME_HEADER_LEN + payload.length;
  const firstCap = MAX_PAYLOAD - FRAME_HEADER_LEN;

  if (payload.length <= firstCap) {
    const header: FrameHeader = { frameId, codec, flags, captureTsUs, totalLen: total, fragCount: 1 };
    const data = Buffer.allocUnsafe(total);
    encodeFrameHeader(header).copy(data, 0);
    payload.copy(data, FRAME_HEADER_LEN);
    return { fragments: [{ fragIdx: 0, fragCnt: 1, data }], header };
  }

  const remaining = payload.length - firstCap;
  const fragCnt = 1 + Math.ceil(remaining / MAX_PAYLOAD);
  if (fragCnt > 0xffff) {
    throw new RangeError(`frame too large to fragment: ${payload.length} bytes (max ${0xffff * MAX_PAYLOAD})`);
  }
  const header: FrameHeader = { frameId, codec, flags, captureTsUs, totalLen: total, fragCount: fragCnt };

  const fragments: Fragment[] = [];
  const first = Buffer.allocUnsafe(FRAME_HEADER_LEN + firstCap);
  encodeFrameHeader(header).copy(first, 0);
  payload.copy(first, FRAME_HEADER_LEN, 0, firstCap);
  fragments.push({ fragIdx: 0, fragCnt, data: first });

  let offset = firstCap;
  for (let i = 1; i < fragCnt; i++) {
    const end = Math.min(offset + MAX_PAYLOAD, payload.length);
    fragments.push({ fragIdx: i, fragCnt, data: Buffer.from(payload.subarray(offset, end)) });
    offset = end;
  }
  return { fragments, header };
}

export interface AssembledFrame {
  frameId: number;
  codec: number;
  flags: number;
  captureTsUs: bigint;
  payload: Buffer;
  receivedFrags: number;
  totalFrags: number;
}

interface PendingFrame {
  header: FrameHeader | null;
  parts: (Buffer | null)[];
  firstSeenMs: number;
  received: number;
}

/**
 * Reassembles fragments per (channel, frameId). Out-of-order and duplicated
 * fragments are tolerated; incomplete frames are evicted after `ttlMs`.
 */
export class Reassembler {
  private pending = new Map<number, PendingFrame>();

  constructor(private readonly ttlMs = 500) {}

  /** Returns the frame when the last missing fragment arrives. */
  push(
    channel: number,
    frameId: number,
    fragIdx: number,
    fragCnt: number,
    data: Buffer,
    nowMs = Date.now(),
  ): AssembledFrame | null {
    const key = (channel << 16) | frameId;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = {
        header: null,
        parts: new Array<Buffer | null>(fragCnt).fill(null),
        firstSeenMs: nowMs,
        received: 0,
      };
      this.pending.set(key, entry);
    }
    if (fragIdx >= entry.parts.length || entry.parts[fragIdx]) return null;

    if (fragIdx === 0) {
      if (data.length < FRAME_HEADER_LEN) return null;
      entry.header = decodeFrameHeader(data, 0);
      entry.parts[0] = Buffer.from(data.subarray(FRAME_HEADER_LEN));
    } else {
      entry.parts[fragIdx] = Buffer.from(data);
    }
    entry.received++;
    if (entry.received !== entry.parts.length || !entry.header) return null;

    this.pending.delete(key);
    const payload = Buffer.concat(entry.parts as Buffer[]);
    return {
      frameId,
      codec: entry.header.codec,
      flags: entry.header.flags,
      captureTsUs: entry.header.captureTsUs,
      payload,
      receivedFrags: entry.received,
      totalFrags: entry.parts.length,
    };
  }

  /** Fragment indices still missing for a frame, or null if unknown/complete. */
  missing(channel: number, frameId: number): number[] | null {
    const entry = this.pending.get((channel << 16) | frameId);
    if (!entry) return null;
    const out: number[] = [];
    for (let i = 0; i < entry.parts.length; i++) if (!entry.parts[i]) out.push(i);
    return out;
  }

  fragBuffers(channel: number, frameId: number): (Buffer | null)[] | null {
    const entry = this.pending.get((channel << 16) | frameId);
    return entry ? entry.parts.slice() : null;
  }

  fragCount(channel: number, frameId: number): number {
    return this.pending.get((channel << 16) | frameId)?.parts.length ?? 0;
  }

  header(channel: number, frameId: number): FrameHeader | null {
    return this.pending.get((channel << 16) | frameId)?.header ?? null;
  }

  /** Drop frames that never completed. */
  sweep(nowMs = Date.now()): { channel: number; frameId: number }[] {
    const evicted: { channel: number; frameId: number }[] = [];
    for (const [key, entry] of this.pending) {
      if (nowMs - entry.firstSeenMs > this.ttlMs) {
        evicted.push({ channel: key >>> 16, frameId: key & 0xffff });
        this.pending.delete(key);
      }
    }
    return evicted;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Frames currently awaiting fragments, for NACK scheduling. */
  pendingFrames(): { channel: number; frameId: number; firstSeenMs: number }[] {
    const out: { channel: number; frameId: number; firstSeenMs: number }[] = [];
    for (const [key, entry] of this.pending) {
      out.push({ channel: key >>> 16, frameId: key & 0xffff, firstSeenMs: entry.firstSeenMs });
    }
    return out;
  }

  clear(): void {
    this.pending.clear();
  }
}
