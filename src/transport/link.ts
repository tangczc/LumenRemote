import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createSocket, toCanonical, toMapped } from '../net/address.ts';

export interface Endpoint {
  address: string;
  port: number;
}

/**
 * Minimal datagram endpoint abstraction so the session can run over a real UDP
 * socket, a relay tunnel, or an in-process network simulator.
 */
export interface Link {
  readonly kind: string;
  send(packet: Buffer): void;
  onMessage(cb: (data: Buffer, from?: Endpoint) => void): void;
  close(): void;
}

export class UdpLink implements Link {
  readonly kind = 'udp';
  private handlers: ((data: Buffer, from?: Endpoint) => void)[] = [];
  private closed = false;
  private latch = false;
  private candidates: Endpoint[] = [];
  /**
   * Every source that has answered while candidates were being probed. Keeping
   * them lets the caller pick the best path by priority instead of blindly
   * keeping whichever datagram happened to arrive first.
   */
  private seen = new Map<string, Endpoint>();

  private constructor(
    private readonly socket: dgram.Socket,
    private remote: Endpoint | null,
    private readonly dualStack: boolean,
  ) {
    socket.on('message', (msg, rinfo) => {
      // A dual-stack socket reports IPv4 peers as ::ffff:a.b.c.d.
      const from = { address: toCanonical(rinfo.address), port: rinfo.port };
      if (this.latch) {
        const key = `${from.address}:${from.port}`;
        if (!this.seen.has(key)) this.seen.set(key, from);
        // Provisional: whichever comes first keeps the session alive, and the
        // path selector may later promote a higher-priority responder.
        if (!this.remote) this.remote = from;
        this.candidates = [];
      }
      for (const h of this.handlers) h(msg, from);
    });
    socket.on('error', () => {
      /* ICMP port unreachable surfaces here; ignore, the session retries */
    });
  }

  static bind(opts: { port?: number; host?: string; remote?: Endpoint } = {}): Promise<UdpLink> {
    // Dual stack unless the caller pinned an IPv4 host (tests, loopback pairing).
    const dualStack = !opts.host || opts.host.includes(':');
    const socket = createSocket(dualStack);
    const bindHost = opts.host ?? (dualStack ? '::' : '0.0.0.0');
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        socket.close();
        // A host without IPv6 support should fall back rather than refuse to run.
        if (dualStack) {
          UdpLink.bind({ ...opts, host: '0.0.0.0' }).then(resolve, reject);
          return;
        }
        reject(err);
      };
      socket.once('error', onError);
      socket.bind(opts.port ?? 0, bindHost, () => {
        socket.off('error', onError);
        // The OS default (64 KB on Windows) is smaller than a single 4K
        // keyframe, so a paced burst overflows it and looks like random loss
        // that the congestion controller then reacts to.
        try {
          socket.setRecvBufferSize(4 * 1024 * 1024);
          socket.setSendBufferSize(1024 * 1024);
        } catch {
          /* the platform refused the size; the default still works */
        }
        resolve(new UdpLink(socket, opts.remote ?? null, dualStack));
      });
    });
  }

  get isDualStack(): boolean {
    return this.dualStack;
  }

  setRemote(remote: Endpoint | null): void {
    this.remote = remote;
    if (remote) this.candidates = [];
  }

  /**
   * Fan every outgoing datagram out to all of these endpoints until a reply
   * arrives. Both peers opening all of their pinholes in the same instant is
   * what makes a symmetric-NAT punch succeed; probing candidates one at a time
   * gives the peer's binding time to expire before its turn comes.
   */
  setCandidates(endpoints: Endpoint[]): void {
    this.candidates = endpoints.filter((e) => e.port > 0);
    this.remote = null;
    this.seen.clear();
  }

  /** True once an inbound datagram has selected the real peer address. */
  get latched(): boolean {
    return this.remote !== null && this.candidates.length === 0;
  }

  /** All sources that answered since the last candidate reset. */
  seenSources(): Endpoint[] {
    return [...this.seen.values()];
  }

  /** Forget recorded responders before a new probe round. */
  resetSeen(): void {
    this.seen.clear();
  }

  /**
   * Adopt the source address of the first inbound datagram as the send target.
   * This completes NAT hole punching without an explicit probe handshake.
   */
  setLatch(enabled: boolean): void {
    this.latch = enabled;
  }

  /** Raw socket, needed for STUN-style endpoint discovery. */
  get raw(): dgram.Socket {
    return this.socket;
  }

  get remoteEndpoint(): Endpoint | null {
    return this.remote;
  }

  get address(): Endpoint | null {
    try {
      const a = this.socket.address();
      return typeof a === 'object' ? { address: a.address, port: a.port } : null;
    } catch {
      return null;
    }
  }

  send(packet: Buffer): void {
    if (this.closed) return;
    try {
      const targets = this.remote ? [this.remote] : this.candidates;
      for (const t of targets) {
        this.socket.send(packet, t.port, this.dualStack ? toMapped(t.address) : t.address);
      }
    } catch {
      /* best effort: a failed datagram is indistinguishable from loss */
    }
  }

  onMessage(cb: (data: Buffer, from?: Endpoint) => void): void {
    this.handlers.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

export interface SimConfig {
  /** Base one-way delay in ms. */
  delayMs: number;
  /** Uniform jitter added to each packet, in ms. */
  jitterMs: number;
  /** Percentage of packets dropped, 0-100. */
  lossPct: number;
  /** Percentage of packets delivered out of order, 0-100. */
  reorderPct: number;
  /** Optional shaping rate in kbit/s. */
  bandwidthKbps?: number;
}

export const PERFECT_LINK: SimConfig = { delayMs: 0, jitterMs: 0, lossPct: 0, reorderPct: 0 };

/**
 * In-process network simulator with a precise delivery wheel.
 *
 * `setTimeout` quantises to ~15 ms on Windows, which would make a 10 ms link
 * measurement meaningless. Delivery is therefore driven by `setImmediate` while
 * packets are in flight, falling back to a coarse timer when the next deadline
 * is far away.
 */
export class SimulatedLink implements Link {
  readonly kind = 'sim';
  private handlers: ((data: Buffer, from?: Endpoint) => void)[] = [];
  private peer: SimulatedLink | null = null;
  private pending: { due: number; payload: Buffer }[] = [];
  private pumping = false;
  private tokens = 0;
  private lastRefill = Date.now();
  private closed = false;
  private wheel: NodeJS.Immediate | NodeJS.Timeout | null = null;
  stats = { sent: 0, dropped: 0, delivered: 0, bytes: 0 };

  constructor(
    public config: SimConfig,
    public readonly name = 'sim',
    private readonly rng: () => number = Math.random,
  ) {}

  static pair(a: SimConfig, b: SimConfig = a): { a: SimulatedLink; b: SimulatedLink } {
    const left = new SimulatedLink(a, 'sim-a');
    const right = new SimulatedLink(b, 'sim-b');
    left.peer = right;
    right.peer = left;
    return { a: left, b: right };
  }

  onMessage(cb: (data: Buffer, from?: Endpoint) => void): void {
    this.handlers.push(cb);
  }

  send(packet: Buffer): void {
    if (this.closed || !this.peer) return;
    this.stats.sent++;
    this.stats.bytes += packet.length;

    if (this.config.lossPct > 0 && this.rng() * 100 < this.config.lossPct) {
      this.stats.dropped++;
      return;
    }

    let delayMs = this.config.delayMs;
    if (this.config.jitterMs > 0) delayMs += (this.rng() * 2 - 1) * this.config.jitterMs;

    const kbps = this.config.bandwidthKbps;
    if (kbps !== undefined && kbps > 0) {
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      this.lastRefill = now;
      this.tokens = Math.min(64_000, this.tokens + (elapsed * kbps * 1000) / 8 / 1000);
      if (this.tokens < packet.length) {
        this.stats.dropped++;
        return;
      }
      this.tokens -= packet.length;
    }

    if (this.config.reorderPct > 0 && this.rng() * 100 < this.config.reorderPct) {
      delayMs += 5 + this.rng() * 25;
    }

    this.pending.push({ due: performanceNow() + Math.max(0, delayMs), payload: Buffer.from(packet) });
    this.schedule();
  }

  private schedule(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    this.wheel = setImmediate(() => {
      this.pumping = false;
      const now = performanceNow();
      const ready: Buffer[] = [];
      const remaining: { due: number; payload: Buffer }[] = [];
      for (const item of this.pending) {
        if (item.due <= now) ready.push(item.payload);
        else remaining.push(item);
      }
      this.pending = remaining;
      for (const payload of ready) {
        this.stats.delivered++;
        for (const h of this.peer!.handlers) h(payload);
      }
      if (this.pending.length > 0) this.schedule();
    });
    this.wheel.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.wheel) clearImmediate(this.wheel as NodeJS.Immediate);
    this.pending = [];
  }
}

function performanceNow(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

export class EventedLink implements Link {
  readonly kind = 'evented';
  private handlers: ((data: Buffer, from?: Endpoint) => void)[] = [];
  readonly bus = new EventEmitter();

  send(packet: Buffer): void {
    this.bus.emit('packet', packet);
  }

  onMessage(cb: (data: Buffer, from?: Endpoint) => void): void {
    this.handlers.push(cb);
  }

  deliver(packet: Buffer): void {
    for (const h of this.handlers) h(packet);
  }

  close(): void {
    this.bus.removeAllListeners();
    this.handlers.length = 0;
  }
}
