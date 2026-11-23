import { execFile } from 'node:child_process';

export interface DisplayInfo {
  width: number;
  height: number;
  fps: number;
}

const FALLBACK: DisplayInfo = { width: 1920, height: 1080, fps: 60 };

/**
 * Query the primary display bounds. Runs once at startup; the fallback keeps the
 * host usable if PowerShell is unavailable.
 */
export async function queryDisplay(fps = 60): Promise<DisplayInfo> {
  if (process.platform !== 'win32') return { ...FALLBACK, fps };
  // SetProcessDPIAware makes Bounds report physical pixels, so a 3840x2160
  // panel does not read back as its 175%-scaled logical size.
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public class Dpi { ' +
    '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }\'; ' +
    '[Dpi]::SetProcessDPIAware() | Out-Null; ' +
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    '"$($b.Width)x$($b.Height)"';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 6000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve({ ...FALLBACK, fps });
        const m = /(\d+)x(\d+)/.exec(stdout.trim());
        if (!m) return resolve({ ...FALLBACK, fps });
        resolve({ width: Number(m[1]), height: Number(m[2]), fps });
      },
    );
  });
}
