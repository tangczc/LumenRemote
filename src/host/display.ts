import { execFile } from 'node:child_process';
import { readDisplayState } from './display-mode.ts';

export interface DisplayInfo {
  width: number;
  height: number;
  fps: number;
}

/**
 * One physical display attached to the host, in virtual-desktop coordinates.
 * `index` is the enumeration position: capture backends (ddagrab output_idx,
 * gdigrab offsets) and the controller's screen picker all refer to it, so it
 * must stay stable for the lifetime of a session.
 */
export interface HostDisplay {
  index: number;
  /** OS device name, e.g. \\.\DISPLAY1; informational only. */
  name: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  refreshRate: number;
}

/**
 * Enumerate every attached display. Windows answers through the display-mode
 * PowerShell probe (EnumDisplayDevices + current DEVMODE, so positions and
 * sizes are physical pixels); anywhere else, or when the probe fails, the
 * host degrades to the single primary display it already knew about.
 */
export async function listDisplays(fps = 60): Promise<HostDisplay[]> {
  if (process.platform === 'win32') {
    const state = await readDisplayState();
    if (state && state.layout.length > 0) {
      return state.layout.map((e, index) => ({
        index,
        name: e.device,
        primary: e.primary,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        refreshRate: e.refreshRate,
      }));
    }
  }
  const primary = await queryDisplay(fps);
  return [
    {
      index: 0,
      name: '主屏',
      primary: true,
      x: 0,
      y: 0,
      width: primary.width,
      height: primary.height,
      refreshRate: primary.fps,
    },
  ];
}

/** Index of the primary display, or 0 when nothing is flagged. */
export function primaryDisplayIndex(displays: HostDisplay[]): number {
  const found = displays.find((d) => d.primary);
  return found ? found.index : 0;
}

export interface VirtualBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of the whole virtual desktop (origins may be negative). */
export function virtualBounds(displays: HostDisplay[]): VirtualBounds {
  if (displays.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.x);
    minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.width);
    maxY = Math.max(maxY, d.y + d.height);
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
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
