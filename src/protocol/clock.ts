import { performance } from 'node:perf_hooks';

/** Monotonic microsecond clock for the local process (immune to wall clock jumps). */
export function monotonicUs(): number {
  return Math.round(performance.now() * 1000);
}

/** Monotonic millisecond clock. */
export function monotonicMs(): number {
  return Math.round(performance.now());
}

export interface ClockSample {
  /** local send time (µs) */
  t1: number;
  /** peer receive time (µs, peer clock) */
  t2: number;
  /** peer reply time (µs, peer clock) */
  t3: number;
  /** local receive time (µs) */
  t4: number;
}

/**
 * NTP-style offset estimation with a minimum-RTT filter.
 *
 * `offsetUs` is added to a local monotonic timestamp to obtain the peer's
 * monotonic timestamp. Using the min-RTT sample removes the queueing bias that
 * would otherwise inflate the offset whenever the link is congested.
 */
export class ClockSync {
  private samples: ClockSample[] = [];

  constructor(private readonly window = 16) {}

  addSample(s: ClockSample): void {
    if (s.t4 < s.t1) return;
    this.samples.push(s);
    if (this.samples.length > this.window) this.samples.shift();
  }

  clear(): void {
    this.samples.length = 0;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  get rttUs(): number {
    const best = this.best();
    return best ? best.t4 - best.t1 - (best.t3 - best.t2) : 0;
  }

  get offsetUs(): number {
    const best = this.best();
    if (!best) return 0;
    return (best.t2 - best.t1 + (best.t3 - best.t4)) / 2;
  }

  get synced(): boolean {
    return this.samples.length >= 3;
  }

  /** Convert a local monotonic timestamp into the peer clock domain. */
  toPeer(localUs: number): number {
    return localUs + this.offsetUs;
  }

  /** Convert a peer timestamp into the local monotonic domain. */
  toLocal(peerUs: number): number {
    return peerUs - this.offsetUs;
  }

  /** One-way delay estimate for a peer timestamp arriving now. */
  oneWayDelayUs(peerUs: number, localNowUs = monotonicUs()): number {
    return this.toLocal(peerUs) > 0 ? localNowUs - this.toLocal(peerUs) : 0;
  }

  private best(): ClockSample | null {
    let best: ClockSample | null = null;
    let bestRtt = Infinity;
    for (const s of this.samples) {
      const rtt = s.t4 - s.t1 - (s.t3 - s.t2);
      if (rtt >= 0 && rtt < bestRtt) {
        bestRtt = rtt;
        best = s;
      }
    }
    return best;
  }
}
