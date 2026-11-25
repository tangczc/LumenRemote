/**
 * Annex-B helpers plus access-unit framing.
 *
 * The host receives raw H.264 from FFmpeg's stdout and needs to know where one
 * picture ends and the next begins. Relying on AUD NALs would tie us to one
 * encoder's flags, so a new access unit is also detected when a slice NAL
 * arrives with `first_mb_in_slice == 0` after the current unit already has a
 * slice. That works for libx264, NVENC, QSV and hardware decoders alike.
 */

const START_CODE = Buffer.from([0, 0, 0, 1]);

export type VideoCodecKind = 'h264' | 'hevc';

export enum NalType {
  Slice = 1,
  IdrSlice = 5,
  Sei = 6,
  Sps = 7,
  Pps = 8,
  Aud = 9,
}

/** HEVC NAL unit types (ITU-T H.265 Table 7-1), the subset we route on. */
export const HevcNalType = {
  TrailR: 1,
  IdrWRadl: 19,
  IdrNLp: 20,
  CraNut: 21,
  Vps: 32,
  Sps: 33,
  Pps: 34,
  Aud: 35,
  SeiPrefix: 39,
  SeiSuffix: 40,
} as const;

/** NAL type of one unit's first byte(s), under the codec's own numbering. */
export function nalTypeOf(firstByte: number, secondByte: number, codec: VideoCodecKind): number {
  return codec === 'hevc' ? (firstByte >> 1) & 0x3f : firstByte & 0x1f;
}

export interface NalUnit {
  type: NalType | number;
  data: Buffer;
}

/** Split Annex-B data into NAL units (start codes stripped). */
export function splitAnnexB(data: Buffer, codec: VideoCodecKind = 'h264'): NalUnit[] {
  const units: NalUnit[] = [];
  let i = 0;
  let start = -1;
  while (i + 3 <= data.length) {
    const three = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    const four = i + 4 <= data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    if (four || three) {
      if (start >= 0) {
        const end = i;
        if (end > start) units.push({ type: nalTypeOf(data[start]!, data[start + 1] ?? 0, codec), data: data.subarray(start, end) });
      }
      i += four ? 4 : 3;
      start = i;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < data.length) {
    units.push({ type: nalTypeOf(data[start]!, data[start + 1] ?? 0, codec), data: data.subarray(start) });
  }
  return units;
}

export function joinAnnexB(units: NalUnit[]): Buffer {
  const parts: Buffer[] = [];
  for (const u of units) {
    parts.push(START_CODE, u.data);
  }
  return Buffer.concat(parts);
}

/** Read `first_mb_in_slice` (ue(v)) from a slice NAL. Returns null when unparsable. */
export function firstMbInSlice(nal: Buffer): number | null {
  if (nal.length < 2) return null;
  const type = nal[0]! & 0x1f;
  if (type !== NalType.Slice && type !== NalType.IdrSlice) return null;
  let bitPos = 8;
  let zeros = 0;
  const readBit = (): number => {
    const byte = nal[bitPos >> 3];
    if (byte === undefined) throw new RangeError('eof');
    const bit = (byte >> (7 - (bitPos & 7))) & 1;
    bitPos++;
    return bit;
  };
  try {
    while (readBit() === 0) {
      zeros++;
      if (zeros > 31) return null;
    }
    let value = 0;
    for (let i = 0; i < zeros; i++) value = (value << 1) | readBit();
    return (1 << zeros) - 1 + value;
  } catch {
    return null;
  }
}

/**
 * HEVC `first_slice_segment_in_pic_flag`: the first RBSP bit after the
 * 2-byte NAL header. Emulation prevention can only insert bytes after a
 * 00 00 pair deeper into the RBSP, so this leading bit reads directly.
 */
export function hevcFirstSliceSegment(nal: Buffer): boolean {
  if (nal.length < 3) return false;
  return (nal[2]! & 0x80) !== 0;
}

function isSliceUnit(type: number, codec: VideoCodecKind): boolean {
  if (codec === 'hevc') return type <= HevcNalType.CraNut; // VCL types are 0..21
  return type === NalType.Slice || type === NalType.IdrSlice;
}

function isKeyUnit(type: number, codec: VideoCodecKind): boolean {
  if (codec === 'hevc') return type === HevcNalType.IdrWRadl || type === HevcNalType.IdrNLp;
  return type === NalType.IdrSlice;
}

/** True when the unit belongs to a new coded picture. */
function startsNewPicture(unit: NalUnit, haveSlice: boolean, codec: VideoCodecKind): boolean {
  if (codec === 'hevc') {
    switch (unit.type) {
      case HevcNalType.Aud:
      case HevcNalType.Vps:
      case HevcNalType.Sps:
      case HevcNalType.Pps:
      case HevcNalType.SeiPrefix:
      case HevcNalType.SeiSuffix:
        return haveSlice;
      default:
        if (!isSliceUnit(unit.type, codec) || !haveSlice) return false;
        return hevcFirstSliceSegment(unit.data);
    }
  }
  switch (unit.type) {
    case NalType.Aud:
    case NalType.Sps:
    case NalType.Pps:
    case NalType.Sei:
      return haveSlice;
    case NalType.Slice:
    case NalType.IdrSlice: {
      if (!haveSlice) return false;
      const firstMb = firstMbInSlice(unit.data);
      return firstMb === 0;
    }
    default:
      return false;
  }
}

export interface AccessUnit {
  /** Annex-B payload, ready for the wire. */
  payload: Buffer;
  units: NalUnit[];
  isKey: boolean;
  hasSps: boolean;
  hasPps: boolean;
  /** HEVC only: the access unit carries a VPS. */
  hasVps: boolean;
}

/**
 * Reassembles NAL units arriving in arbitrary chunks into access units.
 */
export class AccessUnitAssembler {
  private remainder: Buffer = Buffer.alloc(0);
  private current: NalUnit[] = [];
  private haveSlice = false;

  constructor(
    private readonly onAccessUnit: (au: AccessUnit) => void,
    private readonly codec: VideoCodecKind = 'h264',
  ) {}

  push(chunk: Buffer): void {
    const data = this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk;
    // Keep the tail after the last start code as the next partial NAL.
    const lastStart = findLastStartCode(data);
    if (lastStart < 0) {
      this.remainder = Buffer.from(data);
      return;
    }
    const complete = data.subarray(0, lastStart);
    this.remainder = Buffer.from(data.subarray(lastStart));
    if (complete.length > 0) this.consume(complete);
  }

  /** Emit whatever has been buffered, e.g. on stream end. */
  flush(): void {
    if (this.remainder.length > 4) {
      const units = splitAnnexB(this.remainder, this.codec);
      this.remainder = Buffer.alloc(0);
      for (const u of units) this.accept(u);
    }
    this.emit();
  }

  private consume(data: Buffer): void {
    for (const unit of splitAnnexB(data, this.codec)) this.accept(unit);
  }

  private accept(unit: NalUnit): void {
    if (this.current.length > 0 && startsNewPicture(unit, this.haveSlice, this.codec)) this.emit();
    this.current.push(unit);
    if (isSliceUnit(unit.type, this.codec)) this.haveSlice = true;
  }

  private emit(): void {
    if (this.current.length === 0) return;
    const units = this.current;
    this.current = [];
    this.haveSlice = false;
    if (!units.some((u) => isSliceUnit(u.type, this.codec))) return;
    const spsType = this.codec === 'hevc' ? HevcNalType.Sps : NalType.Sps;
    const ppsType = this.codec === 'hevc' ? HevcNalType.Pps : NalType.Pps;
    this.onAccessUnit({
      payload: joinAnnexB(units),
      units,
      isKey: units.some((u) => isKeyUnit(u.type, this.codec)),
      hasSps: units.some((u) => u.type === spsType),
      hasPps: units.some((u) => u.type === ppsType),
      hasVps: this.codec === 'hevc' && units.some((u) => u.type === HevcNalType.Vps),
    });
  }
}

function findLastStartCode(data: Buffer): number {
  // Scan backwards for an Annex-B start code (00 00 01), tolerating the
  // four-byte form by folding in a preceding zero byte.
  for (let i = data.length - 3; i >= 0; i--) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      return i > 0 && data[i - 1] === 0 ? i - 1 : i;
    }
  }
  return -1;
}
