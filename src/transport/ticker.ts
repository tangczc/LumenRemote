/**
 * High-resolution ticker.
 *
 * `setInterval` cannot be trusted below ~15 ms on Windows, so timing-sensitive
 * senders (benchmarks, synthetic sources, future audio clocking) drive their
 * schedule from `setImmediate` plus a monotonic clock and catch up on missed
 * slots instead of drifting.
 */
export class HighResTicker {
  private handle: NodeJS.Immediate | null = null;
  private startNs = 0n;
  private nextIndex = 0;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly count: number,
    private readonly onTick: (index: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextIndex = 0;
    this.startNs = process.hrtime.bigint();
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.handle) clearImmediate(this.handle);
    this.handle = null;
  }

  get ticked(): number {
    return this.nextIndex;
  }

  private loop = (): void => {
    if (!this.running) return;
    const elapsedMs = Number(process.hrtime.bigint() - this.startNs) / 1e6;
    const due = Math.floor(elapsedMs / this.intervalMs) + 1;
    while (this.nextIndex < due && this.nextIndex < this.count) {
      const index = this.nextIndex;
      this.nextIndex++;
      this.onTick(index);
    }
    if (this.nextIndex >= this.count) {
      this.running = false;
      return;
    }
    this.handle = setImmediate(this.loop);
  };
}
