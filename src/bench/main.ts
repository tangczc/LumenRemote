import { parseArgs } from 'node:util';
import { SimulatedLink, PERFECT_LINK, UdpLink, type Link, type SimConfig } from '../transport/link.ts';
import { Session, type IncomingFrame } from '../transport/session.ts';
import { deriveSessionKeys, generateEphemeral } from '../protocol/crypto.ts';
import { monotonicUs } from '../protocol/clock.ts';
import { Codec, FrameFlags } from '../protocol/constants.ts';
import type { InputEvent } from '../protocol/messages.ts';
import { HighResTicker } from '../transport/ticker.ts';

const { values } = parseArgs({
  options: {
    frames: { type: 'string', default: '180' },
    fps: { type: 'string', default: '60' },
    size: { type: 'string', default: '64000' },
    loss: { type: 'string', default: '0' },
    rtt: { type: 'string', default: '0' },
    jitter: { type: 'string', default: '0' },
    reorder: { type: 'string', default: '0' },
    bandwidth: { type: 'string', default: '0' },
    bitrate: { type: 'string', default: '40' },
    real: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`
Latency benchmark: synthetic frames through the real session stack.

  --frames <n>       number of frames to send (default 180)
  --fps <n>          send rate (default 60)
  --size <bytes>     payload size per frame (default 64000)
  --loss <pct>       simulated packet loss
  --rtt <ms>         simulated round-trip time
  --jitter <ms>      simulated jitter (one-way, +/-)
  --reorder <pct>    simulated reordering
  --bandwidth <kbps> simulated link capacity (0 = unlimited)
  --bitrate <Mbps>   session bitrate budget (default 40)
  --real             use real loopback UDP instead of the in-process simulator
  --verbose          print per-second diagnostics
`);
  process.exit(0);
}

const frameCount = Number(values.frames);
const fps = Number(values.fps);
const payloadSize = Number(values.size);

const sim: SimConfig = {
  delayMs: Number(values.rtt) / 2,
  jitterMs: Number(values.jitter),
  lossPct: Number(values.loss),
  reorderPct: Number(values.reorder),
  bandwidthKbps: Number(values.bandwidth) || undefined,
};

const useReal = values.real === true;
const runtimeMs = (frameCount / fps) * 1000 + 2500;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  let a: Link;
  let b: Link;
  let simA: SimulatedLink | null = null;

  if (useReal) {
    process.env.RD_REAL = '1';
    const left = await UdpLink.bind({});
    const right = await UdpLink.bind({});
    left.setRemote({ address: '127.0.0.1', port: right.address!.port });
    right.setRemote({ address: '127.0.0.1', port: left.address!.port });
    a = left;
    b = right;
  } else {
    const pair = SimulatedLink.pair(sim);
    simA = pair.a;
    a = pair.a;
    b = pair.b;
  }

  const hostEph = generateEphemeral();
  const ctrlEph = generateEphemeral();
  const sessionId = 'bench';
  const hostKeys = deriveSessionKeys({ sessionId, localEphemeral: hostEph, peerPublicRaw: ctrlEph.publicKeyRaw, role: 'host' });
  const ctrlKeys = deriveSessionKeys({ sessionId, localEphemeral: ctrlEph, peerPublicRaw: hostEph.publicKeyRaw, role: 'controller' });

  const latencies: number[] = [];
  const inputRtts: number[] = [];
  let frames = 0;
  let recovered = 0;
  let bytes = 0;
  const inputSentAt = new Map<string, number>();
  let inputSeq = 0;

    // `--bitrate` is expressed in Mbps, like the UI presets.
  const benchBps = Number(values.bitrate) * 1_000_000;
  const host: Session = new Session({
    role: 'host',
    link: a,
    keys: hostKeys,
    sessionId,
    initialBitrateBps: benchBps,
    maxBitrateBps: benchBps,
    onInput: (event: InputEvent, rxUs: number) => {
      if (event.k === 'kr') host.sendControl({ t: 'notice', level: 'info', message: `echo:${event.text}:${rxUs}` });
    },
    onControl: (msg) => {
      if (msg.t === 'notice' && msg.message.startsWith('echo:')) {
        const [, seq] = msg.message.split(':');
        const sent = inputSentAt.get(seq ?? '');
        if (sent) inputRtts.push((monotonicUs() - sent) / 1000);
      }
    },
  });

  const controller: Session = new Session({
    role: 'controller',
    link: b,
    keys: ctrlKeys,
    sessionId,
    initialBitrateBps: benchBps,
    maxBitrateBps: benchBps,
    onFrame: (frame: IncomingFrame) => {
      frames++;
      if (frame.recovered) recovered++;
      latencies.push(frame.oneWayUs / 1000);
    },
    onControl: (msg) => {
      if (msg.t === 'notice' && msg.message.startsWith('echo:')) {
        const [, seq] = msg.message.split(':');
        const sent = inputSentAt.get(seq ?? '');
        if (sent) inputRtts.push((monotonicUs() - sent) / 1000);
      }
    },
  });

  host.start();
  controller.start();

  const clockDeadline = Date.now() + 2500;
  while (Date.now() < clockDeadline && controller.stats.clockSamples < 3) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const payload = Buffer.alloc(payloadSize, 0x5a);
  const startedAt = Date.now();
  let sent = 0;
  let skipped = 0;

  const ticker = new HighResTicker(1000 / fps, frameCount, (idx) => {
    payload.writeUInt32BE(idx, 0);
    const id = host.sendFrame(Codec.H264, idx % 60 === 0 ? FrameFlags.Key : 0, payload);
    if (id >= 0) {
      sent++;
      bytes += payloadSize;
    } else {
      skipped++;
    }
  });
  ticker.start();

  if (values.verbose) {
    const monitor = setInterval(() => {
      const h = host.stats;
      const c = controller.stats;
      const simInfo = simA ? ` simSent=${simA.stats.sent} simDrop=${simA.stats.dropped} simDeliv=${simA.stats.delivered}` : '';
      console.log(
        `  t=${((Date.now() - startedAt) / 1000).toFixed(1)}s sent=${sent} skip=${skipped} recv=${frames} ` +
          `txRate=${(h.pacerRateBps / 1e6).toFixed(1)}Mbps target=${(h.targetBps / 1e6).toFixed(1)}Mbps ` +
          `queue=${h.queueBytes}B budget=${h.queueBytes + Math.max(0, 0)} loss=${c.lossPct}% ` +
          `pktOut=${h.packetsSent} pktIn=${c.packetsReceived} rtt=${(c.rttUs / 1000).toFixed(0)}ms${simInfo}`,
      );
    }, 1000);
    monitor.unref?.();
  }

  for (let i = 0; i < 40; i++) {
    const seq = String(inputSeq++);
    inputSentAt.set(seq, monotonicUs());
    controller.sendInput({ k: 'kr', text: seq });
    await new Promise((r) => setTimeout(r, 25));
  }

  await new Promise<void>((resolve) => {
    const deadline = Date.now() + runtimeMs;
    const poll = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });

  const stats = controller.stats;
  const sorted = [...latencies].sort((x, y) => x - y);
  const sortedInput = [...inputRtts].sort((x, y) => x - y);
  const elapsed = (Date.now() - startedAt) / 1000;

  console.log('');
  console.log('  Lumen Remote — transport benchmark');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  mode            ${useReal ? 'real loopback UDP' : 'in-process simulator'}`);
  if (!useReal) {
    console.log(`  link            rtt=${sim.delayMs * 2}ms jitter=±${sim.jitterMs}ms loss=${sim.lossPct}% reorder=${sim.reorderPct}%`);
  }
  console.log(`  payload         ${(payloadSize / 1024).toFixed(0)} KiB/frame @ ${fps} fps`);
  console.log(`  frames sent     ${sent}/${frameCount} (${(bytes / 1024 / 1024).toFixed(1)} MiB in ${elapsed.toFixed(1)} s)`);
  console.log(`  frames received ${frames}  (${((frames / Math.max(1, sent)) * 100).toFixed(1)}% of sent)`);
  console.log(`  frames skipped  ${skipped} (queue full)`);
  console.log(`  fec recovered   ${recovered}`);
  console.log(`  dropped/swept   ${stats.droppedFrames}`);
  console.log(`  clock rtt       ${(stats.rttUs / 1000).toFixed(2)} ms`);
  console.log(`  auth failures   ${stats.authFailures}`);
  console.log('');
  console.log('  one-way latency (capture → reassembled)');
  console.log(`    p50           ${pct(sorted, 50).toFixed(2)} ms`);
  console.log(`    p95           ${pct(sorted, 95).toFixed(2)} ms`);
  console.log(`    p99           ${pct(sorted, 99).toFixed(2)} ms`);
  console.log(`    max           ${(sorted[sorted.length - 1] ?? 0).toFixed(2)} ms`);
  console.log('');
  console.log('  input round-trip (controller → host echo)');
  console.log(`    samples       ${sortedInput.length}`);
  console.log(`    p50           ${pct(sortedInput, 50).toFixed(2)} ms`);
  console.log(`    p95           ${pct(sortedInput, 95).toFixed(2)} ms`);
  console.log(`    max           ${(sortedInput[sortedInput.length - 1] ?? 0).toFixed(2)} ms`);
  console.log('');

  host.close();
  controller.close();
  simA?.close();
  a.close();
  b.close();
  process.exit(0);
}

void PERFECT_LINK;
void main();
