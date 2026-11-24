import { spawn, type ChildProcess } from 'node:child_process';
import type { InputEvent } from '../protocol/messages.ts';
import { injectorScript } from '../util/resources.ts';

const SCRIPT = injectorScript();

/**
 * [scan, vk] of every modifier, in the wire's encoding (scan truncated to
 * its low byte by the caller, extended keys flagged in vk bit 0x100 — the
 * same shape key events arrive in).
 */
const MODIFIER_KEYS: ReadonlyArray<readonly [number, number]> = [
  [0x1d, 0xa2], // ControlLeft
  [0x11d, 0xa3], // ControlRight
  [0x38, 0xa4], // AltLeft
  [0x138, 0xa5], // AltRight
  [0x2a, 0xa0], // ShiftLeft
  [0x36, 0xa1], // ShiftRight
  [0x15b, 0x5b], // MetaLeft
  [0x15c, 0x5c], // MetaRight
];

/** `ku` lines that leave no modifier down on the host. */
export function modifierReleaseLines(): string[] {
  return MODIFIER_KEYS.map(
    ([scan, vk]) => `ku,${scan & 0xff},${vk | (scan > 0xff ? 0x100 : 0)}`,
  );
}

export interface InjectorOptions {
  enabled?: boolean;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Map an absolute pointer position from frame space to virtual-desktop
 * space, both normalised to 0..65535 (the SendInput convention the
 * PowerShell side uses with MOUSEEVENTF_VIRTUALDESK).
 *
 * `ma` events arrive normalised to the encoded frame, i.e. to the one
 * display being captured. Mapping them through that display's rectangle —
 * with the frame fraction clamped to [0,1] — is what guarantees control
 * can never leak onto another monitor: wherever the controller points,
 * the host cursor stays inside the selected screen.
 */
export function frameToVirtual(
  nx: number,
  ny: number,
  rect: DisplayRect,
  virtual: DisplayRect,
): { nx: number; ny: number } {
  const fx = Math.min(1, Math.max(0, nx / 65535));
  const fy = Math.min(1, Math.max(0, ny / 65535));
  const absX = rect.x + fx * Math.max(1, rect.width);
  const absY = rect.y + fy * Math.max(1, rect.height);
  const vx = ((absX - virtual.x) / Math.max(1, virtual.width)) * 65535;
  const vy = ((absY - virtual.y) / Math.max(1, virtual.height)) * 65535;
  return {
    nx: Math.round(Math.min(65535, Math.max(0, vx))),
    ny: Math.round(Math.min(65535, Math.max(0, vy))),
  };
}

/**
 * Replays input events on the host desktop through SendInput.
 *
 * A persistent PowerShell process hosts the P/Invoke layer; events are pushed as
 * terse CSV lines because JSON parsing per event would dominate the injection
 * latency. Swapping this for an in-process C++ driver is the P1 optimisation.
 */
export class InputInjector {
  private proc: ChildProcess | null = null;
  private readonly enabled: boolean;
  private dropped = 0;
  /** Display the controller is looking at, and the desktop it sits in. */
  private target: { rect: DisplayRect; virtual: DisplayRect } | null = null;

  /**
   * Aim absolute pointer events at one display. Until this is called (and
   * for single-screen hosts, where it is an identity mapping) events pass
   * through unchanged.
   */
  setTarget(rect: DisplayRect, virtual: DisplayRect): void {
    this.target = { rect, virtual };
  }

  constructor(private readonly opts: InjectorOptions = {}) {
    this.enabled = opts.enabled ?? true;
  }

  start(): void {
    if (!this.enabled || this.proc) return;
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];
    const proc = spawn(shell, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    proc.stderr?.on('data', (c: Buffer) => {
      const text = c.toString('utf8').trim();
      if (text) this.opts.log?.('warn', `injector: ${text.slice(0, 200)}`);
    });
    proc.on('exit', (code) => {
      this.opts.log?.('warn', `input injector exited (${code})`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      this.opts.log?.('error', `input injector failed: ${err.message}`);
      this.proc = null;
    });
  }

  get running(): boolean {
    return this.proc !== null;
  }

  inject(event: InputEvent): void {
    if (!this.proc?.stdin?.writable) {
      this.dropped++;
      return;
    }
    const line = toLine(event, this.target);
    if (!line) return;
    try {
      this.proc.stdin.write(`${line}\n`);
    } catch {
      this.dropped++;
    }
  }

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    try {
      // A session that ends mid-chord must not leave a modifier physically
      // down on the host: the local user's next letters would all turn
      // into shortcuts. Release first, then let the helper exit.
      for (const line of modifierReleaseLines()) proc.stdin?.write(`${line}\n`);
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 60).unref?.();
  }

  get droppedEvents(): number {
    return this.dropped;
  }
}

function toLine(
  e: InputEvent,
  target: { rect: DisplayRect; virtual: DisplayRect } | null,
): string | null {
  switch (e.k) {
    case 'mm':
      return `mm,${Math.round(e.dx)},${Math.round(e.dy)}`;
    case 'ma': {
      if (!target) return `ma,${Math.round(e.nx)},${Math.round(e.ny)}`;
      const mapped = frameToVirtual(e.nx, e.ny, target.rect, target.virtual);
      return `ma,${mapped.nx},${mapped.ny}`;
    }
    case 'mb':
      return `mb,${e.b},${e.down ? 'true' : 'false'}`;
    case 'mw':
      return `mw,${Math.round(e.delta)}`;
    case 'kd':
      return `kd,${e.scan},${e.vk}`;
    case 'ku':
      return `ku,${e.scan},${e.vk}`;
    case 'kr':
      return `kr,${e.text.replace(/[\r\n]/g, ' ')}`;
    default:
      return null;
  }
}
