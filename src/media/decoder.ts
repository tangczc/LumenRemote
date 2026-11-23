import { spawn, type ChildProcess } from 'node:child_process';

export interface DecoderOptions {
  ffplayPath?: string;
  title?: string;
  /** 0 disables vsync in ffplay (lowest latency, may tear). */
  sync?: 'audio' | 'video' | 'ext' | 'none';
  onLog?: (line: string) => void;
  onExit?: (code: number | null) => void;
}

/**
 * Headless-friendly playback of a raw H.264 Annex-B stream through ffplay.
 * The browser UI uses WebCodecs instead; this path is for `--display ffplay`
 * and for machines without a Chromium-based browser.
 */
export class StreamDecoder {
  private proc: ChildProcess | null = null;

  constructor(private readonly opts: DecoderOptions = {}) {}

  start(): void {
    const ffplay = this.opts.ffplayPath ?? 'ffplay';
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-framedrop',
      '-probesize',
      '32',
      '-analyzeduration',
      '0',
      '-sync',
      this.opts.sync ?? 'video',
      '-window_title',
      this.opts.title ?? 'Remote Desktop',
      '-f',
      'h264',
      '-i',
      'pipe:0',
    ];
    const proc = spawn(ffplay, args, { windowsHide: false, stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    proc.stderr?.on('data', (c: Buffer) => this.opts.onLog?.(c.toString('utf8').trimEnd()));
    proc.on('exit', (code) => this.opts.onExit?.(code));
    proc.on('error', (err) => {
      this.opts.onLog?.(`ffplay spawn failed: ${err.message}`);
      this.opts.onExit?.(-1);
    });
  }

  /** Push one Annex-B access unit. */
  write(payload: Buffer): void {
    if (!this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(payload);
    } catch {
      /* decoder went away */
    }
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.stdin?.end();
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}
