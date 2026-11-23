export interface PacerOptions {
  /** Target send rate in bits per second. */
  rateBps: number;
  /** Scheduler granularity in ms. */
  tickMs?: number;
  /** Queue budget expressed as a latency budget; media beyond this is dropped. */
  maxQueueMs?: number;
  /**
   * How much transmission time the queue may hold. Larger than `maxQueueMs`
   * because a keyframe plus the P-frames that pile up behind it must fit, or
   * the pacer sheds frames the encoder thinks it sent.
   */
  burstMs?: number;
  /** Hard cap on queued bytes. */
  maxQueueBytes?: number;
  /** Injected clock, useful for deterministic tests. */
  nowMs?: () => number;
  send: (packet: Buffer, size: number) => void;
}

interface QueuedPacket {
  build: () => Buffer;
  size: number;
}

const HIGH = 0;
const LOW = 1;

/**
 * Token-bucket pacer with two priorities.
 *
 * Packets are queued as builders so the timestamp and AEAD nonce are produced at
 * the moment of transmission. Stamping at enqueue time would make the pacer's
 * own queue look like network queueing to the delay-gradient controller, which
 * then sheds rate for a queue it created itself.
 *
 * Media beyond the latency budget is dropped rather than delayed: for
 * interactive video, late frames are worthless.
 */
export class Pacer {
  private queues: QueuedPacket[][] = [[], []];
  private queueHead: [number, number] = [0, 0];
  private tokens = 0;
  private lastTickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private rateBps: number;
  private queuedBytes = 0;
  private droppedBytes = 0;
  private minQueueBytes = 0;
  private readonly tickMs: number;
  private readonly maxQueueMs: number;
  private readonly burstMs: number;
  private readonly maxQueueBytes: number;
  private readonly now: () => number;

  constructor(private readonly opts: PacerOptions) {
    this.rateBps = opts.rateBps;
    this.tickMs = opts.tickMs ?? 2;
    this.maxQueueMs = opts.maxQueueMs ?? 70;
    this.burstMs = opts.burstMs ?? 200;
    this.maxQueueBytes = opts.maxQueueBytes ?? 4_000_000;
    this.now = opts.nowMs ?? (() => Date.now());
    this.lastTickMs = this.now();
    this.tokens = opts.rateBps / 8 / 200;
  }

  start(): void {
    if (this.timer) return;
    const loop = () => {
      if (!this.timer) return;
      this.tick();
      this.timer = setTimeout(loop, this.tickMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setRate(rateBps: number): void {
    this.rateBps = Math.max(8_000, rateBps);
  }

  get rate(): number {
    return this.rateBps;
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }

  get droppedTotal(): number {
    return this.droppedBytes;
  }

  private get queueBudgetBytes(): number {
    // A single frame must always fit, otherwise its own fragments would be
    // dropped by the budget and the frame could never be transmitted.
    return Math.max(
      this.minQueueBytes,
      Math.min(this.maxQueueBytes, Math.max(4_000, (this.rateBps / 8) * (this.burstMs / 1000))),
    );
  }

  /**
   * Tell the pacer how large the biggest expected frame is. Called per frame by
   * the session so keyframes are never larger than the queue budget.
   */
  setFrameSizeHint(bytes: number): void {
    this.minQueueBytes = Math.max(0, Math.ceil(bytes * 1.1));
  }

  /** Current queue budget in bytes (exposed for diagnostics). */
  get queueBudget(): number {
    return this.queueBudgetBytes;
  }

  /** True when the queue already holds more than 60% of its latency budget. */
  get congested(): boolean {
    const latencyBudget = (this.rateBps / 8) * (this.maxQueueMs / 1000);
    return this.queuedBytes > latencyBudget * 0.6;
  }

  /**
   * Drop queued media packets. Used when the encoder restarts: those frames
   * belong to a reference chain the new keyframe is about to invalidate, so
   * sending them only delays the picture that actually matters.
   */
  clearMedia(): void {
    const q = this.queues[LOW]!;
    for (let i = this.queueHead[LOW]!; i < q.length; i++) this.queuedBytes -= q[i]!.size;
    q.length = 0;
    this.queueHead[LOW] = 0;
  }

  /** Would this many bytes overflow the queue budget? */
  wouldOverflow(size: number): boolean {
    return this.queuedBytes + size > this.queueBudgetBytes;
  }

  /** @param priority 0 = control/input, 1 = media */
  enqueue(build: () => Buffer, size: number, priority: 0 | 1 = LOW): boolean {
    if (priority === LOW && this.queuedBytes + size > this.queueBudgetBytes) {
      this.droppedBytes += size;
      return false;
    }
    this.queues[priority]!.push({ build, size });
    this.queuedBytes += size;
    // Windows timers quantise to ~15 ms, which is far too coarse for a 2 ms
    // pacing cadence. Draining synchronously on enqueue keeps interactive
    // traffic immediate; the timer only matters once the queue is saturated.
    this.pump();
    return true;
  }

  /** Send high-priority traffic immediately, bypassing the token bucket. */
  flushImmediately(): void {
    const q = this.queues[HIGH]!;
    while (this.queueHead[HIGH]! < q.length) {
      const item = q[this.queueHead[HIGH]!++]!;
      this.queuedBytes -= item.size;
      this.emit(item);
    }
    if (this.queueHead[HIGH] === q.length) {
      q.length = 0;
      this.queueHead[HIGH] = 0;
    }
  }

  private emit(item: QueuedPacket): void {
    const packet = item.build();
    this.opts.send(packet, packet.length);
  }

  /** Refill tokens from the elapsed time and drain as much as possible. */
  private pump(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastTickMs);
    this.lastTickMs = now;
    if (elapsed > 0) this.tokens += (this.rateBps / 8) * (elapsed / 1000);
    this.tokens = Math.min(this.tokens, (this.rateBps / 8) * 0.02);

    for (let prio = 0 as 0 | 1; prio <= 1; prio++) {
      const q = this.queues[prio]!;
      let head = this.queueHead[prio]!;
      while (head < q.length) {
        const item = q[head]!;
        if (this.tokens < item.size) break;
        this.tokens -= item.size;
        this.queuedBytes -= item.size;
        this.emit(item);
        head++;
      }
      this.queueHead[prio] = head;
      if (head === q.length) {
        q.length = 0;
        this.queueHead[prio] = 0;
      } else if (head > 256) {
        q.splice(0, head);
        this.queueHead[prio] = 0;
      }
      if (prio === 0 && head < q.length) break;
    }
  }

  private tick(): void {
    this.pump();
  }
}
