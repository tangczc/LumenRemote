import { execFile } from 'node:child_process';

export interface DisplayMode {
  width: number;
  height: number;
  refreshRate: number;
}

export interface DisplayRequest {
  width: number;
  height: number;
  fps?: number;
}

/**
 * One display attached to the desktop, including where Windows placed it.
 *
 * Changing the primary's resolution makes Windows re-anchor the other displays
 * (a side-by-side pair ends up vertically offset), so the layout has to travel
 * with the mode and be put back afterwards.
 */
export interface DisplayLayout {
  device: string;
  x: number;
  y: number;
  width: number;
  height: number;
  refreshRate: number;
  primary: boolean;
}

/** Screen state a session has to hand back when it ends. */
export interface DisplayState {
  current: DisplayMode | null;
  /** DDC/CI brightness, or -1 when the panel does not expose it. */
  brightness: number;
  modes: DisplayMode[];
  layout: DisplayLayout[];
}

export interface HandoverResult {
  /** Mode actually applied, or null when the panel already matched. */
  mode: DisplayMode | null;
  /** True when the panel was dimmed to black. */
  dimmed: boolean;
  /** Layout to hand to `restoreDisplay`. */
  layout: DisplayLayout[];
}

const ASPECT_TOLERANCE = 0.02;

function pixels(mode: DisplayMode): number {
  return mode.width * mode.height;
}

function closestRefresh(list: DisplayMode[], fps: number): DisplayMode {
  let best = list[0]!;
  for (const mode of list) {
    if (Math.abs(mode.refreshRate - fps) < Math.abs(best.refreshRate - fps)) best = mode;
  }
  return best;
}

/**
 * Pick the panel mode that lets the controller see its own resolution natively.
 *
 * Exact pixel matches are what real products aim for, so they win outright. When
 * the panel has no such mode the next best thing is the smallest mode with the
 * same shape that still covers the request: the encoder then runs 1:1 and the
 * controller shrinks by a hair instead of shrinking a 4K desktop by half. A
 * controller with an aspect ratio the panel cannot express (a 20:9 phone) gets
 * `null`, which keeps the old scale-on-the-host behaviour.
 */
export function pickDisplayMode(modes: DisplayMode[], request: DisplayRequest): DisplayMode | null {
  if (modes.length === 0 || request.width <= 0 || request.height <= 0) return null;
  const fps = request.fps ?? 60;
  const aspect = request.width / request.height;
  const shaped = modes.filter((m) => m.height > 0 && Math.abs(m.width / m.height - aspect) <= ASPECT_TOLERANCE);
  if (shaped.length === 0) return null;

  const exact = shaped.filter((m) => m.width === request.width && m.height === request.height);
  if (exact.length > 0) return closestRefresh(exact, fps);

  const covering = shaped
    .filter((m) => m.width >= request.width && m.height >= request.height)
    .sort((a, b) => pixels(a) - pixels(b));
  if (covering.length > 0) {
    const smallest = pixels(covering[0]!);
    return closestRefresh(
      covering.filter((m) => pixels(m) === smallest),
      fps,
    );
  }

  // Nothing covers the request; the largest shaped mode is still sharper than
  // encoding the desktop at an unrelated resolution, but refuse wild drops.
  const largest = [...shaped].sort((a, b) => pixels(b) - pixels(a))[0]!;
  if (largest.width < request.width * 0.6) return null;
  return closestRefresh(
    shaped.filter((m) => pixels(m) === pixels(largest)),
    fps,
  );
}

// --------------------------------------------------------------- PowerShell

/**
 * The panel has to be reconfigured and dimmed from outside Node, and Windows
 * exposes both through plain Win32 calls, so the same pattern the injector uses
 * (a one-shot PowerShell hosting a little P/Invoke) applies here.
 */
const CS = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class LumenDisplay
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PHYSICAL_MONITOR
    {
        public IntPtr hPhysicalMonitor;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprc, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplayDevices(string device, int devNum, ref DISPLAY_DEVICE dd, int flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int ChangeDisplaySettingsEx(string deviceName, ref DEVMODE devMode, IntPtr hwnd, uint flags, IntPtr param);

    [DllImport("user32.dll", EntryPoint = "ChangeDisplaySettingsExW", CharSet = CharSet.Unicode)]
    static extern int ApplyStagedChanges(IntPtr deviceName, IntPtr devMode, IntPtr hwnd, uint flags, IntPtr param);

    [DllImport("user32.dll")]
    static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, ref uint count);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool DestroyPhysicalMonitors(uint count, [In] PHYSICAL_MONITOR[] monitors);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, IntPtr type, ref uint current, ref uint maximum);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool SetVCPFeature(IntPtr h, byte code, uint value);

    const int ENUM_CURRENT_SETTINGS = -1;
    const int DM_PELSWIDTH = 0x80000;
    const int DM_PELSHEIGHT = 0x100000;
    const int DM_DISPLAYFREQUENCY = 0x400000;
    const int DM_POSITION = 0x20;
    const uint CDS_TEST = 0x02;
    const uint CDS_UPDATEREGISTRY = 0x01;
    const uint CDS_NORESET = 0x04;
    const byte VCP_BRIGHTNESS = 0x10;

    static DEVMODE Blank()
    {
        DEVMODE dm = new DEVMODE();
        dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        dm.dmDeviceName = new string(new char[32]);
        dm.dmFormName = new string(new char[32]);
        return dm;
    }

    static string ModeJson(DEVMODE dm)
    {
        return "{\\"width\\":" + dm.dmPelsWidth + ",\\"height\\":" + dm.dmPelsHeight + ",\\"refreshRate\\":" + dm.dmDisplayFrequency + "}";
    }

    static List<PHYSICAL_MONITOR> Monitors()
    {
        List<PHYSICAL_MONITOR> found = new List<PHYSICAL_MONITOR>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr hMonitor, IntPtr hdc, IntPtr lprc, IntPtr data)
        {
            uint count = 0;
            if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, ref count) || count == 0) return true;
            PHYSICAL_MONITOR[] arr = new PHYSICAL_MONITOR[count];
            if (GetPhysicalMonitorsFromHMONITOR(hMonitor, count, arr))
            {
                foreach (PHYSICAL_MONITOR pm in arr)
                {
                    if (pm.hPhysicalMonitor != IntPtr.Zero) found.Add(pm);
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static int ReadBrightness()
    {
        List<PHYSICAL_MONITOR> monitors = Monitors();
        int value = -1;
        foreach (PHYSICAL_MONITOR pm in monitors)
        {
            uint cur = 0;
            uint max = 0;
            if (GetVCPFeatureAndVCPFeatureReply(pm.hPhysicalMonitor, VCP_BRIGHTNESS, IntPtr.Zero, ref cur, ref max) && max > 0)
            {
                value = (int)cur;
                break;
            }
        }
        DestroyPhysicalMonitors((uint)monitors.Count, monitors.ToArray());
        return value;
    }

    static int WriteBrightness(int value)
    {
        List<PHYSICAL_MONITOR> monitors = Monitors();
        int changed = 0;
        foreach (PHYSICAL_MONITOR pm in monitors)
        {
            if (SetVCPFeature(pm.hPhysicalMonitor, VCP_BRIGHTNESS, (uint)value)) changed++;
        }
        DestroyPhysicalMonitors((uint)monitors.Count, monitors.ToArray());
        return changed;
    }

    static string SwitchMode(int width, int height, int fps)
    {
        DEVMODE dm = Blank();
        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
        if (fps > 0)
        {
            dm.dmDisplayFrequency = fps;
            dm.dmFields |= DM_DISPLAYFREQUENCY;
        }
        if (ChangeDisplaySettingsEx(null, ref dm, IntPtr.Zero, CDS_TEST, IntPtr.Zero) != 0) return "unsupported";
        int rc = ChangeDisplaySettingsEx(null, ref dm, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero);
        return rc == 0 ? "ok" : "failed:" + rc;
    }

    /** Current mode, DDC/CI brightness and every mode the panel advertises. */
    public static string Read()
    {
        DEVMODE dm = Blank();
        string current = EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref dm) ? ModeJson(dm) : "null";
        List<string> modes = new List<string>();
        List<string> seen = new List<string>();
        for (int i = 0; ; i++)
        {
            DEVMODE m = Blank();
            if (!EnumDisplaySettings(null, i, ref m)) break;
            if ((m.dmFields & DM_PELSWIDTH) == 0 || (m.dmFields & DM_PELSHEIGHT) == 0) continue;
            string key = m.dmPelsWidth + "x" + m.dmPelsHeight + "@" + m.dmDisplayFrequency;
            if (seen.Contains(key)) continue;
            seen.Add(key);
            modes.Add(ModeJson(m));
        }
        return "{\\"current\\":" + current + ",\\"brightness\\":" + ReadBrightness() + ",\\"modes\\":[" + string.Join(",", modes.ToArray()) + "]" +
               ",\\"layout\\":" + LayoutJson() + "}";
    }

    /** Every display attached to the desktop, with its position and mode. */
    public static string LayoutJson()
    {
        List<string> entries = new List<string>();
        for (int i = 0; ; i++)
        {
            DISPLAY_DEVICE dd = new DISPLAY_DEVICE();
            dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            if (!EnumDisplayDevices(null, i, ref dd, 0)) break;
            if ((dd.StateFlags & 0x1) == 0) continue;   // not attached to the desktop
            DEVMODE dm = Blank();
            if (!EnumDisplaySettings(dd.DeviceName, -1, ref dm)) continue;
            entries.Add("{\\"device\\":\\"" + dd.DeviceName.Replace("\\\\", "\\\\\\\\") + "\\"" +
                        ",\\"x\\":" + dm.dmPositionX + ",\\"y\\":" + dm.dmPositionY +
                        ",\\"width\\":" + dm.dmPelsWidth + ",\\"height\\":" + dm.dmPelsHeight +
                        ",\\"refreshRate\\":" + dm.dmDisplayFrequency +
                        ",\\"primary\\":" + ((dd.StateFlags & 0x4) != 0 ? "true" : "false") + "}");
        }
        return "[" + string.Join(",", entries.ToArray()) + "]";
    }

    /** Stages one display's mode and position without applying it yet. */
    static void Stage(string device, int x, int y, int width, int height, int refresh)
    {
        DEVMODE dm = Blank();
        dm.dmPositionX = x;
        dm.dmPositionY = y;
        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmDisplayFrequency = refresh;
        dm.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT | (refresh > 0 ? DM_DISPLAYFREQUENCY : 0);
        ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, CDS_NORESET | CDS_UPDATEREGISTRY, IntPtr.Zero);
    }

    /**
     * Puts every display back where it was, modes included. Staged with
     * CDS_NORESET so the whole desktop is re-applied in one go — applying them
     * one by one is what lets Windows shuffle the neighbours around.
     */
    public static string RestoreLayout(string json)
    {
        string[] parts = json.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string part in parts)
        {
            string[] f = part.Split(',');
            if (f.Length < 7) continue;
            Stage(f[0], int.Parse(f[1]), int.Parse(f[2]), int.Parse(f[3]), int.Parse(f[4]), int.Parse(f[5]));
        }
        int rc = ApplyStagedChanges(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero);
        return "{\\"apply\\":" + rc + "}";
    }

    /**
     * Switches the primary and re-anchors the other displays to their recorded
     * positions in one staged transaction, so Windows never sees an intermediate
     * topology (that is what slides the neighbours around).
     */
    public static string ApplyWithLayout(int width, int height, int fps, int brightness, string keep)
    {
        string mode = "skipped";
        if (keep.Length > 0)
        {
            bool staged = false;
            string[] parts = keep.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string part in parts)
            {
                string[] f = part.Split(',');
                if (f.Length < 7) continue;
                bool primary = f[6] == "1";
                Stage(f[0],
                      primary ? 0 : int.Parse(f[1]),
                      primary ? 0 : int.Parse(f[2]),
                      primary && width > 0 ? width : int.Parse(f[3]),
                      primary && height > 0 ? height : int.Parse(f[4]),
                      primary && fps > 0 ? fps : int.Parse(f[5]));
                if (primary && width > 0) staged = true;
            }
            int rc = ApplyStagedChanges(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero);
            if (staged) mode = rc == 0 ? "ok" : "failed:" + rc;
        }
        else if (width > 0 && height > 0)
        {
            mode = SwitchMode(width, height, fps);
        }
        int dimmed = brightness >= 0 ? WriteBrightness(brightness) : -1;
        return "{\\"mode\\":\\"" + mode + "\\",\\"brightnessApplied\\":" + dimmed + "}";
    }
}
`;

const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:LUMEN_DISPLAY_CS)))',
  '$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:LUMEN_DISPLAY_REQ)) | ConvertFrom-Json',
  'switch ($req.action) {',
  "  'read' { [LumenDisplay]::Read() }",
  "  'apply' { [LumenDisplay]::ApplyWithLayout([int]$req.width, [int]$req.height, [int]$req.fps, [int]$req.brightness, [string]$req.keep) }",
  "  'restore' { [LumenDisplay]::RestoreLayout([string]$req.keep) }",
  '}',
].join('\n');

interface RunRequest {
  action: 'read' | 'apply' | 'restore';
  width?: number;
  height?: number;
  fps?: number;
  brightness?: number;
  keep?: string;
}

function run(request: RunRequest, timeoutMs = 15000): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const env = {
    ...process.env,
    LUMEN_DISPLAY_CS: Buffer.from(CS, 'utf8').toString('base64'),
    LUMEN_DISPLAY_REQ: Buffer.from(
      JSON.stringify({ brightness: -1, width: 0, height: 0, fps: 0, ...request }),
      'utf8',
    ).toString('base64'),
  };
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { timeout: timeoutMs, windowsHide: true, env, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err && process.env.LUMEN_DEBUG_DISPLAY) {
          console.error('[display] powerShell failed:', err.message, stderr?.slice(0, 800));
        }
        resolve(err ? null : stdout.trim() || null);
      },
    );
  });
}

function parseMode(value: unknown): DisplayMode | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Partial<DisplayMode>;
  if (!Number.isFinite(m.width) || !Number.isFinite(m.height)) return null;
  return {
    width: Math.round(m.width!),
    height: Math.round(m.height!),
    refreshRate: Math.round(m.refreshRate ?? 60),
  };
}

function parseLayout(value: unknown): DisplayLayout[] {
  if (!Array.isArray(value)) return [];
  const out: DisplayLayout[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Partial<DisplayLayout>;
    if (typeof e.device !== 'string' || !e.device) continue;
    if (!Number.isFinite(e.width) || !Number.isFinite(e.height)) continue;
    out.push({
      device: e.device,
      x: Math.round(e.x ?? 0),
      y: Math.round(e.y ?? 0),
      width: Math.round(e.width!),
      height: Math.round(e.height!),
      refreshRate: Math.round(e.refreshRate ?? 60),
      primary: Boolean(e.primary),
    });
  }
  return out;
}

/** Serialised for the PowerShell side: device,x,y,w,h,hz,primary;... */
function layoutSpec(layout: DisplayLayout[]): string {
  return layout
    .map((e) => `${e.device},${e.x},${e.y},${e.width},${e.height},${e.refreshRate},${e.primary ? 1 : 0}`)
    .join(';');
}

/** Reads the panel state; `null` means the platform has nothing to offer. */
export async function readDisplayState(): Promise<DisplayState | null> {
  const raw = await run({ action: 'read' });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { current?: unknown; brightness?: number; modes?: unknown[]; layout?: unknown };
    const modes = (parsed.modes ?? []).map(parseMode).filter((m): m is DisplayMode => m !== null);
    return {
      current: parseMode(parsed.current),
      brightness: Number.isFinite(parsed.brightness) ? Number(parsed.brightness) : -1,
      modes,
      layout: parseLayout(parsed.layout),
    };
  } catch {
    return null;
  }
}

/**
 * Applies a mode and dims the panel in one round trip, keeping every other
 * display pinned where the user put it.
 *
 * Dimming goes through DDC/CI rather than DPMS because Desktop Duplication stops
 * delivering frames once the output is powered down, while a panel at zero
 * brightness keeps the pipeline running — measured 59 fps at 4K with the screen
 * black.
 */
export async function handOverDisplay(
  mode: DisplayMode | null,
  dim: boolean,
  brightness = 0,
  layout: DisplayLayout[] = [],
): Promise<HandoverResult> {
  if (!mode && !dim) return { mode: null, dimmed: false, layout };
  const raw = await run({
    action: 'apply',
    width: mode?.width ?? 0,
    height: mode?.height ?? 0,
    fps: mode?.refreshRate ?? 0,
    brightness: dim ? brightness : -1,
    // The primary is the one being resized; only the neighbours are re-anchored.
    keep: layoutSpec(layout),
  });
  if (!raw) return { mode: null, dimmed: false, layout };
  try {
    const parsed = JSON.parse(raw) as { mode?: string; brightnessApplied?: number };
    return {
      mode: parsed.mode === 'ok' ? mode : null,
      dimmed: (parsed.brightnessApplied ?? -1) > 0,
      layout,
    };
  } catch {
    return { mode: null, dimmed: false, layout };
  }
}

/** Puts every display back exactly as it was: modes, positions and brightness. */
export async function restoreDisplay(layout: DisplayLayout[], brightness: number): Promise<boolean> {
  if (layout.length === 0 && brightness < 0) return true;
  const raw = await run({ action: 'restore', keep: layoutSpec(layout) });
  if (!raw) return false;
  let layoutOk = false;
  try {
    const parsed = JSON.parse(raw) as { apply?: number };
    layoutOk = (parsed.apply ?? -1) === 0;
  } catch {
    layoutOk = false;
  }
  if (brightness < 0) return layoutOk;
  // Brightness needs a second call because the restore path leaves the panel alone.
  const dimmed = await run({ action: 'apply', brightness, keep: '' });
  if (!dimmed) return false;
  try {
    const parsed = JSON.parse(dimmed) as { brightnessApplied?: number };
    return layoutOk && (parsed.brightnessApplied ?? -1) > 0;
  } catch {
    return false;
  }
}
