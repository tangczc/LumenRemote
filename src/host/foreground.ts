import { spawn, type ChildProcess } from 'node:child_process';

const CS = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class LumenFg
{
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int needed);

    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthority(IntPtr sid, uint sub);

    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    public struct RECT { public int Left, Top, Right, Bottom; }

    /**
     * Mandatory integrity level of a process, as a short label. This is
     * what decides whether our SendInput can reach a window at all:
     * Windows silently drops synthetic input from a medium-integrity
     * injector aimed at a high-integrity (elevated) game window, while
     * desktop apps at the same level accept it — the exact signature of
     * "the game ignores every click". Logging both sides ends the
     * guessing about which wall we hit.
     */
    public static string IntegrityOf(uint pid)
    {
        IntPtr proc = OpenProcess(0x1000, false, pid); // QUERY_LIMITED_INFORMATION
        if (proc == IntPtr.Zero) return "?";
        IntPtr token;
        try
        {
            if (!OpenProcessToken(proc, 0x0008, out token)) return "?"; // TOKEN_QUERY
            try
            {
                int needed;
                GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed); // TokenIntegrityLevel
                if (needed <= 0) return "?";
                IntPtr buf = Marshal.AllocHGlobal(needed);
                try
                {
                    if (!GetTokenInformation(token, 25, buf, needed, out needed)) return "?";
                    IntPtr sid = Marshal.ReadIntPtr(buf);
                    byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                    int rid = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
                    if (rid >= 0x4000) return "system";
                    if (rid >= 0x3000) return "high";
                    if (rid >= 0x2000) return "medium";
                    return "low";
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            finally { CloseHandle(token); }
        }
        finally { CloseHandle(proc); }
    }

    public static string Foreground()
    {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return "";
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        string name = "?";
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        RECT r;
        GetWindowRect(h, out r);
        return pid + "|" + name + "|" + r.Left + "," + r.Top + "," +
               (r.Right - r.Left) + "," + (r.Bottom - r.Top) + "|" + IntegrityOf(pid);
    }
}
`;

const SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  'Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:LUMEN_FG_CS)))',
  '$parentPid = [int]$env:LUMEN_PARENT_PID',
  // Report our own app's integrity once: the injector is its child, so
  // this is the level synthetic input originates from.
  '[Console]::Out.WriteLine("self " + [LumenFg]::IntegrityOf([uint]$parentPid))',
  '[Console]::Out.Flush()',
  "$last = '__none__'",
  'while ($true) {',
  // Orphan guard: if the app died without stopping us, do not linger.
  '  try { $null = [System.Diagnostics.Process]::GetProcessById($parentPid) } catch { break }',
  '  $fg = [LumenFg]::Foreground()',
  '  if ($fg -and $fg -ne $last) {',
  '    $last = $fg',
  '    [Console]::Out.WriteLine("fg " + $fg)',
  '    [Console]::Out.Flush()',
  '  }',
  '  Start-Sleep -Milliseconds 500',
  '}',
].join('\n');

const INTEGRITY_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  system: '系统',
};

function integrityLabel(raw: string | undefined): string {
  const key = (raw ?? '').trim().toLowerCase();
  return INTEGRITY_LABELS[key] ?? (key || '?');
}

export interface ForegroundInfo {
  pid: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Mandatory integrity level label of the foreground process. */
  integrity: string;
}

export interface ForegroundMonitorOptions {
  onChange: (info: ForegroundInfo) => void;
  /** Fires once with this app's own integrity level (the injector's too). */
  onSelfIntegrity?: (integrity: string) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Reports which application owns the foreground window on the host.
 * Remote-control post-mortems kept hitting the same wall — "clicks do
 * nothing while game X is in front" — with no record of what was
 * actually in front, whether it was fullscreen, or whether it had
 * switched the display mode. This makes the next log export answer
 * that directly instead of by guesswork.
 */
export class ForegroundMonitor {
  private proc: ChildProcess | null = null;
  private buffer = '';

  constructor(private readonly opts: ForegroundMonitorOptions) {}

  start(): void {
    if (process.platform !== 'win32' || this.proc) return;
    const env = {
      ...process.env,
      LUMEN_FG_CS: Buffer.from(CS, 'utf8').toString('base64'),
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
      this.opts.log?.('warn', `前台应用监测启动失败: ${err.message}`);
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
      if (line.startsWith('self ')) {
        this.opts.onSelfIntegrity?.(integrityLabel(line.slice(5).trim()));
        continue;
      }
      if (!line.startsWith('fg ')) continue;
      const parts = line.slice(3).split('|');
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const nums = (parts[2] ?? '').split(',').map(Number);
      const x = nums[0] ?? 0;
      const y = nums[1] ?? 0;
      const width = nums[2] ?? 0;
      const height = nums[3] ?? 0;
      if (!Number.isFinite(pid) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
      this.opts.onChange({ pid, name: parts[1] || '?', x, y, width, height, integrity: integrityLabel(parts[3]) });
    }
  }

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}
