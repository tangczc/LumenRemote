import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import dgram from 'node:dgram';
import { CongestionController, DelayGradientEstimator, JitterEstimator } from '../src/transport/congestion.ts';
import { Pacer } from '../src/transport/pacer.ts';
import { SimulatedLink, PERFECT_LINK, UdpLink, type SimConfig } from '../src/transport/link.ts';
import { Session, type IncomingFrame } from '../src/transport/session.ts';
import { deriveSessionKeys, generateEphemeral } from '../src/protocol/crypto.ts';
import { Channel, Codec, PacketFlags } from '../src/protocol/constants.ts';
import type { InputEvent } from '../src/protocol/messages.ts';

describe('congestion controller', () => {
  test('decreases on sustained queueing, recovers when clean', () => {
    let now = 0;
    const cc = new CongestionController({ initialBps: 8_000_000, minBps: 500_000, maxBps: 20_000_000, nowMs: () => now });
    const start = cc.targetBps;

    for (let i = 0; i < 10; i++) {
      now += 50;
      cc.onSample({ lossRate: 0, delayGradientUs: 30_000, rttUs: 40_000 });
    }
    assert.ok(cc.targetBps < start, `expected decrease, got ${cc.targetBps} vs ${start}`);
    const afterDecrease = cc.targetBps;

    for (let i = 0; i < 40; i++) {
      now += 100;
      cc.onSample({ lossRate: 0, delayGradientUs: 0, rttUs: 40_000 });
    }
    assert.ok(cc.targetBps > afterDecrease, 'expected additive increase during clean period');
  });

  test('loss produces a harder decrease than delay', () => {
    const mk = () => new CongestionController({ initialBps: 10_000_000, nowMs: () => 0 });
    const a = mk();
    a.onSample({ lossRate: 0, delayGradientUs: 40_000, rttUs: 30_000 });
    const b = mk();
    b.onSample({ lossRate: 0.2, delayGradientUs: 0, rttUs: 30_000 });
    assert.ok(b.targetBps < a.targetBps);
  });

  test('never leaves the configured bounds', () => {
    let now = 0;
    const cc = new CongestionController({ initialBps: 1_000_000, minBps: 400_000, maxBps: 2_000_000, nowMs: () => now });
    for (let i = 0; i < 100; i++) {
      now += 100;
      cc.onSample({ lossRate: 0.9, delayGradientUs: 0, rttUs: 1 });
    }
    assert.equal(cc.targetBps, 400_000);
  });
});

describe('estimators', () => {
  test('delay gradient detects a growing queue', () => {
    const g = new DelayGradientEstimator();
    let arrival = 0;
    let send = 0;
    for (let i = 0; i < 10; i++) {
      arrival += 10_000;
      send += 10_000;
      g.add(arrival, send);
    }
    assert.equal(Math.round(g.take()), 0);

    for (let i = 0; i < 10; i++) {
      arrival += 12_000; // packets arrive slower than they were sent
      send += 10_000;
      g.add(arrival, send);
    }
    assert.ok(g.take() > 1_000);
  });

  test('jitter tracks arrival variance', () => {
    const j = new JitterEstimator();
    for (let i = 0; i < 20; i++) j.add(i * 10_000 + (i % 2) * 5_000, i * 10_000);
    assert.ok(j.valueUs > 0);
  });
});

describe('pacer', () => {
  test('respects the configured rate', async () => {
    const sent: number[] = [];
    const pacer = new Pacer({ rateBps: 800_000, tickMs: 1, send: (p) => sent.push(p.length) });
    pacer.start();
    const packet = Buffer.alloc(1000);
    for (let i = 0; i < 20; i++) pacer.enqueue(() => packet, packet.length, 1);
    await new Promise((r) => setTimeout(r, 60));
    pacer.stop();
    assert.ok(sent.length > 0, 'nothing was sent');
    assert.ok(sent.length < 20, `pacer did not throttle: sent ${sent.length}/20`);
  });

  test('high priority traffic jumps the media queue', async () => {
    const order: string[] = [];
    const pacer = new Pacer({ rateBps: 4_000, tickMs: 1, send: (p) => order.push(p.toString()) });
    // Starve the bucket so everything queues instead of being sent on enqueue.
    pacer.enqueue(() => Buffer.alloc(200, 0x6d), 200, 1);
    pacer.enqueue(() => Buffer.alloc(200, 0x6e), 200, 1);
    pacer.enqueue(() => Buffer.from('input'), 5, 0);
    pacer.flushImmediately();
    pacer.stop();
    assert.equal(order[order.length - 1], 'input');
  });

  test('drops media when the latency budget is exceeded but never control', () => {
    const pacer = new Pacer({ rateBps: 100_000, maxQueueMs: 40, maxQueueBytes: 2000, send: () => {} });
    const build = () => Buffer.alloc(1500);
    assert.equal(pacer.enqueue(build, 1500, 1), true);
    assert.equal(pacer.wouldOverflow(1500), true);
    assert.equal(pacer.congested, true);
    assert.equal(pacer.enqueue(() => Buffer.alloc(1500), 1500, 0), true);
  });
});

// ------------------------------------------------------------------ sessions

function sessionPair(simA: SimConfig, simB: SimConfig = simA) {
  const { a, b } = SimulatedLink.pair(simA, simB);
  const hostEph = generateEphemeral();
  const ctrlEph = generateEphemeral();
  const sessionId = 'test-session';
  const hostKeys = deriveSessionKeys({
    sessionId,
    localEphemeral: hostEph,
    peerPublicRaw: ctrlEph.publicKeyRaw,
    role: 'host',
  });
  const ctrlKeys = deriveSessionKeys({
    sessionId,
    localEphemeral: ctrlEph,
    peerPublicRaw: hostEph.publicKeyRaw,
    role: 'controller',
  });

  const hostFrames: IncomingFrame[] = [];
  const ctrlFrames: IncomingFrame[] = [];
  const ctrlInputs: { ev: InputEvent; rxUs: number }[] = [];

  const host = new Session({
    role: 'host',
    link: a,
    keys: hostKeys,
    sessionId,
    initialBitrateBps: 20_000_000,
    onFrame: (f) => hostFrames.push(f),
    onInput: (ev, rxUs) => ctrlInputs.push({ ev, rxUs }),
  });
  const controller = new Session({
    role: 'controller',
    link: b,
    keys: ctrlKeys,
    sessionId,
    initialBitrateBps: 20_000_000,
    onFrame: (f) => ctrlFrames.push(f),
  });
  host.start();
  controller.start();
  return { host, controller, hostFrames, ctrlFrames, ctrlInputs, simA: a, simB: b };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('session over simulated link', () => {
  test('delivers a single-fragment frame intact', async () => {
    const s = sessionPair(PERFECT_LINK);
    try {
      const payload = Buffer.from('hello remote desktop');
      s.host.sendFrame(Codec.Raw, 0, payload, Channel.Video);
      await waitFor(() => s.ctrlFrames.length >= 1, 2000, 'frame');
      assert.deepEqual(s.ctrlFrames[0]!.payload, payload);
      assert.equal(s.ctrlFrames[0]!.recovered, false);
    } finally {
      s.host.close();
      s.controller.close();
      s.simA.close();
      s.simB.close();
    }
  });

  test('reassembles a 300 KB frame across many fragments', async () => {
    const s = sessionPair({ ...PERFECT_LINK, delayMs: 2 });
    try {
      const payload = Buffer.alloc(300 * 1024);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
      s.host.sendFrame(Codec.H264, PacketFlags.Key, payload);
      await waitFor(() => s.ctrlFrames.length >= 1, 3000, 'frame');
      const got = s.ctrlFrames[0]!;
      assert.equal(got.payload.length, payload.length);
      assert.ok(got.payload.equals(payload), 'payload mismatch');
      assert.ok(got.totalFrags > 200);
    } finally {
      s.host.close();
      s.controller.close();
      s.simA.close();
      s.simB.close();
    }
  });

  test('input events reach the host in order', async () => {
    const s = sessionPair({ ...PERFECT_LINK, delayMs: 1 });
    try {
      s.controller.sendInput({ k: 'mm', dx: 10, dy: -4 });
      s.controller.sendInput({ k: 'kd', scan: 30, vk: 65 });
      await waitFor(() => s.ctrlInputs.length >= 2, 2000, 'input');
      assert.deepEqual(s.ctrlInputs[0]!.ev, { k: 'mm', dx: 10, dy: -4 });
      assert.deepEqual(s.ctrlInputs[1]!.ev, { k: 'kd', scan: 30, vk: 65 });
    } finally {
      s.host.close();
      s.controller.close();
      s.simA.close();
      s.simB.close();
    }
  });

  test('survives 5% loss: most frames still arrive thanks to FEC and NACK', async () => {
    const s = sessionPair({ delayMs: 8, jitterMs: 2, lossPct: 5, reorderPct: 3 });
    try {
      const total = 12;
      const sent: Buffer[] = [];
      for (let i = 0; i < total; i++) {
        const payload = Buffer.alloc(60 * 1024, i + 1);
        sent.push(payload);
        s.host.sendFrame(Codec.H264, i === 0 ? PacketFlags.Key : 0, payload);
        await new Promise((r) => setTimeout(r, 40));
      }
      await waitFor(() => s.ctrlFrames.length >= total * 0.7, 5000, 'most frames');
      const stats = s.controller.stats;
      assert.ok(stats.framesReceived > 0);
      assert.ok(s.simA.stats.dropped > 0, 'simulator should have dropped packets');
      for (const f of s.ctrlFrames) {
        assert.equal(f.payload.length, 60 * 1024);
      }
    } finally {
      s.host.close();
      s.controller.close();
      s.simA.close();
      s.simB.close();
    }
  });

  test('rejects tampered packets instead of delivering them', async () => {
    const s = sessionPair(PERFECT_LINK);
    try {
      const original = s.simA.send.bind(s.simA);
      let tampered = false;
      s.simA.send = (p: Buffer) => {
        if (!tampered && p.length > 60) {
          tampered = true;
          const copy = Buffer.from(p);
          const at = copy.length - 20;
          copy[at] = (copy[at] ?? 0) ^ 0xff;
          original(copy);
          return;
        }
        original(p);
      };
      s.host.sendFrame(Codec.Raw, 0, Buffer.alloc(4096, 7));
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(s.controller.stats.authFailures > 0, 'expected at least one auth failure');
    } finally {
      s.host.close();
      s.controller.close();
      s.simA.close();
      s.simB.close();
    }
  });

  test('clock sync converges and reports ~configured one-way delay', async () => {
    const s = sessionPair({ ...PERFECT_LINK, delayMs: 15 });
    try {
      // setTimeout on Windows has ~15.6 ms granularity, so a 15 ms one-way delay can
      // measure anywhere from 15 to 31 ms and the RTT from 30 to 62 ms. These bounds
      // allow for that jitter while still failing on any gross error in the offset math.
      await waitFor(() => s.controller.stats.clockSamples >= 3 && s.controller.rttUs / 1000 < 70, 5000, 'clock sync');
      const rttMs = s.controller.rttUs / 1000;
      assert.ok(rttMs >= 25 && rttMs <= 70, `expected ~30ms rtt with timer jitter, got ${rttMs.toFixed(1)}ms`);

      s.host.sendFrame(Codec.Raw, 0, Buffer.alloc(2000, 1));
      await waitFor(() => s.ctrlFrames.length >= 1, 2000, 'frame');
      const oneWayMs = s.ctrlFrames[0]!.oneWayUs / 1000;
      assert.ok(oneWayMs > 5 && oneWayMs < 55, `expected ~15ms one-way with timer jitter, got ${oneWayMs.toFixed(1)}ms`);
    } finally {
      s.host.close();
      s.controller.close();
      s.simA.close();
      s.simB.close();
    }
  });
});
describe('parallel hole punching', () => {
  interface Sink {
    port: number;
    received: Buffer[];
    reply: (payload: Buffer) => void;
    close: () => void;
  }

  /** A udp4 peer that answers from the same port it was probed on. */
  const makeSink = (): Promise<Sink> =>
    new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      const received: Buffer[] = [];
      let lastFrom: dgram.RemoteInfo | null = null;
      sock.on('message', (msg, from) => {
        received.push(msg);
        lastFrom = from;
      });
      sock.bind(0, '127.0.0.1', () => {
        resolve({
          port: sock.address().port,
          received,
          reply: (payload) => {
            if (lastFrom) sock.send(payload, lastFrom.port, lastFrom.address);
          },
          close: () => sock.close(),
        });
      });
    });

  test('probes every candidate at once, then latches onto the one that answers', async () => {
    const [a, b] = await Promise.all([makeSink(), makeSink()]);
    const link = await UdpLink.bind({ host: '127.0.0.1' });
    link.setLatch(true);
    try {
      link.setCandidates([
        { address: '127.0.0.1', port: a!.port },
        { address: '127.0.0.1', port: b!.port },
      ]);
      link.send(Buffer.from('punch'));

      // Both pinholes open from a single send, which is the whole point: no
      // candidate has to wait its turn.
      await waitFor(() => a!.received.length >= 1 && b!.received.length >= 1, 2000, 'fan-out');
      assert.equal(link.latched, false, 'nothing is latched before a reply');

      b!.reply(Buffer.from('pong'));
      await waitFor(() => link.latched, 2000, 'latch');
      assert.deepEqual(link.remoteEndpoint, { address: '127.0.0.1', port: b!.port });

      // Once latched the losing candidate must not keep receiving traffic.
      const beforeA = a!.received.length;
      link.send(Buffer.from('media'));
      await waitFor(() => b!.received.length >= 2, 2000, 'unicast');
      assert.equal(a!.received.length, beforeA);
    } finally {
      link.close();
      a!.close();
      b!.close();
    }
  });
});
