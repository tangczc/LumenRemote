import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { AccessUnitAssembler, type AccessUnit } from './nal.ts';

export type EncoderName = 'libx264' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf';

export interface ScreenSource {
  kind: 'screen';
  /**
   * `dda` = Desktop Duplication via FFmpeg's ddagrab filter: GPU frames go
   * straight to the encoder with no CPU copy. `gdi` = the older GDI grabber,
   * kept as a fallback for machines where ddagrab is unavailable.
   */
  mode?: 'dda' | 'gdi' | 'auto';
}

export interface EncoderOptions {
  /** Capture source. */
  source: ScreenSource | { kind: 'test'; size?: string };
  fps?: number;
  bitrateKbps?: number;
  encoder?: EncoderName | 'auto';
  ffmpegPath?: string;
  gopFrames?: number;
  /**
   * Encode at this size instead of the capture size. Omit to keep the native
   * frame, which is both the cheapest and the sharpest option.
   */
  targetSize?: { width: number; height: number };
  onAccessUnit: (au: AccessUnit) => void;
  onLog?: (line: string) => void;
  onExit?: (code: number | null) => void;
}

let cachedEncoders: Set<string> | null = null;

function availableEncoders(ffmpegPath: string): Set<string> {
  if (cachedEncoders) return cachedEncoders;
  try {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000 });
    const text = `${r.stdout ?? ''}`;
    const set = new Set<string>();
    for (const name of ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf']) {
      if (text.includes(` ${name} `)) set.add(name);
    }
    cachedEncoders = set;
    return set;
  } catch {
    cachedEncoders = new Set(['libx264']);
    return cachedEncoders;
  }
}

export function resolveEncoder(name: EncoderName | 'auto', ffmpegPath = 'ffmpeg'): EncoderName {
  if (name !== 'auto') return name;
  const available = availableEncoders(ffmpegPath);
  for (const candidate of ['h264_nvenc', 'h264_qsv', 'h264_amf'] as EncoderName[]) {
    if (available.has(candidate)) return candidate;
  }
  return 'libx264';
}

/** True when this build of FFmpeg can capture through Desktop Duplication. */
let ddaAvailable: boolean | null = null;

export function supportsDda(ffmpegPath = 'ffmpeg'): boolean {
  if (ddaAvailable !== null) return ddaAvailable;
  try {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 8000 });
    ddaAvailable = `${r.stdout ?? ''}`.includes('ddagrab');
  } catch {
    ddaAvailable = false;
  }
  return ddaAvailable;
}

export function resolveCaptureMode(opts: EncoderOptions, ffmpegPath = 'ffmpeg'): 'dda' | 'gdi' {
  if (opts.source.kind !== 'screen') return 'gdi';
  const mode = opts.source.mode ?? 'auto';
  if (mode === 'gdi') return 'gdi';
  // ddagrab needs a hardware encoder to stay on the GPU; software x264 would
  // have to download the frames anyway, so the older path is no worse there.
  if (resolveEncoder(opts.encoder ?? 'auto', ffmpegPath) !== 'h264_nvenc') return 'gdi';
  return supportsDda(ffmpegPath) ? 'dda' : 'gdi';
}

export function buildEncoderArgs(opts: EncoderOptions): string[] {
  const fps = opts.fps ?? 60;
  const kbps = opts.bitrateKbps ?? 12_000;
  const gop = opts.gopFrames ?? Math.max(60, Math.round(fps * 2));
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const encoder = resolveEncoder(opts.encoder ?? 'auto', ffmpegPath);
  const captureMode = resolveCaptureMode(opts, ffmpegPath);

  const target = opts.targetSize;
  const scaleFilter = target ? `scale=${target.width}:${target.height}:flags=fast_bilinear` : '';

  // ddagrab hands the encoder D3D11 surfaces, which no scaler can consume, so a
  // resize has to round-trip through system memory. That costs one core at
  // 4K->1440p, which is why the native size is kept whenever it already fits.
  const ddaChain = scaleFilter
    ? `ddagrab=framerate=${fps},hwdownload,format=bgra,${scaleFilter},format=nv12`
    : `ddagrab=framerate=${fps}`;

  const input =
    opts.source.kind === 'screen'
      ? captureMode === 'dda'
        ? // No `-pix_fmt` here: the frames stay as GPU surfaces (NV12) the whole way.
          ['-filter_complex', ddaChain]
        : [
            '-f',
            'gdigrab',
            '-framerate',
            String(fps),
            '-draw_mouse',
            '1',
            '-i',
            'desktop',
            ...(scaleFilter ? ['-vf', scaleFilter] : []),
          ]
      : ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${opts.source.size ?? '1280x720'}:rate=${fps}`];

  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${Math.max(64, Math.round(kbps / 4))}k`, '-g', String(gop), '-bf', '0'];
  const common = captureMode === 'dda' ? rate : ['-pix_fmt', 'yuv420p', ...rate];

  const codecArgs: Record<EncoderName, string[]> = {
    libx264: [
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-profile:v',
      'high',
      '-x264-params',
      ['bframes=0', 'rc-lookahead=0', 'sync-lookahead=0', 'scenecut=0', 'sliced-threads=1', 'repeat-headers=1', 'aud=0', 'force-cfr=1'].join(':'),
      ...common,
    ],
    h264_nvenc: [
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p1',
      '-tune',
      'ull',
      '-rc',
      'cbr',
      '-zerolatency',
      '1',
      '-profile:v',
      'high',
      ...common,
    ],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-low_power', '1', '-profile:v', 'high', ...common],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cbr', '-profile:v', 'high', ...common],
  };

  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...input,
    ...codecArgs[encoder],
    '-flush_packets',
    '1',
    '-f',
    'h264',
    'pipe:1',
  ];
}

/**
 * Spawns FFmpeg and emits H.264 access units as they come out of the encoder.
 */
export class ScreenEncoder {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private assembler: AccessUnitAssembler;
  private logTail: string[] = [];
  private framesSeen = 0;
  private currentMode: 'dda' | 'gdi';
  private restarted = false;
  private stopped = false;

  constructor(private readonly opts: EncoderOptions) {
    this.assembler = new AccessUnitAssembler((au) => {
      this.framesSeen++;
      this.opts.onAccessUnit(au);
    });
    this.currentMode = resolveCaptureMode(opts, opts.ffmpegPath ?? 'ffmpeg');
  }

  get args(): string[] {
    return buildEncoderArgs(this.opts);
  }

  get captureMode(): string {
    return this.currentMode;
  }

  start(): void {
    if (this.stopped) return;
    const ffmpeg = this.opts.ffmpegPath ?? 'ffmpeg';
    const args = this.args;
    this.opts.onLog?.(`ffmpeg ${args.join(' ')}`);
    const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const startedAt = Date.now();
    this.framesSeen = 0;

    proc.stdout.on('data', (chunk: Buffer) => this.assembler.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) {
        this.logTail.push(text);
        if (this.logTail.length > 20) this.logTail.shift();
        this.opts.onLog?.(text);
      }
    });
    proc.on('exit', (code) => {
      this.assembler.flush();
      // stop() kills the process on purpose; without this guard the fallback
      // below would spawn a replacement that nothing owns, and it would keep
      // encoding into whatever session is active next.
      if (this.stopped) return;
      // Desktop Duplication can fail at any point — drivers, multi-GPU setups and
      // a virtual display adapter another product is already duplicating all
      // produce DXGI_ERROR_ACCESS_LOST. Fall back once to gdigrab instead of
      // leaving the user with a frozen picture.
      if (code !== 0 && this.currentMode === 'dda' && !this.restarted) {
        this.restarted = true;
        this.currentMode = 'gdi';
        this.opts.onLog?.('ddagrab 中断，回退到 gdigrab');
        (this.opts as { source: EncoderOptions['source'] }).source = { kind: 'screen', mode: 'gdi' };
        this.start();
        return;
      }
      this.opts.onExit?.(code);
    });
    proc.on('error', (err) => {
      this.opts.onLog?.(`ffmpeg spawn failed: ${err.message}`);
      this.opts.onExit?.(-1);
    });
  }

  get running(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  stop(): void {
    this.stopped = true;
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }

  get lastErrors(): string[] {
    return this.logTail.slice();
  }
}
