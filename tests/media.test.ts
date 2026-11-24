import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AccessUnitAssembler, firstMbInSlice, joinAnnexB, splitAnnexB } from '../src/media/nal.ts';
import { annexBToAvcc, buildAvcC, codecString, extractParameterSets } from '../src/media/avc.ts';
import { negotiateSize, scaleBitrate } from '../src/media/target.ts';
import { buildEncoderArgs } from '../src/media/encoder.ts';

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

  test('does not bake the host cursor into the video', () => {
    // The controller renders its own local cursor; a baked-in one lags
    // behind the real pointer and makes clicks feel mis-aimed.
    const base = { source: { kind: 'screen' as const, mode: 'gdi' as const }, encoder: 'libx264' as const, onAccessUnit: () => {} };
    const args = buildEncoderArgs(base);
    assert.equal(args[args.indexOf('-draw_mouse') + 1], '0');
  });

  test('only adds a scale stage when the frame is actually resized', () => {
    const base = { source: { kind: 'screen' as const, mode: 'gdi' as const }, encoder: 'libx264' as const, onAccessUnit: () => {} };
    assert.equal(buildEncoderArgs(base).includes('-vf'), false);
    const scaled = buildEncoderArgs({ ...base, targetSize: { width: 1920, height: 1080 } });
    const vf = scaled[scaled.indexOf('-vf') + 1];
    assert.equal(vf, 'scale=1920:1080:flags=fast_bilinear');
  });
});
