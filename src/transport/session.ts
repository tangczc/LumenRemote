import {
  AUTH_TAG_LEN,
  MAX_PAYLOAD,
  FRAME_HEADER_LEN,
  HEADER_LEN,
  Channel,
  Codec,
  PacketFlags,
  Reassembler,
  buildParity,
  decodeControl,
  decodeFrameHeader,
  decodeInput,
  decodeHeader,
  encodeControl,
  encodeHeader,
  fragmentFrame,
  monotonicUs,
  parityCountFor,
  recoverMissing,
  tsDelta32,
  type ControlMessage,
  type InputEvent,
  type NackEntry,
  type ReceiverReport,
} from '../protocol/index.ts';
import { directionalKeys, type DirectionalKeys, type SessionKeys } from '../protocol/crypto.ts';
import { ClockSync } from '../protocol/clock.ts';
import { CongestionController, DelayGradientEstimator, JitterEstimator } from './congestion.ts';
import { Pacer } from './pacer.ts';
import type { Link } from './link.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;

export interface IncomingFrame {
  channel: number;
  frameId: number;
  codec: number;
  flags: number;
  captureTsUs: bigint;
  payload: Buffer;
  /** local monotonic receive time, 碌s */
  rxUs: number;
  /** estimated one-way transport latency, 碌s (0 until clock sync converges) */
  oneWayUs: number;
  /** true when XOR FEC reconstructed at least one fragment */
  recovered: boolean;
  /** number of missing fragments still outstanding when the frame completed */
  missingFrags: number;
  /** total fragments the sender split this frame into */
  totalFrags: number;
}

export interface SessionStats {
  role: 'host' | 'controller';
  sessionId: string;
  rttUs: number;
  oneWayUs: number;
  lossPct: number;
  jitterUs: number;
  targetBps: number;
  /** Actual configured pacer rate, which can lag the target by one report. */
  pacerRateBps: number;
  sendBps: number;
  recvBps: number;
  fps: number;
  framesReceived: number;
  recoveredFrames: number;
  droppedFrames: number;
  skippedFrames: number;
  packetsSent: number;
  packetsPerSec: number;
  avgPacketBytes: number;
  /** Packet composition of the last interval, for diagnosing overhead. */
  breakdown: { data: number; parity: number; control: number; retx: number };
  packetsReceived: number;
  authFailures: number;
  queueBytes: number;
  pendingFrames: number;
  clockSamples: number;
  sas: string;
}

export interface SessionOptions {
  role: 'host' | 'controller';
  link: Link;
  keys: SessionKeys;
  sessionId: string;
  initialBitrateBps?: number;
  maxBitrateBps?: number;
  fecEnabled?: boolean;
  logger?: Logger;
  onFrame?: (frame: IncomingFrame) => void;
  onInput?: (event: InputEvent, rxUs: number) => void;
  onControl?: (msg: ControlMessage, rxUs: number) => void;
  onStats?: (stats: SessionStats) => void;
  onBitrateChange?: (bps: number) => void;
  nowUs?: () => number;
}

interface ParityEntry {
  fragCnt: number;
  parities: Map<number, Buffer>;
  r: number;
  createdAtMs: number;
}

interface RetxEntry {
  channel: number;
  frameId: number;
  fragIdx: number;
  fragCnt: number;
  flags: number;
  payload: Buffer;
  expiresAtMs: number;
}

const REPORT_INTERVAL_MS = 20;
const NACK_INTERVAL_MS = 10;
const PING_INTERVAL_MS = 250;
const STATS_INTERVAL_MS = 500;
const SWEEP_INTERVAL_MS = 200;
const NACK_THROTTLE_MS = 20;
const PARITY_TTL_MS = 500;
/** Reception bitmap size. Must exceed RX_MEASURE_WINDOW + RX_REORDER_SLACK. */
const RX_WINDOW = 2048;
/** Measured loss window, in packets. */
const RX_MEASURE_WINDOW = 1024;
/** Newest sequence numbers excluded from the loss estimate (reordering slack). */
const RX_REORDER_SLACK = 128;

function unwrapTs32(ts32: number, refAbs: number): number {
  const two32 = 0x1_0000_0000;
  const base = Math.floor(refAbs / two32) * two32;
  let v = base + ts32;
  if (v > refAbs + two32 / 2) v -= two32;
  if (v < refAbs - two32 / 2) v += two32;
  return v;
}

/**
 * One endpoint of a remote-desktop session: channel multiplexing, sequencing,
 * AEAD, FEC, retransmission, congestion control and QoE accounting all live
 * here so the host and controller apps stay thin.
 */
export class Session {
  readonly sessionId: string;
  readonly role: 'host' | 'controller';
  readonly sas: string;

  private readonly link: Link;
  private readonly keys: DirectionalKeys;
  private readonly pacer: Pacer;
  private readonly cc: CongestionController;
  private readonly reassembler = new Reassembler(400);
  private readonly clock = new ClockSync();
  private readonly gradient = new DelayGradientEstimator();
  private readonly jitter = new JitterEstimator();
  private readonly nowUs: () => number;
  private readonly log: Logger;
  private readonly fecEnabled: boolean;

  private parity = new Map<number, ParityEntry>();
  private retx = new Map<string, RetxEntry>();
  private nackSentAt = new Map<number, number>();
  /** Recently completed frames, so late retransmits cannot reassemble twice. */
  private completed = new Set<number>();

  private txSeq = (Math.random() * 0xffff_ffff) >>> 0;
  private txFrameId = (Math.random() * 0xffff) >>> 0;
  private txInputSeq = 0;
  private rxInputSeq = -1;
  private txBytes = 0;
  private txPackets = 0;
  private intervalTxPackets = 0;
  private intervalTxBytes = 0;
  private intervalKinds = { data: 0, parity: 0, control: 0, retx: 0 };

  private rxHighest = -1;
  private rxBaseline = -1;
  private readonly rxWindow = new Uint8Array(RX_WINDOW);
  private readonly rxWindowSeq = new Uint32Array(RX_WINDOW);
  private lastLossPct = 0;
  private rxBytes = 0;
  private rxPackets = 0;
  private authFailures = 0;
  private intervalFrames = 0;
  private intervalTxFrames = 0;
  private framesReceived = 0;
  private recoveredFrames = 0;
  private droppedFrames = 0;
  private skippedFrames = 0;
  private txDropped = 0;

  private timers: NodeJS.Timeout[] = [];
  private closed = false;
  private lastTargetBps = 0;

  constructor(private readonly opts: SessionOptions) {
    this.sessionId = opts.sessionId;
    this.role = opts.role;
    this.link = opts.link;
    this.nowUs = opts.nowUs ?? monotonicUs;
    this.log = opts.logger ?? (() => {});
    this.fecEnabled = opts.fecEnabled ?? true;
    this.keys = directionalKeys(opts.keys, opts.role);
    this.sas = opts.keys.sas;

    this.cc = new CongestionController({
      initialBps: opts.initialBitrateBps ?? 8_000_000,
      maxBps: opts.maxBitrateBps ?? 40_000_000,
    });
    this.pacer = new Pacer({
      rateBps: this.cc.targetBps,
      send: (p) => {
        this.txBytes += p.length;
        this.txPackets++;
        this.intervalTxBytes += p.length;
        this.intervalTxPackets++;
        this.link.send(p);
      },
    });

    this.link.onMessage((data) => this.onPacket(data));
  }

  start(): void {
    this.pacer.start();
    this.sendPing();
    const repeat = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    repeat(REPORT_INTERVAL_MS, () => this.sendReport());
    repeat(NACK_INTERVAL_MS, () => this.sendNacks());
    repeat(PING_INTERVAL_MS, () => this.sendPing());
    repeat(STATS_INTERVAL_MS, () => this.emitStats());
    repeat(SWEEP_INTERVAL_MS, () => this.sweep());
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.pacer.stop();
    try {
      this.sendControl({ t: 'bye', reason });
    } catch {
      /* best effort */
    }
  }

  get stats(): SessionStats {
    return this.buildStats();
  }

  get rttUs(): number {
    return this.clock.rttUs;
  }

  get targetBps(): number {
    return this.cc.targetBps;
  }

  setMaxBitrate(bps: number): void {
    this.cc.setTarget(bps);
    this.pacer.setRate(this.cc.targetBps);
    this.lastTargetBps = this.cc.targetBps;
  }

  /** Lower the ceiling for the whole session (relay fallback), not just the target. */
  setMaxBudget(bps: number): void {
    this.cc.setMaxBudget(bps);
    this.pacer.setRate(this.cc.targetBps);
    this.lastTargetBps = this.cc.targetBps;
  }

  /** Drop queued media frames, e.g. after an encoder restart. */
  discardPendingMedia(): void {
    this.pacer.clearMedia();
  }

  requestKeyframe(): void {
    this.sendControl({ t: 'idr' });
  }

  sendHello(msg: Extract<ControlMessage, { t: 'hello' }>): void {
    this.sendControl(msg);
  }

  // ---------------------------------------------------------------- sending

  sendFrame(codec: number, flags: number, payload: Buffer, channel = Channel.Video): number {
    const frameId = this.txFrameId;
    const isKey = (flags & 0x01) !== 0;
    // Drop whole frames rather than fragments: a half-sent frame is wasted
    // bandwidth, and the receiver would report loss that the controller then
    // reacts to by shedding rate again.
    const estimate =
      payload.length + 2 * FRAME_HEADER_LEN + Math.ceil(payload.length / MAX_PAYLOAD) * (HEADER_LEN + AUTH_TAG_LEN);
    // Keep the queue large enough for this frame so its fragments cannot be
    // dropped by the latency budget mid-frame.
    this.pacer.setFrameSizeHint(estimate);
    if (!isKey && this.pacer.wouldOverflow(estimate)) {
      this.skippedFrames++;
      if (this.skippedFrames <= 3) {
        this.log('warn', 'frame skipped: queue budget exceeded', {
          estimate,
          queued: this.pacer.pendingBytes,
          budget: this.pacer.queueBudget,
          rate: this.pacer.rate,
        });
      }
      return -1;
    }
    this.txFrameId = (this.txFrameId + 1) & 0xffff;
    this.intervalTxFrames++;
    const { fragments } = fragmentFrame(frameId, codec, flags, BigInt(this.nowUs()), payload);

    for (const f of fragments) {
      const pktFlags = flags & 0x01 ? PacketFlags.Key : 0;
      this.sendPacket(channel, frameId, pktFlags, f.fragIdx, f.fragCnt, 0, f.data, 1);
      this.retx.set(`${channel}:${frameId}:${f.fragIdx}`, {
        channel,
        frameId,
        fragIdx: f.fragIdx,
        fragCnt: f.fragCnt,
        flags: pktFlags,
        payload: f.data,
        expiresAtMs: Date.now() + Math.max(200, (this.clock.rttUs / 1000) * 2),
      });
    }

    if (this.fecEnabled && fragments.length > 2) {
      const data = fragments.map((f) => f.data);
      // On a clean link the 12.5% minimum parity tax buys almost nothing —
      // NACK retransmission covers the rare loss — and the extra bytes feed
      // the very congestion that causes loss. Halve the floor until loss
      // actually shows up.
      const r = parityCountFor(fragments.length, this.cc.lossRate, this.cc.lossRate < 0.01 ? 0.06 : 0.125);
      const parities = buildParity(data, r);
      for (const p of parities) {
        this.sendPacket(
          channel,
          frameId,
          PacketFlags.FecParity | (flags & 0x01 ? PacketFlags.Key : 0),
          0xffff,
          fragments.length,
          p.parityIdx,
          p.data,
          1,
        );
      }
    }
    return frameId;
  }

  sendInput(event: InputEvent): void {
    const seq = this.txInputSeq = (this.txInputSeq + 1) & 0xffff;
    const json = Buffer.from(JSON.stringify(event), 'utf8');
    // 2-byte sequence prefix: redundant copies are deduplicated by the
    // receiver so a lost copy never double-applies a click or keystroke.
    const payload = Buffer.allocUnsafe(2 + json.length);
    payload.writeUInt16BE(seq, 0);
    json.copy(payload, 2);
    // Pointer moves are self-correcting — the next position supersedes a lost
    // one within a frame — so triplicating them only triples the packet rate
    // of a 60-125 Hz mouse for no benefit. Discrete events (clicks, keys,
    // wheel) keep the full redundancy because losing one loses the action.
    const copies = event.k === 'ma' || event.k === 'mm' ? 1 : 3;
    for (let i = 0; i < copies; i++) {
      if (this.closed) return;
      this.sendPacket(Channel.Input, 0, 0, i, copies, 0, payload, 0);
    }
  }

  sendControl(msg: ControlMessage): void {
    const payload = encodeControl(msg);
    if (payload.length > MAX_PAYLOAD - 8) {
      this.log('warn', 'control message too large, dropped', { type: msg.t, len: payload.length });
      return;
    }
    this.sendPacket(Channel.Control, 0, 0, 0, 1, 0, payload, 0);
  }

  private sendPacket(
    channel: number,
    frameId: number,
    flags: number,
    fragIdx: number,
    fragCnt: number,
    fecIdx: number,
    payload: Buffer,
    priority: 0 | 1,
  ): void {
    const size = HEADER_LEN + payload.length + AUTH_TAG_LEN;
    // Header (and therefore the send timestamp + AEAD nonce) is produced at the
    // instant the pacer releases the packet, so queueing inside the pacer never
    // masquerades as network congestion.
    const build = (): Buffer => {
      this.txSeq = (this.txSeq + 1) >>> 0;
      const header = encodeHeader({
        seq: this.txSeq,
        sendTsUs: this.nowUs() % 0x1_0000_0000,
        channel,
        frameId,
        flags,
        fragIdx,
        fragCnt,
        fecIdx,
      });
      const sealed = this.keys.tx.seal(this.txSeq, header, payload);
      return Buffer.concat([header, sealed], header.length + sealed.length);
    };
    const accepted = this.pacer.enqueue(build, size, priority);
    if (!accepted) this.txDropped++;
    else {
      if (channel === Channel.Control) this.intervalKinds.control++;
      else if (flags & PacketFlags.FecParity) this.intervalKinds.parity++;
      else if (flags & PacketFlags.Retransmit) this.intervalKinds.retx++;
      else this.intervalKinds.data++;
    }
    if (priority === 0) this.pacer.flushImmediately();
  }

  // -------------------------------------------------------------- receiving

  private onPacket(packet: Buffer): void {
    if (this.closed || packet.length <= HEADER_LEN) return;
    let header;
    try {
      header = decodeHeader(packet);
    } catch {
      return;
    }
    const aad = packet.subarray(0, HEADER_LEN);
    const payload = this.keys.rx.open(header.seq, aad, packet.subarray(HEADER_LEN));
    if (!payload) {
      this.authFailures++;
      return;
    }

    this.rxBytes += packet.length;
    this.rxPackets++;

    // Sliding-window reception bitmap. A monotonic high-water mark would count
    // every reordered packet as loss; the window excludes the newest few dozen
    // sequence numbers so reordering has time to settle.
    const slot = header.seq & (RX_WINDOW - 1);
    if (this.rxWindow[slot] !== 1 || this.rxWindowSeq[slot] !== header.seq) {
      this.rxWindowSeq[slot] = header.seq;
      this.rxWindow[slot] = 1;
    }
    const delta = this.rxHighest < 0 ? 0 : tsDelta32(header.seq, this.rxHighest);
    if (this.rxHighest < 0 || delta > 0) this.rxHighest = header.seq;
    if (this.rxBaseline < 0) this.rxBaseline = header.seq;

    const receiveUs = this.nowUs();
    const sendAbs = unwrapTs32(header.sendTsUs, receiveUs);
    this.gradient.add(receiveUs, sendAbs);
    this.jitter.add(receiveUs, sendAbs);

    switch (header.channel) {
      case Channel.Control:
        this.handleControl(payload, receiveUs);
        break;
      case Channel.Input: {
        if (payload.length < 3) break;
        const seq = payload.readUInt16BE(0);
        const delta = this.rxInputSeq < 0 ? 1 : ((seq - this.rxInputSeq) << 16) >> 16;
        if (delta <= 0) break; // duplicate or stale copy
        this.rxInputSeq = seq;
        const ev = decodeInput(payload.subarray(2));
        if (ev) this.opts.onInput?.(ev, receiveUs);
        break;
      }
      case Channel.Video:
      case Channel.Audio:
      case Channel.File:
        this.handleMedia(header, payload, receiveUs);
        break;
      default:
        break;
    }
  }

  private handleControl(payload: Buffer, receiveUs: number): void {
    const msg = decodeControl(payload);
    if (!msg) return;
    // Every control message proves the peer is alive, so the hooks see them all —
    // including pings, which the switch below answers and returns from.
    this.opts.onControl?.(msg, receiveUs);
    switch (msg.t) {
      case 'report':
        this.onReport(msg.report);
        return;
      case 'nack':
        this.onNack(msg.entries);
        return;
      case 'ping':
        this.sendControl({ t: 'pong', n: msg.n, t1: msg.t1, t2: receiveUs, t3: this.nowUs() });
        return;
      case 'pong':
        this.clock.addSample({ t1: msg.t1, t2: msg.t2, t3: msg.t3, t4: receiveUs });
        return;
      case 'bitrate':
        this.setMaxBitrate(msg.bps);
        break;
      case 'bye':
        this.closed = true;
        break;
      default:
        break;
    }
  }

  private handleMedia(
    header: ReturnType<typeof decodeHeader>,
    payload: Buffer,
    receiveUs: number,
  ): void {
    const { channel, frameId, flags, fragCnt, fecIdx } = header;
    const frameKey = (channel << 16) | frameId;

    if (this.completed.has(frameKey)) return;

    if (flags & PacketFlags.FecParity) {
      const key = (channel << 16) | frameId;
      let entry = this.parity.get(key);
      if (!entry) {
        entry = { fragCnt, parities: new Map(), r: 0, createdAtMs: Date.now() };
        this.parity.set(key, entry);
      }
      entry.parities.set(fecIdx, Buffer.from(payload));
      entry.r = Math.max(entry.r, fecIdx + 1);
      this.tryRecover(channel, frameId, receiveUs);
      return;
    }

    const completed = this.reassembler.push(channel, frameId, header.fragIdx, fragCnt, payload);
    if (completed) {
      this.emitFrame({
        channel,
        frameId,
        codec: completed.codec,
        flags: completed.flags,
        captureTsUs: completed.captureTsUs,
        payload: completed.payload,
        rxUs: receiveUs,
        oneWayUs: 0,
        recovered: false,
        missingFrags: 0,
        totalFrags: completed.totalFrags,
      });
      this.markComplete(frameKey);
      return;
    }
    this.tryRecover(channel, frameId, receiveUs);
  }

  private tryRecover(channel: number, frameId: number, receiveUs: number): void {
    const key = (channel << 16) | frameId;
    const entry = this.parity.get(key);
    if (!entry || entry.parities.size === 0) return;
    const parts = this.reassembler.fragBuffers(channel, frameId);
    if (!parts) return;

    const header = this.reassembler.header(channel, frameId);
    const lengthOf = (i: number): number => {
      if (!header) return MAX_PAYLOAD;
      const payloadLen = header.totalLen - FRAME_HEADER_LEN;
      if (header.fragCount === 1) return payloadLen;
      if (i === 0) return Math.min(MAX_PAYLOAD, FRAME_HEADER_LEN + payloadLen) - FRAME_HEADER_LEN;
      const firstPayload = Math.min(MAX_PAYLOAD, FRAME_HEADER_LEN + payloadLen) - FRAME_HEADER_LEN;
      const consumed = firstPayload + (i - 1) * MAX_PAYLOAD;
      return Math.max(0, Math.min(MAX_PAYLOAD, payloadLen - consumed));
    };

    const recovered = recoverMissing(parts, entry.parities, entry.r, (i) => lengthOf(i));
    if (recovered.size === 0) return;

    let completed = null;
    for (const [idx, raw] of recovered) {
      let data = raw;
      if (idx === 0 && data.length >= FRAME_HEADER_LEN) {
        // Recovered first fragment may be zero padded; trim using its own header.
        try {
          const h = decodeFrameHeader(data, 0);
          const payloadLen = h.totalLen - FRAME_HEADER_LEN;
          const firstPayload = Math.min(MAX_PAYLOAD, FRAME_HEADER_LEN + payloadLen) - FRAME_HEADER_LEN;
          data = data.subarray(0, FRAME_HEADER_LEN + firstPayload);
        } catch {
          /* keep as-is */
        }
      }
      const out = this.reassembler.push(channel, frameId, idx, entry.fragCnt, data);
      if (out) completed = out;
    }

    if (completed) {
      this.recoveredFrames++;
      this.emitFrame({
        channel,
        frameId,
        codec: completed.codec,
        flags: completed.flags,
        captureTsUs: completed.captureTsUs,
        payload: completed.payload,
        rxUs: receiveUs,
        oneWayUs: 0,
        recovered: true,
        missingFrags: 0,
        totalFrags: completed.totalFrags,
      });
      this.parity.delete(key);
      this.nackSentAt.delete(key);
      this.markComplete(key);
    }
  }

  /** Remember a finished frame so late retransmits cannot reassemble it again. */
  private markComplete(frameKey: number): void {
    this.completed.add(frameKey);
    this.parity.delete(frameKey);
    this.nackSentAt.delete(frameKey);
    if (this.completed.size > 512) {
      const first = this.completed.values().next();
      if (!first.done) this.completed.delete(first.value);
    }
  }

  private emitFrame(frame: IncomingFrame): void {
    this.framesReceived++;
    this.intervalFrames++;
    if (this.clock.synced) {
      const captureLocal = this.clock.toLocal(Number(frame.captureTsUs));
      if (captureLocal > 0) frame.oneWayUs = Math.max(0, frame.rxUs - captureLocal);
    }
    this.opts.onFrame?.(frame);
  }

  // ------------------------------------------------------------- feedback

  private onReport(r: ReceiverReport): void {
    if (r.received === 0 && r.lost === 0) return;
    const rttUs = Math.max(1, this.clock.rttUs || 30_000);
    this.cc.onSample({
      lossRate: r.lost / Math.max(1, r.lost + r.received),
      delayGradientUs: r.delayGradientUs,
      rttUs,
    });
    const target = this.cc.targetBps;
    if (Math.abs(target - this.pacer.rate) / Math.max(1, this.pacer.rate) > 0.03) {
      this.pacer.setRate(target);
      this.opts.onBitrateChange?.(target);
    }
  }

  private onNack(entries: NackEntry[]): void {
    const now = Date.now();
    let budget = Math.max(4, Math.ceil(entries.length * 2));
    for (const e of entries) {
      for (const fragIdx of e.frags) {
        if (budget-- <= 0) return;
        const entry = this.retx.get(`${e.channel}:${e.frameId}:${fragIdx}`);
        if (!entry || entry.expiresAtMs < now) continue;
        // Retransmissions are bulk data: they go through the pacer like any
        // other fragment. Letting them bypass it turns a brief queue into a
        // self-sustaining over-rate burst.
        this.sendPacket(
          entry.channel,
          entry.frameId,
          entry.flags | PacketFlags.Retransmit,
          entry.fragIdx,
          entry.fragCnt,
          0,
          entry.payload,
          1,
        );
      }
    }
  }

  /**
   * Loss measured over a sliding window that lags the highest seen sequence by
   * `RX_REORDER_SLACK` packets, so reordering is not mistaken for loss.
   */
  private measureLoss(): { lost: number; received: number; ratio: number } {
    if (this.rxHighest < 0) return { lost: 0, received: 0, ratio: 0 };
    const hi = this.rxHighest - RX_REORDER_SLACK;
    // Sequence numbers below the first packet received were never used, so they
    // must not be counted as loss.
    const lo = Math.max(this.rxBaseline, hi - RX_MEASURE_WINDOW + 1);
    let received = 0;
    let total = 0;
    for (let seq = lo; seq <= hi; seq++) {
      total++;
      const slot = seq & (RX_WINDOW - 1);
      if (this.rxWindow[slot] === 1 && this.rxWindowSeq[slot] === seq) received++;
    }
    if (total === 0) return { lost: 0, received: 0, ratio: 0 };
    const lost = total - received;
    return { lost, received, ratio: lost / total };
  }

  private sendReport(): void {
    const loss = this.measureLoss();
    this.lastLossPct = Math.min(100, loss.ratio * 100);
    const report: ReceiverReport = {
      hi: this.rxHighest < 0 ? 0 : this.rxHighest,
      lost: loss.lost,
      received: loss.received,
      delayGradientUs: Math.round(this.gradient.take()),
      jitterUs: Math.round(this.jitter.valueUs),
      nowUs: this.nowUs(),
    };
    this.sendControl({ t: 'report', report });
  }

  private sendNacks(): void {
    const now = Date.now();
    const entries: NackEntry[] = [];
    // A fragment may legitimately be waiting in the sender's pacer queue, so the
    // grace period must cover queueing delay, not just the network RTT. NACKing
    // too early makes the sender retransmit data that was already on its way,
    // which inflates the send rate and deepens the very queue that caused it.
    const queueDelayMs = (this.pacer.pendingBytes * 8) / Math.max(1, this.pacer.rate) * 1000;
    const graceMs = Math.max(30, this.clock.rttUs / 1000 + queueDelayMs * 0.5);
    for (const pending of this.reassembler.pendingFrames()) {
      const missing = this.reassembler.missing(pending.channel, pending.frameId);
      if (!missing || missing.length === 0) continue;
      const key = (pending.channel << 16) | pending.frameId;
      const last = this.nackSentAt.get(key) ?? 0;
      if (now - last < NACK_THROTTLE_MS) continue;
      if (now - pending.firstSeenMs < graceMs) continue;
      this.nackSentAt.set(key, now);
      entries.push({ channel: pending.channel, frameId: pending.frameId, frags: missing.slice(0, 8) });
      if (entries.length >= 8) break;
    }
    if (entries.length > 0) this.sendControl({ t: 'nack', entries });
  }

  private sendPing(): void {
    this.sendControl({ t: 'ping', n: (this.pingCounter = (this.pingCounter + 1) >>> 0), t1: this.nowUs() });
  }

  private pingCounter = 0;

  private sweep(): void {
    const now = Date.now();
    for (const ev of this.reassembler.sweep()) {
      this.droppedFrames++;
      this.parity.delete((ev.channel << 16) | ev.frameId);
      this.nackSentAt.delete((ev.channel << 16) | ev.frameId);
    }
    for (const [key, entry] of this.parity) {
      if (now - entry.createdAtMs > PARITY_TTL_MS) this.parity.delete(key);
    }
    for (const [key, entry] of this.retx) {
      if (entry.expiresAtMs < now) this.retx.delete(key);
    }
    if (this.parity.size > 64) this.parity.clear();
  }

  private emitStats(): void {
    if (!this.opts.onStats) {
      this.intervalFrames = 0;
      this.intervalTxFrames = 0;
      this.txBytes = 0;
      this.rxBytes = 0;
      return;
    }
    const stats = this.buildStats();
    stats.packetsPerSec = this.intervalTxPackets * (1000 / STATS_INTERVAL_MS);
    stats.avgPacketBytes = this.intervalTxPackets === 0 ? 0 : this.intervalTxBytes / this.intervalTxPackets;
    stats.breakdown = { ...this.intervalKinds };
    this.intervalKinds = { data: 0, parity: 0, control: 0, retx: 0 };
    this.intervalFrames = 0;
    this.intervalTxFrames = 0;
    this.intervalTxPackets = 0;
    this.intervalTxBytes = 0;
    this.txBytes = 0;
    this.rxBytes = 0;
    this.opts.onStats(stats);
  }

  private buildStats(): SessionStats {
    return {
      role: this.role,
      sessionId: this.sessionId,
      rttUs: Math.round(this.clock.rttUs),
      oneWayUs: Math.round(Math.max(0, this.clock.rttUs / 2)),
      lossPct: Number(this.lastLossPct.toFixed(2)),
      jitterUs: Math.round(this.jitter.valueUs),
      targetBps: this.cc.targetBps,
      pacerRateBps: Math.round(this.pacer.rate),
      sendBps: this.txBytes * (1000 / STATS_INTERVAL_MS) * 8,
      recvBps: this.rxBytes * (1000 / STATS_INTERVAL_MS) * 8,
      // The host is the producer of frames, so its meaningful rate is what it
      // encodes; the controller's is what it manages to decode.
      fps: (this.role === 'host' ? this.intervalTxFrames : this.intervalFrames) * (1000 / STATS_INTERVAL_MS),
      framesReceived: this.framesReceived,
      recoveredFrames: this.recoveredFrames,
      droppedFrames: this.droppedFrames,
      skippedFrames: this.skippedFrames,
      packetsSent: this.txPackets,
      packetsPerSec: 0,
      avgPacketBytes: 0,
      breakdown: { data: 0, parity: 0, control: 0, retx: 0 },
      packetsReceived: this.rxPackets,
      authFailures: this.authFailures,
      queueBytes: this.pacer.pendingBytes,
      pendingFrames: this.reassembler.size,
      clockSamples: this.clock.sampleCount,
      sas: this.sas,
    };
  }
}

