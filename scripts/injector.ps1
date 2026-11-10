# ScreenDeck 事件注入器（常驻进程）
#
# 由主进程以子进程方式启动，通过 stdin 逐行接收命令，stdout 逐行返回结果。
# 只用 Windows 自带的 user32.dll（P/Invoke），不引入任何 npm 原生模块。
#
# 命令：
#   rect <hwnd>                    -> OK rect <left> <top> <width> <height>
#   click <hwnd> <x> <y>           -> OK click
#   wheel <hwnd> <x> <y> <delta>   -> OK wheel
#   alive <hwnd>                   -> OK alive 0|1
#   quit                           -> OK bye
#
# 坐标 <x> <y> 都是「客户区坐标」，由主进程按归一化位置换算。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ScreenDeckNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT p);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    public const uint WM_MOUSEMOVE   = 0x0200;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP   = 0x0202;
    public const uint WM_MOUSEWHEEL  = 0x020A;
    public const uint MK_LBUTTON     = 0x0001;

    public static IntPtr MakeLParam(int x, int y)
    {
        return (IntPtr)((y << 16) | (x & 0xFFFF));
    }
}
'@

try { [ScreenDeckNative]::SetProcessDPIAware() | Out-Null } catch { }

function Write-Result([string]$text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

function Get-ClientOrigin([IntPtr]$hwnd) {
    $rect = New-Object ScreenDeckNative+RECT
    if (-not [ScreenDeckNative]::GetClientRect($hwnd, [ref]$rect)) { return $null }

    $origin = New-Object ScreenDeckNative+POINT
    $origin.X = 0
    $origin.Y = 0
    if (-not [ScreenDeckNative]::ClientToScreen($hwnd, [ref]$origin)) { return $null }

    return @{
        Left = $origin.X
        Top = $origin.Y
        Width = $rect.Right - $rect.Left
        Height = $rect.Bottom - $rect.Top
    }
}

function Resolve-InjectTarget([IntPtr]$hwnd, $screenPoint) {
    $hit = [ScreenDeckNative]::WindowFromPoint($screenPoint)
    if ($hit -eq [IntPtr]::Zero) { return $hwnd }

    # 只有命中的窗口和目标窗口属于同一顶层窗口时才用它；
    # 否则说明鼠标点被别的窗口挡住（例如我们自己盖在副屏上的全屏大屏窗口），
    # 这时退回原始目标窗口，避免把点击注入到自己身上。
    $hitRoot = [ScreenDeckNative]::GetAncestor($hit, [ScreenDeckNative]::GA_ROOT)
    $targetRoot = [ScreenDeckNative]::GetAncestor($hwnd, [ScreenDeckNative]::GA_ROOT)
    if ($hitRoot -ne $targetRoot) { return $hwnd }
    return $hit
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
                $ok = [ScreenDeckNative]::IsWindow($hwnd)
                Write-Result ("OK alive {0}" -f ($(if ($ok) { 1 } else { 0 })))
            }
            'rect' {
                $hwnd = [IntPtr][Int64]$parts[1]
                $info = Get-ClientOrigin $hwnd
                if ($null -eq $info) { Write-Result 'ERR rect'; break }
                Write-Result ("OK rect {0} {1} {2} {3}" -f $info.Left, $info.Top, $info.Width, $info.Height)
            }
            'click' {
                $hwnd = [IntPtr][Int64]$parts[1]
                $x = [int]$parts[2]
                $y = [int]$parts[3]

                $origin = Get-ClientOrigin $hwnd
                if ($null -eq $origin) { Write-Result 'ERR no-window'; break }
                if ($origin.Width -le 0 -or $origin.Height -le 0) { Write-Result 'ERR empty-window'; break }
                if ($x -lt 0 -or $y -lt 0 -or $x -ge $origin.Width -or $y -ge $origin.Height) {
                    Write-Result 'ERR out-of-range'
                    break
                }

                # 找到屏幕坐标下最深的那一层窗口：VS Code / 浏览器把界面画在子窗口里，
                # 消息投给顶层窗口往往被忽略，必须投给命中点所在的子窗口。
                $screenPoint = New-Object ScreenDeckNative+POINT
                $screenPoint.X = $origin.Left + $x
                $screenPoint.Y = $origin.Top + $y

                $target = Resolve-InjectTarget $hwnd $screenPoint

                $local = New-Object ScreenDeckNative+POINT
                $local.X = $screenPoint.X
                $local.Y = $screenPoint.Y
                [void][ScreenDeckNative]::ScreenToClient($target, [ref]$local)

                $lp = [ScreenDeckNative]::MakeLParam($local.X, $local.Y)
                [ScreenDeckNative]::PostMessage($target, [ScreenDeckNative]::WM_MOUSEMOVE, [IntPtr]::Zero, $lp) | Out-Null
                [ScreenDeckNative]::PostMessage($target, [ScreenDeckNative]::WM_LBUTTONDOWN, [IntPtr][ScreenDeckNative]::MK_LBUTTON, $lp) | Out-Null
                Start-Sleep -Milliseconds 12
                [ScreenDeckNative]::PostMessage($target, [ScreenDeckNative]::WM_LBUTTONUP, [IntPtr]::Zero, $lp) | Out-Null
                Write-Result 'OK click'
            }
            'wheel' {
                $hwnd = [IntPtr][Int64]$parts[1]
                $x = [int]$parts[2]
                $y = [int]$parts[3]
                $delta = [int]$parts[4]

                $origin = Get-ClientOrigin $hwnd
                if ($null -eq $origin) { Write-Result 'ERR no-window'; break }

                $screenPoint = New-Object ScreenDeckNative+POINT
                $screenPoint.X = $origin.Left + $x
                $screenPoint.Y = $origin.Top + $y

                $target = Resolve-InjectTarget $hwnd $screenPoint

                # WM_MOUSEWHEEL 的 lParam 必须是屏幕坐标
                $lp = [ScreenDeckNative]::MakeLParam($screenPoint.X, $screenPoint.Y)
                $wParam = [IntPtr](($delta -band 0xFFFF) -shl 16)
                [ScreenDeckNative]::PostMessage($target, [ScreenDeckNative]::WM_MOUSEWHEEL, $wParam, $lp) | Out-Null
                Write-Result 'OK wheel'
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
