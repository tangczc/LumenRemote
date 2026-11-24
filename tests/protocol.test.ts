import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  MAX_PAYLOAD,
  FRAME_HEADER_LEN,
  PacketFlags,
  Channel,
  Codec,
  Reassembler,
  buildParity,
  decodeFrameHeader,
  decodeHeader,
  deriveSessionKeys,
  directionalKeys,
  encodeHeader,
  fragmentFrame,
  generateEphemeral,
  parityCountFor,
  recoverMissing,
  tsDelta32,
  ClockSync,
  encodeControl,
  decodeControl,
  encodeInput,
  decodeInput,
} from '../src/protocol/index.ts';

describe('packet header', () => {
  test('roundtrips every field', () => {
    const h = {
      seq: 0xdeadbeef,
      sendTsUs: 123456789,
      channel: Channel.Video,
      frameId: 4242,
      flags: PacketFlags.Key | PacketFlags.FecProtected,
      fragIdx: 3,
      fragCnt: 17,
      fecIdx: 255,
    };
    const decoded = decodeHeader(encodeHeader(h));
    assert.deepEqual(decoded, h);
  });

  test('rejects truncated buffers', () => {
    assert.throws(() => decodeHeader(Buffer.alloc(19)), RangeError);
  });

  test('tsDelta32 is wrap aware', () => {
    assert.equal(tsDelta32(10, 5), 5);
    // 2^32 wrap: 100 us after 2^32-50
    assert.equal(tsDelta32(100, 0xffffffff - 49), 150);
  });
});

describe('fragmentation', () => {
  test('single fragment carries the frame header', () => {
    const payload = Buffer.from('hello world');
    const { fragments, header } = fragmentFrame(7, Codec.H264, 1, 999n, payload);
    assert.equal(fragments.length, 1);
    assert.equal(header.fragCount, 1);
    const decoded = decodeFrameHeader(fragments[0]!.data);
    assert.equal(decoded.frameId, 7);
    assert.equal(decoded.totalLen, FRAME_HEADER_LEN + payload.length);
    assert.equal(decoded.captureTsUs, 999n);
    assert.deepEqual(fragments[0]!.data.subarray(FRAME_HEADER_LEN), payload);
  });

  test('large payload splits at MTU and reassembles byte-identical', () => {
    const payload = Buffer.alloc(MAX_PAYLOAD * 4 + 321);
    for (let i = 0; i < payload.length; i++) payload[i] = i * 31 & 0xff;

    const { fragments, header } = fragmentFrame(1, Codec.H264, 0, 123n, payload);
    assert.ok(fragments.length > 4);
    for (let i = 1; i < fragments.length - 1; i++) {
      assert.equal(fragments[i]!.data.length, MAX_PAYLOAD);
    }

    const r = new Reassembler();
    let frame = null;
    // deliver out of order, last first
    for (let i = fragments.length - 1; i >= 0; i--) {
      const f = fragments[i]!;
      const out = r.push(Channel.Video, header.frameId, f.fragIdx, f.fragCnt, f.data, 1000 + i);
      if (out) frame = out;
    }
    assert.ok(frame);
    assert.equal(frame!.totalFrags, header.fragCount);
    assert.deepEqual(frame!.payload, payload);
  });

  test('duplicate fragments are ignored and do not complete a frame', () => {
    const { fragments, header } = fragmentFrame(2, Codec.H264, 0, 0n, Buffer.alloc(MAX_PAYLOAD * 2));
    const r = new Reassembler();
    for (const f of fragments) {
      if (f.fragIdx === 0) {
        assert.equal(r.push(Channel.Video, header.frameId, f.fragIdx, f.fragCnt, f.data, 0), null);
        assert.equal(r.push(Channel.Video, header.frameId, f.fragIdx, f.fragCnt, f.data, 0), null);
      }
    }
    assert.ok(r.missing(Channel.Video, header.frameId)!.length > 0);
  });

  test('sweep evicts stale incomplete frames', () => {
    const { fragments, header } = fragmentFrame(3, Codec.H264, 0, 0n, Buffer.alloc(MAX_PAYLOAD * 3));
    const r = new Reassembler(500);
    r.push(Channel.Video, header.frameId, 0, fragments[0]!.fragCnt, fragments[0]!.data, 0);
    assert.equal(r.sweep(499).length, 0);
    assert.equal(r.sweep(501).length, 1);
    assert.equal(r.size, 0);
  });
});

describe('xor fec', () => {
  test('recovers one loss per parity group', () => {
    const data = Array.from({ length: 8 }, (_, i) => Buffer.from(`payload-${i}`));
    const r = 2;
    const parity = buildParity(data, r);

    const parts: (Buffer | null)[] = data.slice();
    parts[3] = null;
    parts[6] = null;

    const map = new Map(parity.map((p) => [p.parityIdx, p.data]));
    const recovered = recoverMissing(parts, map, r, (i) => data[i]!.length);

    assert.equal(recovered.size, 2);
    assert.deepEqual(recovered.get(3)!.toString(), 'payload-3');
    assert.deepEqual(recovered.get(6)!.toString(), 'payload-6');
  });

  test('cannot recover two losses inside the same group', () => {
    const data = Array.from({ length: 8 }, (_, i) => Buffer.from(`p${i}`));
    const parity = buildParity(data, 2);
    const parts: (Buffer | null)[] = data.slice();
    parts[0] = null;
    parts[2] = null;
    const map = new Map(parity.map((p) => [p.parityIdx, p.data]));
    assert.equal(recoverMissing(parts, map, 2, (i) => data[i]!.length).size, 0);
  });

  test('handles ragged tail fragments', () => {
    const data = [Buffer.alloc(MAX_PAYLOAD, 1), Buffer.alloc(MAX_PAYLOAD, 2), Buffer.from([9, 9, 9])];
    const parity = buildParity(data, 3);
    const parts: (Buffer | null)[] = data.slice();
    parts[2] = null;
    const map = new Map(parity.map((p) => [p.parityIdx, p.data]));
    const rec = recoverMissing(parts, map, 3, (i) => data[i]!.length);
    assert.deepEqual([...rec.get(2)!], [9, 9, 9]);
  });

  test('parity count scales with loss', () => {
    assert.equal(parityCountFor(1, 0), 0);
    assert.ok(parityCountFor(16, 0) >= 1);
    assert.ok(parityCountFor(16, 0.1) > parityCountFor(16, 0));
  });
});

describe('crypto', () => {
  test('both sides derive the same directional keys', () => {
    const host = generateEphemeral();
    const ctrl = generateEphemeral();
    const base = { sessionId: 'sess-1', password: 'p@ss' };

    const hostKeys = deriveSessionKeys({
      ...base,
      localEphemeral: host,
      peerPublicRaw: ctrl.publicKeyRaw,
      role: 'host',
    });
    const ctrlKeys = deriveSessionKeys({
      ...base,
      localEphemeral: ctrl,
      peerPublicRaw: host.publicKeyRaw,
      role: 'controller',
    });

    assert.equal(hostKeys.sas, ctrlKeys.sas);
    const hostDir = directionalKeys(hostKeys, 'host');
    const ctrlDir = directionalKeys(ctrlKeys, 'controller');

    const aad = Buffer.from('aad-header');
    const sealed = hostDir.tx.seal(1, aad, Buffer.from('low latency'));
    assert.deepEqual(ctrlDir.rx.open(1, aad, sealed)!.toString(), 'low latency');
    // wrong sequence must fail
    assert.equal(ctrlDir.rx.open(2, aad, sealed), null);
    // tampered AAD must fail
    assert.equal(ctrlDir.rx.open(1, Buffer.from('aad-headeR'), sealed), null);
  });

  test('a different password yields a different key (fails closed)', () => {
    const host = generateEphemeral();
    const ctrl = generateEphemeral();
    const hostKeys = deriveSessionKeys({
      sessionId: 's',
      password: 'right',
      localEphemeral: host,
      peerPublicRaw: ctrl.publicKeyRaw,
      role: 'host',
    });
    const ctrlKeys = deriveSessionKeys({
      sessionId: 's',
      password: 'wrong',
      localEphemeral: ctrl,
      peerPublicRaw: host.publicKeyRaw,
      role: 'controller',
    });
    assert.notEqual(hostKeys.sas, ctrlKeys.sas);
    const sealed = directionalKeys(hostKeys, 'host').tx.seal(1, Buffer.alloc(0), Buffer.from('x'));
    assert.equal(directionalKeys(ctrlKeys, 'controller').rx.open(1, Buffer.alloc(0), sealed), null);
  });
});

describe('clock sync', () => {
  test('estimates offset and rtt from four timestamps', () => {
    const c = new ClockSync();
    // peer clock is 5_000_000 us ahead, one-way 10_000 us
    for (let i = 0; i < 5; i++) {
      const t1 = 1_000_000 + i * 100_000;
      const t2 = t1 + 5_000_000 + 10_000;
      const t3 = t2 + 500;
      const t4 = t1 + 20_000 + 500;
      c.addSample({ t1, t2, t3, t4 });
    }
    assert.ok(c.synced);
    assert.equal(Math.round(c.rttUs), 20_000);
    assert.equal(Math.round(c.offsetUs), 5_000_000);
    assert.equal(c.toLocal(5_000_000), 0);
  });
});

describe('control messages', () => {
  test('control roundtrip', () => {
    const msg = { t: 'bitrate' as const, bps: 12_000_000 };
    assert.deepEqual(decodeControl(encodeControl(msg)), msg);
  });

  test('quality control roundtrip (controller -> host preset key)', () => {
    const msg = { t: 'quality' as const, preset: 'game' };
    assert.deepEqual(decodeControl(encodeControl(msg)), msg);
  });

  test('input roundtrip and garbage rejection', () => {
    const ev = { k: 'mm' as const, dx: 12, dy: -3 };
    assert.deepEqual(decodeInput(encodeInput(ev)), ev);
    assert.equal(decodeControl(Buffer.from('not json')), null);
  });
});
