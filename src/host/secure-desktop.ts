import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Watches which desktop currently owns the screen on Windows.
 *
 * UAC consent prompts and the lock screen do not live on the user's
 * desktop: Windows switches to the *secure desktop* (named "Winlogon"),
 * where a normal process can neither capture (Desktop Duplication dies,
 * GDI returns black) nor inject (SendInput is dropped). To the controller
 * that looks like a frozen, black, unclickable session with no
 * explanation. This monitor polls the input desktop's name from a small
 * PowerShell helper so the host can at least say *why* it went dark and
 * recover cleanly when the prompt is dismissed. Actually clicking through
 * UAC requires a SYSTEM service (UIAccess) — a deliberate future step,
 * not something a user-level process can fake.
 */
const CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public class LumenDesk
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int len, out int needed);

    [DllImport("user32.dll")]
    static extern bool CloseDesktop(IntPtr h);

    public static string InputDesktopName()
    {
        IntPtr h = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
        if (h == IntPtr.Zero) return "unknown";
        try
        {
            StringBuilder sb = new StringBuilder(256);
            int needed;
            return GetUserObjectInformation(h, 2, sb, sb.Capacity, out needed) ? sb.ToString() : "unknown";
        }
        finally { CloseDesktop(h); }
    }
}
`;

const SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  'Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:LUMEN_DESK_CS)))',
  '$parentPid = [int]$env:LUMEN_PARENT_PID',
  "$last = '__none__'",
  'while ($true) {',
  // Orphan guard: if the app died without stopping us, do not linger.
  '  try { $null = [System.Diagnostics.Process]::GetProcessById($parentPid) } catch { break }',
  '  $name = [LumenDesk]::InputDesktopName()',
  '  if ($name -ne $last) {',
  '    $last = $name',
  '    [Console]::Out.WriteLine("desktop " + $name)',
  '    [Console]::Out.Flush()',
  '  }',
  '  Start-Sleep -Milliseconds 400',
  '}',
].join('\n');

/** The secure desktop (UAC / lock screen) owns the screen, not the user. */
export function isSecureDesktopName(name: string): boolean {
  return name.toLowerCase() === 'winlogon';
}

export interface SecureDesktopMonitorOptions {
  onChange: (secure: boolean, name: string) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class SecureDesktopMonitor {
  private proc: ChildProcess | null = null;
  private buffer = '';

  constructor(private readonly opts: SecureDesktopMonitorOptions) {}

  start(): void {
    if (process.platform !== 'win32' || this.proc) return;
    const env = {
      ...process.env,
      LUMEN_DESK_CS: Buffer.from(CS, 'utf8').toString('base64'),
      LUMEN_PARENT_PID: String(process.pid),
    };
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env },
    );
    this.proc = proc;
    proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
    });
    proc.on('error', (err) => {
      this.opts.log?.('warn', `安全桌面监测启动失败: ${err.message}`);
      if (this.proc === proc) this.proc = null;
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith('desktop ')) continue;
      const name = line.slice('desktop '.length).trim();
      if (name && name !== 'unknown') this.opts.onChange(isSecureDesktopName(name), name);
    }
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}
