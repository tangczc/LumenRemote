import { spawn, type ChildProcess } from 'node:child_process';
import type { InputEvent } from '../protocol/messages.ts';
import { injectorScript } from '../util/resources.ts';

const SCRIPT = injectorScript();

export interface InjectorOptions {
  enabled?: boolean;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
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
    const line = toLine(event);
    if (!line) return;
    try {
      this.proc.stdin.write(`${line}\n`);
    } catch {
      this.dropped++;
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

  get droppedEvents(): number {
    return this.dropped;
  }
}

function toLine(e: InputEvent): string | null {
  switch (e.k) {
    case 'mm':
      return `mm,${Math.round(e.dx)},${Math.round(e.dy)}`;
    case 'ma':
      return `ma,${Math.round(e.nx)},${Math.round(e.ny)}`;
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
