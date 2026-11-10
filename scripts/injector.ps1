# ScreenDeck event injector (resident helper)
#
# Spawned by the Electron main process. Commands arrive on stdin, one per line,
# results are written to stdout, one per line. Uses only user32.dll from Windows;
# no npm native module is involved.
#
# Design: every P/Invoke and struct operation lives in C# static methods.
# PowerShell only parses the command line and prints a string. This avoids the
# two traps we already hit:
#   1. assigning fields of a .NET struct from PowerShell fails ("property X not found")
#   2. Chinese comments inside Add-Type source get written as ANSI and can swallow
#      the next line, so the C# here must stay ASCII-only.
#
# Protocol:
#   rect  <hwnd>                  -> OK rect <left> <top> <width> <height>
#   click <hwnd> <x> <y>          -> OK click
#   wheel <hwnd> <x> <y> <delta>  -> OK wheel
#   alive <hwnd>                  -> OK alive 0|1
#   quit                          -> OK bye

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class ScreenDeckNative
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT p);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    private const uint WM_MOUSEMOVE   = 0x0200;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP   = 0x0202;
    private const uint WM_MOUSEWHEEL  = 0x020A;
    private const int  MK_LBUTTON     = 0x0001;
    private const uint GA_ROOT        = 2;

    static ScreenDeckNative()
    {
        try { SetProcessDPIAware(); } catch { }
    }

    public static bool Alive(IntPtr hwnd)
    {
        try { return IsWindow(hwnd); } catch { return false; }
    }

    // returns "left,top,width,height", or null on failure
    public static string ClientRect(IntPtr hwnd)
    {
        try
        {
            RECT r;
            if (!GetClientRect(hwnd, out r)) return null;
            POINT origin = new POINT();
            origin.X = 0;
            origin.Y = 0;
            if (!ClientToScreen(hwnd, ref origin)) return null;
            return origin.X + "," + origin.Y + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
        }
        catch { return null; }
    }

    // The hit window must share the same top-level window as the target;
    // otherwise something else covers the point (for example our own full-screen
    // output window), and we fall back to the target instead of injecting into
    // ourselves.
    private static IntPtr ResolveTarget(IntPtr hwnd, POINT screen)
    {
        IntPtr hit = WindowFromPoint(screen);
        if (hit == IntPtr.Zero) return hwnd;
        if (GetAncestor(hit, GA_ROOT) != GetAncestor(hwnd, GA_ROOT)) return hwnd;
        return hit;
    }

    private static IntPtr MakeLParam(int x, int y)
    {
        return (IntPtr)((y << 16) | (x & 0xFFFF));
    }

    public static int Click(IntPtr hwnd, int x, int y)
    {
        try
        {
            RECT r;
            if (!GetClientRect(hwnd, out r)) return 1;
            int cw = r.Right - r.Left;
            int ch = r.Bottom - r.Top;
            if (cw <= 0 || ch <= 0) return 2;

            POINT origin = new POINT();
            origin.X = 0;
            origin.Y = 0;
            if (!ClientToScreen(hwnd, ref origin)) return 3;

            if (x < 0 || y < 0 || x >= cw || y >= ch) return 4;

            POINT screen = new POINT();
            screen.X = origin.X + x;
            screen.Y = origin.Y + y;

            IntPtr target = ResolveTarget(hwnd, screen);

            POINT local = new POINT();
            local.X = screen.X;
            local.Y = screen.Y;
            ScreenToClient(target, ref local);

            IntPtr lp = MakeLParam(local.X, local.Y);
            PostMessage(target, WM_MOUSEMOVE, IntPtr.Zero, lp);
            PostMessage(target, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lp);
            Thread.Sleep(15);
            PostMessage(target, WM_LBUTTONUP, IntPtr.Zero, lp);
            return 0;
        }
        catch { return 99; }
    }

    public static int Wheel(IntPtr hwnd, int x, int y, int delta)
    {
        try
        {
            RECT r;
            if (!GetClientRect(hwnd, out r)) return 1;
            int cw = r.Right - r.Left;
            int ch = r.Bottom - r.Top;
            if (cw <= 0 || ch <= 0) return 2;

            POINT origin = new POINT();
            origin.X = 0;
            origin.Y = 0;
            if (!ClientToScreen(hwnd, ref origin)) return 3;

            if (x < 0 || x >= cw) x = cw / 2;
            if (y < 0 || y >= ch) y = ch / 2;

            POINT screen = new POINT();
            screen.X = origin.X + x;
            screen.Y = origin.Y + y;

            IntPtr target = ResolveTarget(hwnd, screen);
            IntPtr root = GetAncestor(hwnd, GA_ROOT);

            // Wheel needs SCREEN coordinates in lParam and the delta in the high word of wParam.
            IntPtr lp = MakeLParam(screen.X, screen.Y);
            IntPtr wParam = (IntPtr)((delta & 0xFFFF) << 16);

            // Some applications (Chromium based ones in particular) only handle the
            // wheel message on the focused child window, others handle it on the
            // top-level window. Post to both: harmless when the extra one is ignored.
            PostMessage(target, WM_MOUSEMOVE, IntPtr.Zero, MakeLParam(x, y));
            PostMessage(target, WM_MOUSEWHEEL, wParam, lp);
            if (root != IntPtr.Zero && root != target)
            {
                PostMessage(root, WM_MOUSEWHEEL, wParam, lp);
            }
            return 0;
        }
        catch { return 99; }
    }
}
'@

function Write-Result([string]$text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

function Get-CodeText([int]$code) {
    switch ($code) {
        0 { 'ok' }
        1 { 'no-window' }
        2 { 'empty-window' }
        3 { 'client-to-screen-failed' }
        4 { 'out-of-range' }
        default { "error-$code" }
    }
}

Write-Result 'OK ready'

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }

    $parts = $line -split '\s+'
    $cmd = $parts[0].ToLowerInvariant()

    try {
        switch ($cmd) {
            'quit' {
                Write-Result 'OK bye'
                exit 0
            }
            'alive' {
                $hwnd = [IntPtr][Int64]$parts[1]
                $ok = [ScreenDeckNative]::Alive($hwnd)
                Write-Result ("OK alive {0}" -f ($(if ($ok) { 1 } else { 0 })))
            }
            'rect' {
                $hwnd = [IntPtr][Int64]$parts[1]
                $result = [ScreenDeckNative]::ClientRect($hwnd)
                if ($null -eq $result) { Write-Result 'ERR rect' }
                else { Write-Result ("OK rect {0}" -f ($result -replace ',', ' ')) }
            }
            'click' {
                $hwnd = [IntPtr][Int64]$parts[1]
                $code = [ScreenDeckNative]::Click($hwnd, [int]$parts[2], [int]$parts[3])
                if ($code -eq 0) { Write-Result 'OK click' }
                else { Write-Result ("ERR {0}" -f (Get-CodeText $code)) }
            }
            'wheel' {
                $hwnd = [IntPtr][Int64]$parts[1]
                $code = [ScreenDeckNative]::Wheel($hwnd, [int]$parts[2], [int]$parts[3], [int]$parts[4])
                if ($code -eq 0) { Write-Result 'OK wheel' }
                else { Write-Result ("ERR {0}" -f (Get-CodeText $code)) }
            }
            default {
                Write-Result ("ERR unknown {0}" -f $cmd)
            }
        }
    }
    catch {
        Write-Result ("ERR exception {0}" -f $_.Exception.Message)
    }
}
