import type { NalUnit } from './nal.ts';
import { HevcNalType } from './nal.ts';

/**
 * HEVC decoder configuration: parse the SPS, build the hvcC record
 * (ISO/IEC 14496-15) and the RFC 6381 codec string WebCodecs wants.
 * The AVC twin of this module is avc.ts; the shapes deliberately match
 * so the session layer can treat both stream families uniformly.
 */

export interface HevcParameterSets {
  vps: Buffer;
  sps: Buffer;
  pps: Buffer;
}

export interface HevcSpsInfo {
  profileSpace: number;
  tier: boolean;
  profileIdc: number;
  /** general_profile_compatibility_flags, as written MSB-first. */
  compatFlags: number;
  /** The six general constraint indicator bytes. */
  constraintBytes: Buffer;
  levelIdc: number;
  maxSubLayersMinus1: number;
  temporalIdNesting: boolean;
  chromaFormatIdc: number;
  width: number;
  height: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
}

/** Strip 0x000003 emulation-prevention bytes from an RBSP. */
export function removeEmulationPrevention(rbsp: Buffer): Buffer {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

class BitReader {
  private pos = 0;
  constructor(private readonly data: Buffer) {}

  u(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3];
      if (byte === undefined) throw new RangeError('hevc sps: eof');
      value = value * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return value;
  }

  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros > 31) throw new RangeError('hevc sps: bad ue');
    }
    return 2 ** zeros - 1 + (zeros > 0 ? this.u(zeros) : 0);
  }

  skip(n: number): void {
    this.u(n);
  }
}

function profileTierLevel(br: BitReader, maxSubLayers: number): Omit<HevcSpsInfo, 'maxSubLayersMinus1' | 'temporalIdNesting' | 'chromaFormatIdc' | 'width' | 'height' | 'bitDepthLumaMinus8' | 'bitDepthChromaMinus8'> {
  const profileSpace = br.u(2);
  const tier = br.u(1) === 1;
  const profileIdc = br.u(5);
  const compatFlags = br.u(32);
  // The constraint indicator is one 48-bit field (progressive / interlaced /
  // non-packed / frame-only flags, then feature constraint bits and
  // reserved zeros); hvcC copies it verbatim, so read it as six bytes.
  const constraint: number[] = [];
  for (let b = 0; b < 6; b++) constraint.push(br.u(8));
  const levelIdc = br.u(8);

  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayers; i++) {
    profilePresent.push(br.u(1) === 1);
    levelPresent.push(br.u(1) === 1);
  }
  // reserved_zero_2bits pads the sub-layer table toward the fixed
  // maximum of 7 sub-layers — but only exists when there is at least
  // one sub-layer (maxNumSubLayersMinus1 > 0). NVENC writes 0 here,
  // and skipping unconditionally misaligns everything after level_idc.
  if (maxSubLayers > 0) {
    for (let i = maxSubLayers; i < 7; i++) br.skip(2);
  }
  for (let i = 0; i < maxSubLayers; i++) {
    if (profilePresent[i]) {
      br.skip(2 + 1 + 5 + 32 + 48);
    }
    if (levelPresent[i]) br.skip(8);
  }
  return { profileSpace, tier, profileIdc, compatFlags, constraintBytes: Buffer.from(constraint), levelIdc };
}

/**
 * Parse an HEVC SPS NAL unit (including its 2-byte header).
 * Returns null on any structural surprise — the caller then keeps the
 * stream unconfigured and the controller asks the host for H.264
 * instead of guessing at a decoder config.
 */
export function parseHevcSps(nal: Buffer): HevcSpsInfo | null {
  try {
    if (nal.length < 4 || ((nal[0]! >> 1) & 0x3f) !== HevcNalType.Sps) return null;
    const br = new BitReader(removeEmulationPrevention(nal.subarray(2)));
    br.u(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = br.u(3);
    const temporalIdNesting = br.u(1) === 1;
    const ptl = profileTierLevel(br, maxSubLayersMinus1);
    br.ue(); // sps_seq_parameter_set_id
    const chromaFormatIdc = br.ue();
    if (chromaFormatIdc === 3) br.u(1); // separate_colour_plane_flag
    const width = br.ue();
    const height = br.ue();
    if (br.u(1) === 1) {
      br.ue();
      br.ue();
      br.ue();
      br.ue();
    } // conformance window
    const bitDepthLumaMinus8 = br.ue();
    const bitDepthChromaMinus8 = br.ue();
    return {
      ...ptl,
      maxSubLayersMinus1,
      temporalIdNesting,
      chromaFormatIdc,
      width,
      height,
      bitDepthLumaMinus8,
      bitDepthChromaMinus8,
    };
  } catch {
    return null;
  }
}

function reverseByte(b: number): number {
  let v = 0;
  for (let i = 0; i < 8; i++) v = (v << 1) | ((b >> i) & 1);
  return v;
}

/** RFC 6381 codec string, e.g. "hvc1.1.6.L120.90". */
export function hevcCodecString(info: HevcSpsInfo): string {
  const compatByte = reverseByte((info.compatFlags >>> 24) & 0xff);
  const parts = [
    'hvc1',
    String(info.profileIdc),
    compatByte.toString(16).toUpperCase(),
    `${info.tier ? 'H' : 'L'}${info.levelIdc}`,
  ];
  const constraint = [...info.constraintBytes];
  while (constraint.length > 0 && constraint[constraint.length - 1] === 0) constraint.pop();
  for (const b of constraint) parts.push(b.toString(16).padStart(2, '0').toUpperCase());
  return parts.join('.');
}

/**
 * HEVCDecoderConfigurationRecord. Fields a decoder genuinely keys on
 * (profile/tier/level, chroma, bit depth, the parameter sets themselves)
 * are exact; the advisory fields (min_spatial_segmentation_idc,
 * parallelismType, average frame rate) take their neutral values, which
 * is what hardware decoders expect when the stream does not signal them.
 */
export function buildHvcC(vps: Buffer, sps: Buffer, pps: Buffer, info: HevcSpsInfo): Buffer {
  const head = Buffer.alloc(23);
  head[0] = 1; // configurationVersion
  head[1] = ((info.profileSpace & 3) << 6) | ((info.tier ? 1 : 0) << 5) | (info.profileIdc & 31);
  head.writeUInt32BE(info.compatFlags >>> 0, 2);
  info.constraintBytes.copy(head, 6, 0, 6);
  head[12] = info.levelIdc & 0xff;
  head.writeUInt16BE(0xf000, 13); // reserved(4) | min_spatial_segmentation_idc(12) = 0
  head[15] = 0xfc; // reserved(6) | parallelismType(2) = 0
  head[16] = 0xfc | (info.chromaFormatIdc & 3);
  head[17] = 0xf8 | (info.bitDepthLumaMinus8 & 7);
  head[18] = 0xf8 | (info.bitDepthChromaMinus8 & 7);
  head.writeUInt16BE(0, 19); // avgFrameRate: unspecified
  head[21] =
    (0 << 6) | // constantFrameRate: unspecified
    (((info.maxSubLayersMinus1 + 1) & 7) << 3) |
    ((info.temporalIdNesting ? 1 : 0) << 2) |
    3; // lengthSizeMinusOne = 3 (4-byte lengths)
  head[22] = 3; // numOfArrays: VPS, SPS, PPS

  const arrays: Buffer[] = [];
  const pushArray = (type: number, data: Buffer) => {
    const meta = Buffer.alloc(3);
    meta[0] = 0x80 | type; // array_completeness | nalUnitType
    meta.writeUInt16BE(1, 1);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(data.length, 0);
    arrays.push(meta, len, data);
  };
  pushArray(HevcNalType.Vps, vps);
  pushArray(HevcNalType.Sps, sps);
  pushArray(HevcNalType.Pps, pps);
  return Buffer.concat([head, ...arrays]);
}

/** Collect VPS/SPS/PPS from an access unit, if present. */
export function extractHevcParameterSets(units: NalUnit[]): Partial<HevcParameterSets> {
  const out: Partial<HevcParameterSets> = {};
  for (const u of units) {
    if (u.type === HevcNalType.Vps && !out.vps) out.vps = Buffer.from(u.data);
    if (u.type === HevcNalType.Sps && !out.sps) out.sps = Buffer.from(u.data);
    if (u.type === HevcNalType.Pps && !out.pps) out.pps = Buffer.from(u.data);
  }
  return out;
}

export interface HevcStreamConfig extends HevcParameterSets {
  hvcC: Buffer;
  codec: string;
  info: HevcSpsInfo;
}

export function describeHevcStream(vps: Buffer, sps: Buffer, pps: Buffer): HevcStreamConfig | null {
  const info = parseHevcSps(sps);
  if (!info) return null;
  return { vps, sps, pps, info, hvcC: buildHvcC(vps, sps, pps, info), codec: hevcCodecString(info) };
}

/**
 * The config a stream needs now, or null when it matches `current`.
 * Mirrors avc.streamConfigChanged: the full record is compared because
 * a mid-session resize changes the SPS without changing the codec string.
 */
export function hevcStreamConfigChanged(
  current: Pick<HevcStreamConfig, 'hvcC'> | null,
  vps: Buffer,
  sps: Buffer,
  pps: Buffer,
): HevcStreamConfig | null {
  const next = describeHevcStream(vps, sps, pps);
  if (!next) return null;
  if (current && current.hvcC.equals(next.hvcC)) return null;
  return next;
}
