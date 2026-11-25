import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AccessUnitAssembler, firstMbInSlice, joinAnnexB, splitAnnexB } from '../src/media/nal.ts';
import { annexBToAvcc, buildAvcC, codecString, extractParameterSets, streamConfigChanged } from '../src/media/avc.ts';
import { describeHevcStream, hevcCodecString, hevcStreamConfigChanged, parseHevcSps } from '../src/media/hevc.ts';
import { capSizeForBitrate, fitGeometryForBitrate, negotiateSize, scaleBitrate } from '../src/media/target.ts';
import { buildEncoderArgs, ScreenEncoder, codecKindOf, hevcHardwareEncoder } from '../src/media/encoder.ts';

/** Build a fake Annex-B stream: SPS, PPS, IDR slice(s), then P slices. */
function nal(type: number, body: number[]): Buffer {
  return Buffer.from([type, ...body]);
}

function au(...units: Buffer[]): Buffer {
  return joinAnnexB(units.map((u) => ({ type: u[0]! & 0x1f, data: u })));
}

// first_mb_in_slice = 0  => ue(v) bit "1"
const SLICE_FIRST = [0x88, 0x84, 0x00];
// first_mb_in_slice = 5  => ue(v) = "00110"
const SLICE_LATER = [0x30, 0x2c, 0x00];

describe('annex-b parsing', () => {
  test('splits 3- and 4-byte start codes', () => {
    const stream = Buffer.concat([
      Buffer.from([0, 0, 1]),
      nal(7, [1, 2, 3]),
      Buffer.from([0, 0, 0, 1]),
      nal(8, [4, 5]),
    ]);
    const units = splitAnnexB(stream);
    assert.equal(units.length, 2);
    assert.equal(units[0]!.type, 7);
    assert.deepEqual([...units[0]!.data], [7, 1, 2, 3]);
    assert.equal(units[1]!.type, 8);
  });

  test('reads first_mb_in_slice', () => {
    assert.equal(firstMbInSlice(nal(5, SLICE_FIRST)), 0);
    assert.equal(firstMbInSlice(nal(1, SLICE_LATER)), 5);
    assert.equal(firstMbInSlice(nal(7, [1, 2])), null);
  });
});

describe('access unit assembly', () => {
  function collect() {
    const aus: ReturnType<typeof Array.prototype.push> extends never ? never : import('../src/media/nal.ts').AccessUnit[] = [];
    const assembler = new AccessUnitAssembler((a) => aus.push(a));
    return { aus, assembler };
  }

  test('groups one picture per access unit', () => {
    const { aus, assembler } = collect();
    assembler.push(
      Buffer.concat([
        au(nal(7, [0x42, 0xe0, 0x1e]), nal(8, [1, 2])),
        au(nal(5, SLICE_FIRST)),
        au(nal(1, SLICE_FIRST)),
      ]),
    );
    // The trailing NAL may still be incomplete, so nothing is emitted yet.
    assert.equal(aus.length, 0);
    assembler.flush();
    assert.equal(aus.length, 2);
    assert.equal(aus[0]!.isKey, true);
    assert.equal(aus[0]!.hasSps, true);
    assert.equal(aus[1]!.isKey, false);
  });

  test('multiple slices of the same picture stay in one access unit', () => {
    const { aus, assembler } = collect();
    assembler.push(
      Buffer.concat([au(nal(5, SLICE_FIRST)), au(nal(5, SLICE_LATER)), au(nal(1, SLICE_FIRST))]),
    );
    assembler.flush();
    assert.equal(aus.length, 2);
    assert.equal(aus[0]!.units.length, 2, 'two slices in the key frame');
  });

  test('survives chunk boundaries in the middle of a NAL', () => {
    const { aus, assembler } = collect();
    const full = Buffer.concat([au(nal(7, [0x42, 0xe0, 0x1e]), nal(8, [1, 2]), nal(5, SLICE_FIRST)), au(nal(1, SLICE_FIRST))]);
    for (const byte of full) {
      assembler.push(Buffer.from([byte]));
    }
    assembler.flush();
    assert.ok(aus.length >= 1);
    assert.equal(aus[0]!.isKey, true);
  });

  test('keeps emitting access units for a long stream split at arbitrary offsets', () => {
    const { aus, assembler } = collect();
    const frames: Buffer[] = [au(nal(7, [0x42, 0xe0, 0x1e]), nal(8, [1, 2]), nal(5, SLICE_FIRST))];
    for (let i = 0; i < 200; i++) frames.push(au(nal(1, SLICE_FIRST)));
    const stream = Buffer.concat(frames);

    let offset = 0;
    let step = 7;
    while (offset < stream.length) {
      const end = Math.min(stream.length, offset + step);
      assembler.push(stream.subarray(offset, end));
      offset = end;
      step = (step * 13 + 11) % 900 + 3;
    }
    assembler.flush();
    assert.equal(aus.length, 201, `expected 201 access units, got ${aus.length}`);
    assert.equal(aus[0]!.isKey, true);
    // Every emitted unit must carry exactly one slice for this synthetic stream.
    assert.ok(aus.every((a) => a.units.some((u) => u.type === 1 || u.type === 5)));
  });
});

describe('avc configuration', () => {
  test('builds avcC and codec string from SPS/PPS', () => {
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1e, 0x8c, 0x8d, 0x40]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
    const avcC = buildAvcC(sps, pps);
    assert.equal(avcC[0], 1);
    assert.equal(avcC[1], 0x42); // profile
    assert.equal(avcC[4], 0xff);
    assert.equal(avcC.readUInt16BE(6), sps.length);
    assert.equal(codecString(sps), 'avc1.42E01E');

    const sets = extractParameterSets([
      { type: 7, data: sps },
      { type: 8, data: pps },
    ]);
    assert.ok(sets.sps && sets.pps);
  });

  test('detects a mid-session parameter change even when the codec string is identical', () => {
    // Two SPS with the same profile/level bytes (same RFC6381 codec
    // string) but different tails — e.g. an encoder restarted at a new
    // resolution. Keying decoder configuration on the codec string
    // alone misses this, which used to freeze the controller picture
    // permanently while session stats stayed healthy.
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
    const spsA = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac, 0x72, 0x84, 0x40]);
    const spsB = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac, 0xb8, 0x20, 0x10]);
    assert.equal(codecString(spsA), codecString(spsB));

    const first = streamConfigChanged(null, spsA, pps);
    assert.ok(first);
    assert.equal(streamConfigChanged(first, spsA, pps), null);

    const changed = streamConfigChanged(first, spsB, pps);
    assert.ok(changed);
    assert.equal(changed.codec, first.codec);
    assert.ok(!changed.avcC.equals(first.avcC));
  });

  test('converts annex-b to length-prefixed samples', () => {
    const units = [
      { type: 5, data: Buffer.from([0x65, 1, 2, 3]) },
      { type: 1, data: Buffer.from([0x41, 9]) },
    ];
    const out = annexBToAvcc(units);
    assert.equal(out.readUInt32BE(0), 4);
    assert.equal(out.readUInt32BE(4 + 4), 2);
  });
});

/* ------------------------------------------------------------ HEVC ---- */

/** Minimal bit writer for hand-building HEVC RBSPs. */
class Bits {
  private bits = '';
  u(n: number, value: number): this {
    this.bits += value.toString(2).padStart(n, '0').slice(-n);
    return this;
  }
  ue(value: number): this {
    const codeNum = value + 1;
    const zeros = Math.floor(Math.log2(codeNum));
    this.bits += '0'.repeat(zeros) + codeNum.toString(2);
    return this;
  }
  bytes(): Buffer {
    let b = this.bits + '1';
    while (b.length % 8 !== 0) b += '0';
    const out: number[] = [];
    for (let i = 0; i < b.length; i += 8) out.push(parseInt(b.slice(i, i + 8), 2));
    return Buffer.from(out);
  }
}

/** An HEVC NAL unit: 2-byte header (type in bits 9..14) + payload. */
function hnal(type: number, payload: number[]): Buffer {
  return Buffer.from([(type << 1) & 0x7e, 0x01, ...payload]);
}

/**
 * A synthetic but structurally valid NVENC-style SPS: Main profile,
 * level 4.0 (120), 2560x1440, 4:2:0 8-bit, no sub-layer PTL entries.
 */
function syntheticHevcSps(): Buffer {
  const rbsp = new Bits()
    .u(4, 0) // sps_video_parameter_set_id
    .u(3, 0) // sps_max_sub_layers_minus1
    .u(1, 1) // sps_temporal_id_nesting_flag
    .u(2, 0) // profile_space
    .u(1, 0) // tier_flag
    .u(5, 1) // profile_idc = Main
    .u(32, 0x4000_0000) // compatibility flags: flag[1]
    .u(48, 0x9000_0000_0000) // constraint indicator: progressive + frame-only
    .u(8, 120) // level_idc
    .ue(0) // sps_seq_parameter_set_id
    .ue(1) // chroma_format_idc = 4:2:0
    .ue(2560)
    .ue(1440)
    .u(1, 0) // conformance_window_flag
    .ue(0) // bit_depth_luma_minus8
    .ue(0) // bit_depth_chroma_minus8
    .bytes();
  return Buffer.concat([Buffer.from([(33 << 1) & 0x7e, 0x01]), rbsp]);
}

describe('hevc configuration', () => {
  test('parses a synthetic SPS and builds hvcC + codec string', () => {
    const sps = syntheticHevcSps();
    const info = parseHevcSps(sps);
    assert.ok(info);
    assert.equal(info.profileIdc, 1);
    assert.equal(info.tier, false);
    assert.equal(info.levelIdc, 120);
    assert.equal(info.compatFlags, 0x4000_0000);
    assert.equal(info.width, 2560);
    assert.equal(info.height, 1440);
    assert.equal(info.chromaFormatIdc, 1);
    assert.equal(info.bitDepthLumaMinus8, 0);
    // compat byte 0x40 bit-reversed is 0x02; the constraint bytes keep
    // only their non-zero tail (0x90 = progressive, frame-only).
    assert.equal(hevcCodecString(info), 'hvc1.1.2.L120.90');

    const vps = hnal(32, [0x0c, 0x01]);
    const pps = hnal(34, [0xc0, 0x72]);
    const cfg = describeHevcStream(vps, sps, pps);
    assert.ok(cfg);
    assert.equal(cfg.codec, 'hvc1.1.2.L120.90');
    assert.equal(cfg.hvcC[0], 1); // configurationVersion
    assert.equal(cfg.hvcC[1], 1); // profileSpace(0) tier(0) profileIdc(1)
    assert.equal(cfg.hvcC.readUInt32BE(2), 0x4000_0000);
    assert.equal(cfg.hvcC[12], 120); // level
    assert.equal(cfg.hvcC[16], 0xfc | 1); // chroma format
    assert.equal(cfg.hvcC[22], 3); // numOfArrays
    assert.equal(cfg.hvcC[23], 0x80 | 32); // first array: VPS
    assert.equal(cfg.hvcC.readUInt16BE(26), vps.length);
  });

  test('rejects garbage instead of inventing a decoder config', () => {
    assert.equal(parseHevcSps(Buffer.from([0x42, 0x01, 0x00])), null);
    assert.equal(parseHevcSps(Buffer.from([0x40, 0x01, 0xff, 0xff, 0xff])), null); // wrong type (32)
    assert.equal(describeHevcStream(hnal(32, [1]), Buffer.from([0x42, 0x01, 0x00]), hnal(34, [1])), null);
  });

  test('config change detection keys on the full record', () => {
    const vps = hnal(32, [0x0c, 0x01]);
    const pps = hnal(34, [0xc0, 0x72]);
    const first = describeHevcStream(vps, syntheticHevcSps(), pps);
    assert.ok(first);
    assert.equal(hevcStreamConfigChanged({ hvcC: first.hvcC }, vps, syntheticHevcSps(), pps), null);
  });

  test('assembles HEVC access units on first-slice-segment boundaries', () => {
    const aus: import('../src/media/nal.ts').AccessUnit[] = [];
    const assembler = new AccessUnitAssembler((a) => aus.push(a), 'hevc');
    const stream = Buffer.concat([
      joinAnnexB([
        { type: 32, data: hnal(32, [0x0c]) },
        { type: 33, data: syntheticHevcSps() },
        { type: 34, data: hnal(34, [0xc0]) },
        { type: 19, data: hnal(19, [0x80, 0x11]) }, // IDR, first slice segment
      ]),
      joinAnnexB([{ type: 1, data: hnal(1, [0x80, 0x22]) }]), // TRAIL, first segment
      joinAnnexB([
        { type: 1, data: hnal(1, [0x80, 0x33]) }, // TRAIL, first segment
        { type: 1, data: hnal(1, [0x00, 0x44]) }, // same picture, later segment
      ]),
    ]);
    assembler.push(stream);
    assembler.flush();
    assert.equal(aus.length, 3);
    assert.equal(aus[0]!.isKey, true);
    assert.equal(aus[0]!.hasVps, true);
    assert.equal(aus[0]!.hasSps, true);
    assert.equal(aus[1]!.isKey, false);
    assert.equal(aus[2]!.units.length, 2, 'later slice segments stay with their picture');
  });

  test('splits HEVC annex-b with HEVC type numbering', () => {
    const units = splitAnnexB(
      Buffer.concat([Buffer.from([0, 0, 0, 1]), hnal(33, [0x99]), Buffer.from([0, 0, 1]), hnal(1, [0x80])]),
      'hevc',
    );
    assert.deepEqual(
      units.map((u) => u.type),
      [33, 1],
    );
  });

  test('hevc encoder args use the hardware HEVC path and raw HEVC output', () => {
    const args = buildEncoderArgs({
      source: { kind: 'screen', mode: 'gdi' },
      encoder: 'hevc_nvenc',
      onAccessUnit: () => {},
    });
    assert.equal(args[args.indexOf('-c:v') + 1], 'hevc_nvenc');
    assert.equal(args[args.indexOf('-preset') + 1], 'p4');
    // The output format is the LAST -f (the gdigrab input has one too).
    assert.equal(args[args.lastIndexOf('-f') + 1], 'hevc');
    assert.equal(codecKindOf({ encoder: 'hevc_qsv' }), 'hevc');
    assert.equal(codecKindOf({ encoder: 'h264_nvenc' }), 'h264');
    assert.equal(codecKindOf({ encoder: 'auto', codec: 'hevc' }), 'hevc');
    const enc = new ScreenEncoder({
      source: { kind: 'test', size: '320x240' },
      encoder: 'hevc_nvenc',
      onAccessUnit: () => {},
    });
    assert.equal(enc.codecKind, 'hevc');
  });

  test('no hardware HEVC encoder is reported when ffmpeg is missing', () => {
    assert.equal(hevcHardwareEncoder('/nonexistent/definitely-no-ffmpeg'), null);
  });
});

describe('bitrate-driven size cap', () => {
  test('leaves the size alone when the bitrate can describe it', () => {
    assert.deepEqual(capSizeForBitrate({ width: 3840, height: 2160 }, 56_000, 60), {
      width: 3840,
      height: 2160,
    });
    assert.deepEqual(capSizeForBitrate({ width: 1920, height: 1080 }, 8_000, 30), {
      width: 1920,
      height: 1080,
    });
  });

  test('shrinks a starved 1440p60 stream into its pixel budget, keeping aspect', () => {
    // ~5 Mbps measured uplink vs 2560x1440@60 is ~0.02 bits/px: mosaic.
    // The cap must land near 0.8 Mpx (roughly 1365x768), still 16:9, even dims.
    const capped = capSizeForBitrate({ width: 2560, height: 1440 }, 5_000, 60);
    const pixels = capped.width * capped.height;
    assert.ok(pixels <= 840_000 && pixels >= 790_000, `pixels=${pixels}`);
    assert.equal(capped.width % 2, 0);
    assert.equal(capped.height % 2, 0);
    assert.ok(Math.abs(capped.width / capped.height - 16 / 9) < 0.01);
  });

  test('keeps portrait geometry portrait', () => {
    const capped = capSizeForBitrate({ width: 1080, height: 1920 }, 4_000, 60);
    assert.ok(capped.height > capped.width);
    assert.ok(capped.width * capped.height <= 670_000);
  });

  test('ignores nonsense inputs', () => {
    const size = { width: 1920, height: 1080 };
    assert.deepEqual(capSizeForBitrate(size, 0, 60), size);
    assert.deepEqual(capSizeForBitrate(size, 5_000, 0), size);
  });
});

describe('starved-link geometry fitting', () => {
  test('prefers 30 clear frames over 60 smeared ones when deeply starved', () => {
    // 5.4 Mbps (a real measured uplink) into 2560x1440: at 60 fps the
    // pixel budget is 0.9 Mpx (deep smear); at 30 fps it doubles to
    // 1.8 Mpx, which keeps desktop text legible.
    const fit = fitGeometryForBitrate({ width: 2560, height: 1440 }, 5_400, 60);
    assert.equal(fit.fps, 30);
    const pixels = fit.width * fit.height;
    assert.ok(pixels <= 1_810_000 && pixels >= 1_700_000, `pixels=${pixels}`);
  });

  test('keeps 60 fps when the cut is shallow', () => {
    const fit = fitGeometryForBitrate({ width: 1920, height: 1080 }, 8_000, 60);
    assert.equal(fit.fps, 60);
    assert.ok(fit.width < 1920);
  });

  test('changes nothing when the bitrate is ample', () => {
    assert.deepEqual(fitGeometryForBitrate({ width: 3840, height: 2160 }, 56_000, 60), {
      width: 3840,
      height: 2160,
      fps: 60,
    });
  });
});

describe('encode size negotiation', () => {
  const host = { width: 3840, height: 2160 };

  test('keeps the native size when the controller is at least as large', () => {
    assert.deepEqual(negotiateSize(host, { width: 3840, height: 2160 }), {
      width: 3840,
      height: 2160,
      scaled: false,
    });
    assert.deepEqual(negotiateSize(host, { width: 5120, height: 2880 }), {
      width: 3840,
      height: 2160,
      scaled: false,
    });
  });

  test('fits a smaller viewport without changing the aspect ratio', () => {
    // 16:9 controller: exact, no black bars anywhere.
    assert.deepEqual(negotiateSize(host, { width: 1920, height: 1080 }), {
      width: 1920,
      height: 1080,
      scaled: true,
    });
    // 20:9 phone in landscape: limited by height, so 2560x1440 and the phone
    // letterboxes the sides rather than losing the desktop's edges.
    assert.deepEqual(negotiateSize(host, { width: 3200, height: 1440 }), {
      width: 2560,
      height: 1440,
      scaled: true,
    });
    // iPad Pro 12.9" (4:3).
    assert.deepEqual(negotiateSize(host, { width: 2732, height: 2048 }), {
      width: 2732,
      height: 1536,
      scaled: true,
    });
  });

  test('rounds to even dimensions and never upscales', () => {
    const odd = negotiateSize(host, { width: 1001, height: 563 });
    assert.equal(odd.width % 2, 0);
    assert.equal(odd.height % 2, 0);
    assert.ok(odd.width <= 3840 && odd.height <= 2160);
    assert.deepEqual(negotiateSize(host), { width: 3840, height: 2160, scaled: false });
  });

  test('scales the bitrate with the pixel count but keeps a floor', () => {
    assert.equal(scaleBitrate(12_000, host, { width: 3840, height: 2160 }), 12_000);
    // 2560x1440 is 4/9 of the pixels: 12 Mbps stays above the 40% floor.
    assert.equal(scaleBitrate(12_000, host, { width: 2560, height: 1440 }), 5_333);
    // 1080p would be 3000 by pixel count, but the floor keeps text legible.
    assert.equal(scaleBitrate(12_000, host, { width: 1920, height: 1080 }), 4_800);
    assert.equal(scaleBitrate(6_000, host, { width: 640, height: 360 }), 2_500);
  });

  test('keeps the VBV buffer at about three frames', () => {
    // A large VBV buffer is latency the encoder hides from the network:
    // kbps/4 at 12 Mbps is 250 ms of smoothing. Three frames (~50 ms at
    // the 60 fps default) keeps bursts honest without starving CBR.
    const base = { source: { kind: 'screen' as const, mode: 'gdi' as const }, encoder: 'libx264' as const, onAccessUnit: () => {} };
    const args = buildEncoderArgs(base);
    assert.equal(args[args.indexOf('-bufsize') + 1], '600k');
    const args30 = buildEncoderArgs({ ...base, fps: 30, bitrateKbps: 8_000 });
    assert.equal(args30[args30.indexOf('-bufsize') + 1], '800k');
  });

  test('nvenc uses a quality preset with spatial AQ, not the fastest smear mode', () => {
    // p1 at a constrained bitrate turns text into blocks; p4 spends the
    // same bits far better and is still hardware-speed. Spatial AQ moves
    // bits toward detail (glyphs) instead of flat backgrounds.
    const args = buildEncoderArgs({
      source: { kind: 'screen', mode: 'gdi' },
      encoder: 'h264_nvenc',
      onAccessUnit: () => {},
    });
    assert.equal(args[args.indexOf('-preset') + 1], 'p4');
    assert.equal(args[args.indexOf('-spatial-aq') + 1], '1');
  });

  test('does not bake the host cursor into the video', () => {
    // The controller renders its own local cursor; a baked-in one lags
    // behind the real pointer and makes clicks feel mis-aimed.
    const base = { source: { kind: 'screen' as const, mode: 'gdi' as const }, encoder: 'libx264' as const, onAccessUnit: () => {} };
    const args = buildEncoderArgs(base);
    assert.equal(args[args.indexOf('-draw_mouse') + 1], '0');
  });

  test('crops one monitor out of the virtual desktop with gdigrab', () => {
    // GDI addresses the desktop as a whole, so a secondary screen is a
    // region of it — offsets may be negative (panel left of the primary).
    const base = { source: { kind: 'screen' as const, mode: 'gdi' as const }, encoder: 'libx264' as const, onAccessUnit: () => {} };
    const args = buildEncoderArgs({
      ...base,
      source: { kind: 'screen', mode: 'gdi', outputIndex: 2, rect: { x: -1080, y: 120, width: 1080, height: 1920 } },
    });
    assert.equal(args[args.indexOf('-offset_x') + 1], '-1080');
    assert.equal(args[args.indexOf('-offset_y') + 1], '120');
    assert.equal(args[args.indexOf('-video_size') + 1], '1080x1920');
    assert.ok(args.indexOf('-offset_x') < args.indexOf('desktop'));
    // No rect, no crop: the single-screen invocation is unchanged.
    assert.equal(buildEncoderArgs(base).includes('-offset_x'), false);
  });

  test('bakes the cursor into the video only when asked (pointer-lock mode)', () => {
    // Normally draw_mouse=0: the controller renders its own cursor. In
    // pointer-lock mode the browser hides that cursor, so the host must
    // bake its real one in or the pointer vanishes entirely.
    const gdi = { kind: 'screen' as const, mode: 'gdi' as const };
    const plain = buildEncoderArgs({ source: gdi, encoder: 'libx264', onAccessUnit: () => {} });
    assert.equal(plain[plain.indexOf('-draw_mouse') + 1], '0');
    const baked = buildEncoderArgs({
      source: { ...gdi, drawMouse: true },
      encoder: 'libx264',
      onAccessUnit: () => {},
    });
    assert.equal(baked[baked.indexOf('-draw_mouse') + 1], '1');
  });

  test('addresses a secondary display directly with ddagrab output_idx', () => {
    // Explicit `mode: 'dda'` skips the ffmpeg capability probe, so this runs
    // the same on every platform (the old fake `#!/bin/sh` binary was POSIX-only).
    const args = buildEncoderArgs({
      source: { kind: 'screen', mode: 'dda', outputIndex: 1, rect: { x: 1920, y: 0, width: 2560, height: 1440 } },
      encoder: 'h264_nvenc',
      onAccessUnit: () => {},
    });
    const chain = args.find((a) => a.includes('ddagrab'));
    assert.ok(chain?.startsWith('ddagrab=output_idx=1:'), chain);
  });

  test('only adds a scale stage when the frame is actually resized', () => {
    const base = { source: { kind: 'screen' as const, mode: 'gdi' as const }, encoder: 'libx264' as const, onAccessUnit: () => {} };
    assert.equal(buildEncoderArgs(base).includes('-vf'), false);
    const scaled = buildEncoderArgs({ ...base, targetSize: { width: 1920, height: 1080 } });
    const vf = scaled[scaled.indexOf('-vf') + 1];
    assert.equal(vf, 'scale=1920:1080:flags=fast_bilinear');
  });

  test('encoder reports not-running after its process exits', { timeout: 15000 }, async () => {
    // Regression: `running` used to stay true forever after a crash
    // (the dead ChildProcess was never cleared), which disabled every
    // revive path in the app — one session kept a frozen picture for
    // a minute after a 4 s desktop denial because the "restart when
    // the desktop returns" check could never fire.
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('encoder never exited')), 10000);
      const enc = new ScreenEncoder({
        source: { kind: 'test', size: '320x240' },
        fps: 10,
        bitrateKbps: 400,
        encoder: 'libx264',
        ffmpegPath: process.platform === 'win32' ? 'Z:\\nonexistent\\ffmpeg.exe' : '/bin/false',
        onAccessUnit: () => {},
        onExit: () => {
          clearTimeout(timer);
          assert.equal(enc.running, false);
          resolve();
        },
      });
      enc.start();
    });
    await exited;
  });
});
