export interface CcOptions {
  initialBps?: number;
  minBps?: number;
  maxBps?: number;
  nowMs?: () => number;
}

export interface CongestionSample {
  /** Loss ratio in the reporting interval, 0..1 */
  lossRate: number;
  /** Inter-arrival delay gradient in µs; positive means a queue is building */
  delayGradientUs: number;
  /** Smoothed RTT in µs */
  rttUs: number;
}

/**
 * Dual-signal congestion controller.
 *
 * Delay gradient catches queue build-up before loss occurs (essential on
 * cellular and Wi-Fi), loss catches the cases delay cannot see (route change,
 * policer). Multiplicative decrease on either signal, additive increase only
 * after a quiet period, so we ramp back without oscillating.
 */
export class CongestionController {
  private target: number;
  private readonly minBps: number;
  private maxBps: number;
  private readonly now: () => number;

  private trendUs = 0;
  private lastDecreaseMs = -1e9;
  private lastIncreaseMs = -1e9;
  private lastReportMs = -1e9;
  private hasReport = false;
  private consecutiveClean = 0;
  private overuseStreak = 0;
  private growStreak = 0;

  /** Smoothed RTT in µs. */
  srttUs = 0;
  /** Last observed loss ratio. */
  lossRate = 0;
  /** 'increase' | 'hold' | 'decrease' */
  state: 'increase' | 'hold' | 'decrease' = 'hold';

  constructor(opts: CcOptions = {}) {
    this.target = opts.initialBps ?? 8_000_000;
    this.minBps = opts.minBps ?? 400_000;
    this.maxBps = opts.maxBps ?? 60_000_000;
    this.now = opts.nowMs ?? (() => Date.now());
  }

  get targetBps(): number {
    return Math.round(this.target);
  }

  get queueingUs(): number {
    return this.trendUs;
  }

  onSample(s: CongestionSample): void {
    const now = this.now();
    const sinceReport = now - this.lastReportMs;
    this.lastReportMs = now;

    // Smooth the loss signal: reports arrive every 20 ms, so a single lost
    // packet in a quiet interval reads as 5-30% loss and used to slam the
    // rate down by 25% every 200 ms. The EWMA keeps real loss bursts
    // decisive while ignoring one-packet noise.
    this.lossRate = this.hasReport ? this.lossRate * 0.6 + s.lossRate * 0.4 : s.lossRate;
    this.srttUs = this.srttUs === 0 ? s.rttUs : this.srttUs * 0.9 + s.rttUs * 0.1;

    // Only accumulate gradient when reports actually arrive in sequence.
    if (!this.hasReport || (sinceReport > 0 && sinceReport < 500)) {
      const alpha = 0.15;
      this.trendUs = this.trendUs * (1 - alpha) + s.delayGradientUs * alpha;
    }
    this.hasReport = true;

    // delayGradientUs is now the TOTAL queue growth over one report
    // interval (~20 ms), so the thresholds are on that scale: a queue
    // growing >6 ms per interval is being fed far beyond capacity, while
    // >1.2 ms per interval sustained still means the queue grows without
    // bound, just slower.
    const overusing = this.trendUs > 6_000;
    const queueGrowing = this.trendUs > 1_200;
    const lossy = this.lossRate > 0.05;
    const mildlyLossy = this.lossRate > 0.02;

    if (overusing || lossy) {
      this.overuseStreak = overusing ? this.overuseStreak + 1 : 0;
      const sustained = lossy || this.overuseStreak >= 3;
      if (sustained && now - this.lastDecreaseMs > 200) {
        const factor = lossy ? 0.75 : 0.9;
        this.target = Math.max(this.minBps, this.target * factor);
        this.lastDecreaseMs = now;
        this.consecutiveClean = 0;
        this.state = 'decrease';
      }
      return;
    }

    this.overuseStreak = 0;

    // A queue that keeps growing slowly is still growing: back off gently
    // after ~300 ms of it instead of increasing into it forever.
    this.growStreak = queueGrowing ? this.growStreak + 1 : 0;
    if (this.growStreak >= 15 && now - this.lastDecreaseMs > 200) {
      this.target = Math.max(this.minBps, this.target * 0.9);
      this.lastDecreaseMs = now;
      this.growStreak = 0;
      this.consecutiveClean = 0;
      this.state = 'decrease';
      return;
    }

    if (mildlyLossy) {
      this.state = 'hold';
      this.consecutiveClean = 0;
      return;
    }

    // Do not add rate while any measurable queue is building; a rising trend
    // means the link is already at its limit even before it crosses the
    // overuse threshold.
    this.consecutiveClean = queueGrowing ? 0 : this.consecutiveClean + 1;

    if (!queueGrowing && this.consecutiveClean >= 2 && now - this.lastDecreaseMs > 300 && now - this.lastIncreaseMs > 120) {
      // Ramp eagerly after a quiet period: starting conservative and crawling
      // back up keeps interactive latency high for seconds.
      this.target = Math.min(this.maxBps, this.target * 1.25 + 48_000);
      this.lastIncreaseMs = now;
      this.state = 'increase';
    } else {
      this.state = 'hold';
    }
  }

  /** Force a target (used by the user-facing quality selector). */
  setTarget(bps: number): void {
    this.target = Math.min(this.maxBps, Math.max(this.minBps, bps));
  }

  /**
   * Change the ceiling itself, not just the current target. A session that fell
   * back to the relay must not be allowed to ramp back up to the LAN budget just
   * because the path looks clean.
   */
  setMaxBudget(bps: number): void {
    this.maxBps = Math.max(this.minBps, bps);
    if (this.target > this.maxBps) this.target = this.maxBps;
  }

  get bounds(): { min: number; max: number } {
    return { min: this.minBps, max: this.maxBps };
  }
}

/**
 * Sender-side receiver report processing helpers.
 *
 * The receiver reports an inter-arrival delay gradient; the sender turns it into
 * a queue estimate using its own send cadence. These helpers keep the maths in
 * one place so the session stays readable.
 */
export class DelayGradientEstimator {
  private prevArrivalUs = 0;
  private prevSendTsUs = 0;
  private accumulatedUs = 0;
  private samples = 0;

  add(arrivalUs: number, sendTsUs: number): void {
    if (this.prevArrivalUs === 0) {
      this.prevArrivalUs = arrivalUs;
      this.prevSendTsUs = sendTsUs;
      return;
    }
    const arrivalDelta = arrivalUs - this.prevArrivalUs;
    const sendDelta = sendTsUs - this.prevSendTsUs;
    this.prevArrivalUs = arrivalUs;
    this.prevSendTsUs = sendTsUs;
    if (arrivalDelta === 0 && sendDelta === 0) return;
    // Signed accumulation: reordering produces negative deltas that cancel out
    // against the corresponding positive ones. Discarding them would bias the
    // estimate upwards and make a healthy link look congested.
    this.accumulatedUs += arrivalDelta - sendDelta;
    this.samples++;
  }

  /**
   * Total queue growth in µs over the interval, then reset.
   *
   * This used to return the per-packet MEAN drift (accumulated / samples).
   * That was a units bug with fatal consequences: on a real link the mean
   * drift is tens of microseconds per packet, while the congestion
   * controller's thresholds are milliseconds of queue growth — so the
   * delay signal could never fire, and under router bufferbloat (deep
   * queues, ~0% loss) the sender never backed off at all. The link filled
   * with seconds of stale video and P2P felt unusable while the loss
   * signal still reported a healthy path. The accumulated sum telescopes
   * to (lastArrival - firstArrival) - (lastSend - firstSend), i.e. how
   * much the queue actually grew during the report interval.
   */
  take(): number {
    const v = this.accumulatedUs;
    this.accumulatedUs = 0;
    this.samples = 0;
    return v;
  }

  reset(): void {
    this.prevArrivalUs = 0;
    this.prevSendTsUs = 0;
    this.accumulatedUs = 0;
    this.samples = 0;
  }
}

/** RFC3550-style jitter estimator. */
export class JitterEstimator {
  private jitterUs = 0;
  private lastTransitUs = 0;

  add(arrivalUs: number, sendTsUs: number): void {
    const transit = arrivalUs - sendTsUs;
    if (this.lastTransitUs !== 0) {
      const d = Math.abs(transit - this.lastTransitUs);
      this.jitterUs += (d - this.jitterUs) / 16;
    }
    this.lastTransitUs = transit;
  }

  get valueUs(): number {
    return this.jitterUs;
  }
}
