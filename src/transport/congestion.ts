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

    this.lossRate = s.lossRate;
    this.srttUs = this.srttUs === 0 ? s.rttUs : this.srttUs * 0.9 + s.rttUs * 0.1;

    // Only accumulate gradient when reports actually arrive in sequence.
    if (!this.hasReport || (sinceReport > 0 && sinceReport < 500)) {
      const alpha = 0.15;
      this.trendUs = this.trendUs * (1 - alpha) + s.delayGradientUs * alpha;
    }
    this.hasReport = true;

    const overusing = this.trendUs > 20_000; // ~20 ms of standing queue
    const lossy = s.lossRate > 0.05;
    const mildlyLossy = s.lossRate > 0.02;

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

    if (mildlyLossy) {
      this.state = 'hold';
      this.consecutiveClean = 0;
      return;
    }

    // Do not add rate while any measurable queue is building; a rising trend
    // means the link is already at its limit even before it crosses the
    // overuse threshold.
    const queueGrowing = this.trendUs > 5_000;
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

  /** Average queue growth in µs over the interval, then reset. */
  take(): number {
    const v = this.samples === 0 ? 0 : this.accumulatedUs / this.samples;
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
