import type { NalUnit } from './nal.ts';
import { NalType } from './nal.ts';

export interface ParameterSets {
  sps: Buffer;
  pps: Buffer;
}

/** Collect SPS/PPS from an access unit, if present. */
export function extractParameterSets(units: NalUnit[]): Partial<ParameterSets> {
  const out: Partial<ParameterSets> = {};
  for (const u of units) {
    if (u.type === NalType.Sps && !out.sps) out.sps = Buffer.from(u.data);
    if (u.type === NalType.Pps && !out.pps) out.pps = Buffer.from(u.data);
  }
  return out;
}

/**
 * AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.2.4.1) built from SPS/PPS.
 * WebCodecs and HTMLVideoElement/MSE both accept this as `description`.
 */
export function buildAvcC(sps: Buffer, pps: Buffer): Buffer {
  if (sps.length < 4) throw new RangeError('SPS too short');
  const head = Buffer.from([
    0x01,
    sps[1]!,
    sps[2]!,
    sps[3]!,
    0xff, // 6 bits reserved | lengthSizeMinusOne = 3
    0xe1, // 3 bits reserved | numOfSequenceParameterSets = 1
  ]);
  const spsLen = Buffer.alloc(2);
  spsLen.writeUInt16BE(sps.length, 0);
  const ppsCount = Buffer.from([0x01]);
  const ppsLen = Buffer.alloc(2);
  ppsLen.writeUInt16BE(pps.length, 0);
  return Buffer.concat([head, spsLen, sps, ppsCount, ppsLen, pps]);
}

/** RFC6381 codec string, e.g. "avc1.42E01E". */
export function codecString(sps: Buffer): string {
  if (sps.length < 4) return 'avc1.42E01E';
  const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`;
}

/** Convert Annex-B NAL units into 4-byte-length-prefixed AVC samples. */
export function annexBToAvcc(units: NalUnit[]): Buffer {
  const parts: Buffer[] = [];
  for (const u of units) {
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(u.data.length, 0);
    parts.push(len, u.data);
  }
  return Buffer.concat(parts);
}

export interface AvcStreamConfig extends ParameterSets {
  avcC: Buffer;
  codec: string;
}

export function describeStream(sps: Buffer, pps: Buffer): AvcStreamConfig {
  return { sps, pps, avcC: buildAvcC(sps, pps), codec: codecString(sps) };
}
