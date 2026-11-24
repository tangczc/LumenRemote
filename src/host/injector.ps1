# Remote desktop input injector (Windows).
# Reads newline-delimited commands from stdin and replays them with SendInput.
# Line format:  <cmd>,<arg1>,<arg2>
#   mm,dx,dy        relative mouse move (raw input semantics)
#   ma,nx,ny        absolute mouse move, 0..65535 normalised to the virtual desktop
#   mb,button,down  button: 0 left 1 right 2 middle 3 x1 4 x2
#   mw,delta        wheel delta (120 per notch)
#   kd,scan,vk      key down (scan 0 => use vk only; vk bit 0x100 = extended)
#   ku,scan,vk      key up
#   kr,text         unicode text

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class RDInject
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    /**
     * Absolute coordinates are virtualised for a DPI-unaware process: at 175%
     * scaling a click at 1920 lands at 1097. Every input path needs this first.
     */
    public static void MakeDpiAware()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;

    private const uint MOVE = 0x0001;
    private const uint ABSOLUTE = 0x8000;
    private const uint VIRTUALDESK = 0x4000;
    private const uint LB_DOWN = 0x0002, LB_UP = 0x0004;
    private const uint RB_DOWN = 0x0008, RB_UP = 0x0010;
    private const uint MB_DOWN = 0x0020, MB_UP = 0x0040;
    private const uint X_DOWN = 0x0080, X_UP = 0x0100;
    private const uint WHEEL = 0x0800;

    private const uint EXTENDED = 0x0001, KEYUP = 0x0002, SCANCODE = 0x0008, UNICODE = 0x0004;

    private static int Size { get { return Marshal.SizeOf(typeof(INPUT)); } }

    private static INPUT MouseInput(uint flags, int dx, int dy, uint data)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dx = dx;
        i.u.mi.dy = dy;
        i.u.mi.mouseData = data;
        i.u.mi.dwFlags = flags;
        return i;
    }

    private static void Send(INPUT input)
    {
        INPUT[] buffer = new INPUT[] { input };
        SendInput(1, buffer, Size);
    }

    public static void MoveRelative(int dx, int dy)
    {
        if (dx == 0 && dy == 0) return;
        // A single large delta runs through the host's pointer acceleration curve
        // and overshoots what the controller asked for (10 px arrived as 22 px at
        // the default "enhance pointer precision"). Stepping one pixel at a time
        // in one batched SendInput keeps the mapping 1:1 while staying cheap.
        int steps = Math.Max(1, Math.Min(Math.Max(Math.Abs(dx), Math.Abs(dy)), 1024));
        INPUT[] batch = new INPUT[steps];
        int px = 0, py = 0;
        for (int i = 0; i < steps; i++)
        {
            int nx = (int)Math.Round((double)dx * (i + 1) / steps);
            int ny = (int)Math.Round((double)dy * (i + 1) / steps);
            batch[i] = MouseInput(MOVE, nx - px, ny - py, 0);
            px = nx;
            py = ny;
        }
        SendInput((uint)batch.Length, batch, Size);
    }

    // VIRTUALDESK: without it SendInput normalises 0..65535 onto the primary
    // monitor only, so on any multi-monitor host (or a primary that is not at
    // the virtual desktop's origin) every click lands offset from where the
    // controller pointed — capture (gdigrab "desktop") spans the whole
    // virtual desktop, so injection must use the same coordinate space.
    public static void MoveAbsolute(int nx, int ny) { Send(MouseInput(MOVE | ABSOLUTE | VIRTUALDESK, nx, ny, 0)); }

    public static void Button(int button, bool down)
    {
        uint flags;
        uint data = 0;
        switch (button)
        {
            case 0: flags = down ? LB_DOWN : LB_UP; break;
            case 1: flags = down ? RB_DOWN : RB_UP; break;
            case 2: flags = down ? MB_DOWN : MB_UP; break;
            case 3: flags = down ? X_DOWN : X_UP; data = 1; break;
            default: flags = down ? X_DOWN : X_UP; data = 2; break;
        }
        Send(MouseInput(flags, 0, 0, data));
    }

    public static void Wheel(int delta) { Send(MouseInput(WHEEL, 0, 0, unchecked((uint)delta))); }

    public static void Key(int scan, int vk, bool down)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wScan = (ushort)(scan & 0xFF);
        i.u.ki.wVk = (ushort)(vk & 0xFF);
        uint flags = 0;
        if (scan != 0) flags |= SCANCODE;
        if (!down) flags |= KEYUP;
        if ((vk & 0x100) != 0) flags |= EXTENDED;
        i.u.ki.dwFlags = flags;
        Send(i);
    }

    public static void TypeText(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        INPUT[] buffer = new INPUT[text.Length * 2];
        for (int k = 0; k < text.Length; k++)
        {
            INPUT d = new INPUT();
            d.type = INPUT_KEYBOARD;
            d.u.ki.wScan = text[k];
            d.u.ki.dwFlags = UNICODE;
            INPUT u = d;
            u.u.ki.dwFlags = UNICODE | KEYUP;
            buffer[k * 2] = d;
            buffer[k * 2 + 1] = u;
        }
        SendInput((uint)buffer.Length, buffer, Size);
    }
}
"@

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

/**
 * Driver-level injection via the Interception library (optional).
 * SendInput events carry an "injected" flag that games and anti-cheat
 * layers can filter, and UIPI silently drops them for elevated
 * windows. Strokes sent through a kernel HID driver enter the input
 * stack exactly like physical hardware: no flag, Raw Input visible,
 * integrity-proof. Every method returns false when the driver path
 * cannot deliver, and the caller falls back to SendInput per event,
 * so a half-working driver setup degrades instead of going silent.
 */
public static class RDHid
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MouseStroke { public ushort state; public ushort flags; public short rolling; public int x; public int y; public uint information; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KeyStroke { public ushort code; public ushort state; public uint information; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr LoadLibrary(string path);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr interception_create_context();

    [DllImport("interception.dll", EntryPoint = "interception_send", CallingConvention = CallingConvention.Cdecl)]
    private static extern int SendMouseStroke(IntPtr ctx, int device, ref MouseStroke stroke, uint count);

    [DllImport("interception.dll", EntryPoint = "interception_send", CallingConvention = CallingConvention.Cdecl)]
    private static extern int SendKeyStroke(IntPtr ctx, int device, ref KeyStroke stroke, uint count);

    private static IntPtr ctx = IntPtr.Zero;
    private static int mouseDevice = -1;
    private static int keyDevice = 1;

    public static bool TryInit(string[] candidatePaths)
    {
        bool loaded = false;
        foreach (string p in candidatePaths)
        {
            if (!string.IsNullOrEmpty(p) && LoadLibrary(p) != IntPtr.Zero) { loaded = true; break; }
        }
        if (!loaded) loaded = LoadLibrary("interception.dll") != IntPtr.Zero;
        if (!loaded) return false;
        try { ctx = interception_create_context(); } catch { return false; }
        if (ctx == IntPtr.Zero) return false; // library present, driver not installed
        // Probe for a live mouse device with a harmless zero stroke.
        for (int d = 11; d <= 20; d++)
        {
            MouseStroke s = new MouseStroke();
            try { if (SendMouseStroke(ctx, d, ref s, 1) == 1) { mouseDevice = d; break; } }
            catch { return false; }
        }
        return mouseDevice > 0;
    }

    private static bool Send(ref MouseStroke s)
    {
        if (ctx == IntPtr.Zero || mouseDevice < 0) return false;
        try { return SendMouseStroke(ctx, mouseDevice, ref s, 1) == 1; } catch { return false; }
    }

    public static bool MoveRelative(int dx, int dy)
    {
        MouseStroke s = new MouseStroke();
        s.x = dx; s.y = dy;
        return Send(ref s);
    }

    public static bool MoveAbsolute(int nx, int ny)
    {
        MouseStroke s = new MouseStroke();
        s.flags = 0x001 | 0x002; // ABSOLUTE | VIRTUAL_DESKTOP, 0..65535 like SendInput
        s.x = nx; s.y = ny;
        return Send(ref s);
    }

    public static bool Button(int button, bool down)
    {
        MouseStroke s = new MouseStroke();
        switch (button)
        {
            case 0: s.state = down ? (ushort)0x001 : (ushort)0x002; break;
            case 1: s.state = down ? (ushort)0x004 : (ushort)0x008; break;
            case 2: s.state = down ? (ushort)0x010 : (ushort)0x020; break;
            case 3: s.state = down ? (ushort)0x040 : (ushort)0x080; break;
            default: s.state = down ? (ushort)0x100 : (ushort)0x200; break;
        }
        return Send(ref s);
    }

    public static bool Wheel(int delta)
    {
        MouseStroke s = new MouseStroke();
        s.state = 0x400;
        s.rolling = (short)delta;
        return Send(ref s);
    }

    public static bool Key(int scan, int vk, bool down)
    {
        if (scan == 0) return false; // vk-only event: driver path cannot express it
        KeyStroke s = new KeyStroke();
        s.code = (ushort)(scan & 0xFF);
        s.state = down ? (ushort)0 : (ushort)1;
        if ((vk & 0x100) != 0 || scan > 0xFF) s.state |= 0x02; // E0 extended
        if (ctx == IntPtr.Zero) return false;
        try
        {
            if (SendKeyStroke(ctx, keyDevice, ref s, 1) == 1) return true;
            // First keyboard may not live at index 1 on this machine.
            for (int d = 1; d <= 10; d++)
            {
                if (d == keyDevice) continue;
                if (SendKeyStroke(ctx, d, ref s, 1) == 1) { keyDevice = d; return true; }
            }
        }
        catch { }
        return false;
    }
}
"@

# The engine writes UTF-8, but Console.In decodes with the OEM code page, which
# turns Chinese text into mojibake before it ever reaches SendInput.
$stdin = New-Object System.IO.StreamReader(
    [Console]::OpenStandardInput(),
    (New-Object System.Text.UTF8Encoding($false)))
[RDInject]::MakeDpiAware()

# Optional driver-level backend (see RDHid above). Probed once at
# startup; the mode is reported on stderr so the host log states
# plainly which path input took ("注入器 backend=...").
$hidReady = $false
try
{
    $dllCandidates = @(
        $env:RD_INTERCEPTION_DLL,
        (Join-Path $PSScriptRoot 'interception.dll'),
        (Join-Path (Get-Location) 'interception.dll')
    )
    $hidReady = [RDHid]::TryInit($dllCandidates)
}
catch { $hidReady = $false }
if ($hidReady) { [Console]::Error.WriteLine('backend=interception') }
else { [Console]::Error.WriteLine('backend=sendinput') }

while ($null -ne ($line = $stdin.ReadLine()))
{
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $p = $line.Split(',')
    try
    {
        switch ($p[0])
        {
            'mm' { $ok = $false; if ($hidReady) { $ok = [RDHid]::MoveRelative([int]$p[1], [int]$p[2]) }; if (-not $ok) { [RDInject]::MoveRelative([int]$p[1], [int]$p[2]) } }
            'ma' { $ok = $false; if ($hidReady) { $ok = [RDHid]::MoveAbsolute([int]$p[1], [int]$p[2]) }; if (-not $ok) { [RDInject]::MoveAbsolute([int]$p[1], [int]$p[2]) } }
            'mb' { $ok = $false; if ($hidReady) { $ok = [RDHid]::Button([int]$p[1], [bool]::Parse($p[2])) }; if (-not $ok) { [RDInject]::Button([int]$p[1], [bool]::Parse($p[2])) } }
            'mw' { $ok = $false; if ($hidReady) { $ok = [RDHid]::Wheel([int]$p[1]) }; if (-not $ok) { [RDInject]::Wheel([int]$p[1]) } }
            'kd' { $ok = $false; if ($hidReady) { $ok = [RDHid]::Key([int]$p[1], [int]$p[2], $true) }; if (-not $ok) { [RDInject]::Key([int]$p[1], [int]$p[2], $true) } }
            'ku' { $ok = $false; if ($hidReady) { $ok = [RDHid]::Key([int]$p[1], [int]$p[2], $false) }; if (-not $ok) { [RDInject]::Key([int]$p[1], [int]$p[2], $false) } }
            'kr' { [RDInject]::TypeText([string]::Join(',', $p[1..($p.Length - 1)])) }
        }
    }
    catch { }
}
