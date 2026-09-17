# =============================================================================
# DSH Desktop Pet -- native always-on-top pet window (Windows / WPF)
# =============================================================================
# Runs independently of the browser: minimize or close the DSH web page and the
# pet stays. It polls the DSH pet plugin over localhost HTTP, so it also dies
# automatically once the terminal (dsh) stops running.
#
# WHY THIS FILE IS PURE ASCII
#   Windows PowerShell 5.1 reads a .ps1 as ANSI unless it starts with a BOM.
#   Any Chinese literal in here would become mojibake on a GBK system. So every
#   user-visible string lives in `strings.zh.json` (read explicitly as UTF-8)
#   and this file stays 7-bit clean. Please keep it that way.
#
# Fired by the plugin host (host.js -> startDesktopPet) or manually:
#   powershell.exe -STA -ExecutionPolicy Bypass -File DesktopPet.ps1 `
#       -Base http://127.0.0.1:3080 -HostPid 1234
#
# Interactions
#   drag                move (position is remembered)
#   hover               tooltip: current workspace + conversation + agent state
#   single click        speech bubble + click sound
#   double click (fast) open Microsoft Edge on the Harness page
#   3 fast clicks       dive animation + sound (same easter egg as the web)
#   right click         menu (open page / switch pet / size / always-on-top / quit)
# =============================================================================

param(
    [string]$Base = 'http://127.0.0.1:3080',
    [int]$HostPid = 0,
    [string]$PetId = '',
    [int]$Size = 0,
    [string]$Log = '',
    [string]$Strings = '',
    # Log any UI-thread tick that takes longer than this many ms (0 = off).
    # Handy when the pet feels laggy: it points straight at the guilty timer.
    [int]$SlowTickMs = 0
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Off

# ---------------------------------------------------------------- assemblies
foreach ($asm in @('PresentationFramework', 'PresentationCore', 'WindowsBase', 'System.Xaml', 'System.Windows.Forms')) {
    try { Add-Type -AssemblyName $asm -ErrorAction Stop } catch { }
}

# ---------------------------------------------------------------- logging
$script:LogPath = $Log
if ($script:LogPath) {
    try {
        $logDir = Split-Path -Parent $script:LogPath
        if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        if (Test-Path -LiteralPath $script:LogPath) {
            $sz = (Get-Item -LiteralPath $script:LogPath).Length
            if ($sz -gt 1048576) { Remove-Item -LiteralPath $script:LogPath -Force -ErrorAction SilentlyContinue }
        }
    } catch { $script:LogPath = '' }
}

function Write-Log {
    param([string]$Message)
    if (-not $script:LogPath) { return }
    try {
        $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
        Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
    } catch { }
}

# ---------------------------------------------------------------- strings
# All Chinese UI text is loaded from a UTF-8 JSON file so this script stays ASCII.
$script:S = @{}
if (-not $Strings) {
    $Strings = Join-Path (Split-Path -Parent $PSCommandPath) 'strings.zh.json'
}
try {
    if (Test-Path -LiteralPath $Strings) {
        $raw = Get-Content -LiteralPath $Strings -Raw -Encoding UTF8
        $obj = $raw | ConvertFrom-Json
        foreach ($p in $obj.PSObject.Properties) { $script:S[$p.Name] = $p.Value }
    }
} catch {
    Write-Log ('failed to load strings: ' + $_.Exception.Message)
}

function T {
    param([string]$Key, [string]$Fallback)
    if ($script:S.ContainsKey($Key) -and $script:S[$Key]) { return [string]$script:S[$Key] }
    return $Fallback
}

# ---------------------------------------------------------------- win32
# Needed for: clicking through fully transparent pixels, and for DPI-safe
# cursor hit-testing (GetCursorPos and GetWindowRect share one coordinate space).
$script:Win32Ready = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtr")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
'@ -ErrorAction Stop
    $script:Win32Ready = $true
    Write-Log 'win32 helpers compiled'
} catch {
    Write-Log ('win32 helpers unavailable (click-through disabled): ' + $_.Exception.Message)
}

$GWL_EXSTYLE = -20
$WS_EX_TRANSPARENT = 0x00000020
$SWP_NOSIZE = 0x0001
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010

# Cached once after SourceInitialized. Creating a WindowInteropHelper (or calling
# GetWindowRect) on every tick/hover flip is a measurable cost during drag.
$script:Hwnd = [IntPtr]::Zero
$script:DpiX = 1.0
$script:DpiY = 1.0

function Get-Hwnd {
    if ($script:Hwnd -ne [IntPtr]::Zero) { return $script:Hwnd }
    try {
        $script:Hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
    } catch { $script:Hwnd = [IntPtr]::Zero }
    return $script:Hwnd
}

# Reused by Get-WindowBox / hit test / drag so no RECT is allocated per call.
$script:ScratchRect = New-Object PetWin32+RECT

function Get-ExStyle {
    param([IntPtr]$Hwnd)
    if (-not $script:Win32Ready -or $Hwnd -eq [IntPtr]::Zero) { return 0 }
    try {
        if ([IntPtr]::Size -eq 8) { return [int][PetWin32]::GetWindowLongPtr($Hwnd, $GWL_EXSTYLE).ToInt64() }
        return [PetWin32]::GetWindowLong($Hwnd, $GWL_EXSTYLE)
    } catch { return 0 }
}

function Set-ExStyle {
    param([IntPtr]$Hwnd, [int]$Style)
    if (-not $script:Win32Ready -or $Hwnd -eq [IntPtr]::Zero) { return }
    try {
        if ([IntPtr]::Size -eq 8) { [void][PetWin32]::SetWindowLongPtr($Hwnd, $GWL_EXSTYLE, [IntPtr]$Style) }
        else { [void][PetWin32]::SetWindowLong($Hwnd, $GWL_EXSTYLE, $Style) }
    } catch { }
}

<#
Move the window with SetWindowPos instead of WPF's Window.Left/Top.

Why: assigning Left/Top goes through the WPF property system (layout
invalidation + a full measure/arrange pass) on every mouse move, which is what
made dragging feel laggy. SetWindowPos is a single native call.
Coordinates are PHYSICAL pixels, so the caller converts with $script:DpiX.

NOTE: PowerShell has no C-style block comments; block comments are delimited by
angle-bracket-hash, and they do NOT nest -- which is why this file avoids
C-style doc comment syntax entirely.
#>
function Move-WindowPhysical {
    param([int]$X, [int]$Y)
    if (-not $script:Win32Ready) {
        $window.Left = $X / $script:DpiX
        $window.Top = $Y / $script:DpiY
        return
    }
    $h = Get-Hwnd
    if ($h -eq [IntPtr]::Zero) { return }
    try {
        [void][PetWin32]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, 0, 0, ($SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE))
    } catch { }
}

# ---------------------------------------------------------------- http
function Invoke-PetJson {
    param([string]$Url, [int]$TimeoutMs = 1500)
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.Proxy = $null
    $req.KeepAlive = $false
    $resp = $req.GetResponse()
    try {
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        $sr.Close()
    } finally { $resp.Close() }
    if (-not $text) { return $null }
    return ($text | ConvertFrom-Json)
}

function Send-PetJson {
    param([string]$Url, [string]$Json, [int]$TimeoutMs = 2500)
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = 'POST'
        $req.ContentType = 'application/json; charset=utf-8'
        $req.Timeout = $TimeoutMs
        $req.ReadWriteTimeout = $TimeoutMs
        $req.Proxy = $null
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
        $req.ContentLength = $bytes.Length
        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------- state file
$script:StateFile = ''
if ($script:LogPath) { $script:StateFile = Join-Path (Split-Path -Parent $script:LogPath) 'desktop-pet.json' }

$script:Prefs = @{ petId = ''; size = 0; left = -1; top = -1; topmost = $true }
if ($script:StateFile -and (Test-Path -LiteralPath $script:StateFile)) {
    try {
        $j = (Get-Content -LiteralPath $script:StateFile -Raw -Encoding UTF8) | ConvertFrom-Json
        foreach ($p in $j.PSObject.Properties) { $script:Prefs[$p.Name] = $p.Value }
    } catch { }
}

function Save-Prefs {
    if (-not $script:StateFile) { return }
    try {
        $json = $script:Prefs | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($script:StateFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# ---------------------------------------------------------------- ui xaml
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ResizeMode="NoResize"
        Width="140" Height="152" Title="DSH Pet" UseLayoutRounding="True"
        SnapsToDevicePixels="True">
  <Grid x:Name="Root">
    <!-- The sprite is an Image whose Source is a CroppedBitmap (created in code),
         NOT a Rectangle + ImageBrush.

         Two traps this avoids, both of which silently ruin the pet:

         1. x:Name on a Freezable (a Brush) does not register in the XAML
            namescope, so FindName('Brush') returns $null and every Viewbox
            assignment fails silently (blank window).

         2. ImageBrush.Viewbox in Absolute units is measured in the source
            image's DIP size, and DIP = pixels * 96 / DPI. An atlas PNG carrying
            a non-96 DPI (ours came out of a WebP with density 25.4) is treated
            as 5805 DIP wide, so Viewbox=(0,0,192,208) frames only the top-left
            3 percent: the sprite is blown up enormously and the body is cut
            off. CroppedBitmap.SourceRect is in PIXELS, so it is immune to that
            metadata. Verified in scripts/rtb-probe.mjs. -->
    <Image x:Name="Sprite" HorizontalAlignment="Center" VerticalAlignment="Center"
           Width="140" Height="152" Stretch="Fill"/>
    <Popup x:Name="Tip" Placement="Top" AllowsTransparency="True" StaysOpen="True"
           PopupAnimation="Fade" VerticalOffset="-8" HorizontalOffset="0">
      <Border Background="#F7FFFFFF" CornerRadius="10" Padding="12,9"
              BorderBrush="#22000000" BorderThickness="1">
        <Border.Effect>
          <DropShadowEffect BlurRadius="16" ShadowDepth="2" Direction="270" Opacity="0.30" Color="#000000"/>
        </Border.Effect>
        <StackPanel MinWidth="196" MaxWidth="380">
          <TextBlock x:Name="TipHead" FontSize="12.5" FontWeight="SemiBold" Foreground="#161A23" TextWrapping="Wrap"/>
          <TextBlock x:Name="TipWs" FontSize="12" Foreground="#39415A" Margin="0,6,0,0" TextWrapping="Wrap"/>
          <TextBlock x:Name="TipConv" FontSize="12" Foreground="#39415A" Margin="0,3,0,0" TextWrapping="Wrap"/>
          <TextBlock x:Name="TipHint" FontSize="10.5" Foreground="#7C8496" Margin="0,7,0,0" TextWrapping="Wrap"/>
        </StackPanel>
      </Border>
    </Popup>
    <Popup x:Name="Bubble" Placement="Top" AllowsTransparency="True" StaysOpen="True"
           PopupAnimation="Fade" VerticalOffset="-10">
      <Border Background="#FFFFFF" CornerRadius="12" Padding="10,6"
              BorderBrush="#1F000000" BorderThickness="1">
        <Border.Effect>
          <DropShadowEffect BlurRadius="12" ShadowDepth="2" Direction="270" Opacity="0.26" Color="#000000"/>
        </Border.Effect>
        <StackPanel MaxWidth="300">
          <TextBlock x:Name="BubbleText" FontSize="13" Foreground="#1B1F2A" TextWrapping="Wrap"/>
          <TextBlock x:Name="BubbleSub" FontSize="10" Foreground="#8891A3" Margin="0,3,0,0" TextWrapping="Wrap"/>
        </StackPanel>
      </Border>
    </Popup>
  </Grid>
</Window>
'@

try {
    $window = [Windows.Markup.XamlReader]::Parse($xaml)
} catch {
    Write-Log ('XAML parse failed: ' + $_.Exception.Message)
    exit 1
}

$sprite = $window.FindName('Sprite')
$tip = $window.FindName('Tip')
$tipHead = $window.FindName('TipHead')
$tipWs = $window.FindName('TipWs')
$tipConv = $window.FindName('TipConv')
$tipHint = $window.FindName('TipHint')
$bubble = $window.FindName('Bubble')
$bubbleText = $window.FindName('BubbleText')
$bubbleSub = $window.FindName('BubbleSub')

if (-not $sprite) {
    Write-Log 'FATAL: could not resolve the Sprite element from XAML'
    exit 1
}

# No brush here on purpose: the sprite is an Image driven by CroppedBitmap.
# See the XAML comment for the DPI trap that makes ImageBrush unfit for this.
$script:CellCache = @{}
# Reused by the drag hot path and the hit test, so no struct is allocated per
# mouse-move event.
$script:CursorPt = New-Object PetWin32+POINT

# Bitmap for one cell, cropped in PIXELS so the atlas DPI metadata cannot
# distort it (see the XAML comment for the trap this avoids).
function Get-CellBitmap {
    param([int]$Row, [int]$Col)
    if (-not $script:Atlas) { return $null }
    $key = "$Row/$Col"
    if ($script:CellCache.ContainsKey($key)) { return $script:CellCache[$key] }
    try {
        $cb = New-Object System.Windows.Media.Imaging.CroppedBitmap
        $cb.BeginInit()
        $cb.Source = $script:Atlas
        $cb.SourceRect = New-Object System.Windows.Int32Rect(
            ($Col * $script:CellW), ($Row * $script:CellH), $script:CellW, $script:CellH)
        $cb.EndInit()
        try { if (-not $cb.IsFrozen -and $cb.CanFreeze) { $cb.Freeze() } } catch { }
        $script:CellCache[$key] = $cb
        return $cb
    } catch {
        $msg = 'CroppedBitmap failed: ' + $_.Exception.Message
        if ($script:LastSpriteError -ne $msg) { $script:LastSpriteError = $msg; Write-Log $msg }
        return $null
    }
}

# Alpha bytes for ONE atlas cell, cached by "row/col".
#
# Why per-cell: this used to copy the ENTIRE atlas into one byte[] at load time.
# That is survivable for the built-in 1536x2288 sheet (~14 MB) and completely
# unacceptable for the high-resolution sheets authors may now ship -- a
# 4096x5632 atlas would allocate ~92 MB on the UI thread before the window even
# appears. Cropping the current cell first means we copy a few hundred KB at
# worst, and high-resolution art stops being a memory problem.
#
# Returns $null when the cell has no usable mask; hit-testing then falls back to
# treating the whole cell as solid (never refuses clicks).
function Get-CellAlpha {
    param([int]$Row, [int]$Col)
    if (-not $script:Atlas) { return $null }
    if ($script:CellW -le 0 -or $script:CellH -le 0) { return $null }
    $key = "$Row/$Col"
    if ($script:CellAlpha.ContainsKey($key)) { return $script:CellAlpha[$key] }
    try {
        $src = Get-CellBitmap $Row $Col
        if (-not $src) { return $null }
        $conv = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap
        $conv.BeginInit()
        $conv.Source = $src
        $conv.DestinationFormat = [System.Windows.Media.PixelFormats]::Bgra32
        $conv.EndInit()
        try { if (-not $conv.IsFrozen -and $conv.CanFreeze) { $conv.Freeze() } } catch { }
        $stride = $conv.PixelWidth * 4
        $buf = New-Object 'byte[]' ($stride * $conv.PixelHeight)
        $conv.CopyPixels($buf, $stride, 0)
        $cell = @{
            Pixels = $buf
            Stride = $stride
            W      = $conv.PixelWidth
            H      = $conv.PixelHeight
        }
        # An animation cycles through cells forever, so bound the cache. Clearing
        # wholesale is fine: it is rebuilt in a few milliseconds.
        if ($script:CellAlpha.Count -ge $script:CellAlphaMax) { $script:CellAlpha = @{} }
        $script:CellAlpha[$key] = $cell
        return $cell
    } catch {
        $msg = 'alpha mask failed: ' + $_.Exception.Message
        if ($script:LastSpriteError -ne $msg) { $script:LastSpriteError = $msg; Write-Log $msg }
        return $null
    }
}

# ---------------------------------------------------------------- animation data
$script:Pet = $null              # current pet view
$script:Atlas = $null            # BitmapImage (shared, frozen)
$script:Cols = 8
$script:Rows = 11
# Native (authoring) resolution of one atlas cell. This is NOT a limit: authors
# may ship any cell size, and the window is scaled to the chosen display size.
$script:CellW = 192
$script:CellH = 208
# Per-cell BGRA32 alpha for click-through hit-testing, keyed "row/col".
# Deliberately per-cell rather than one atlas-wide buffer -- see Get-CellAlpha.
$script:CellAlpha = @{}
$script:CellAlphaMax = 24
$script:FrameIdx = 0
$script:FrameAcc = 0
$script:Anim = 'idle'
$script:Mode = 'idle'
$script:Clicks = @()
$script:Diving = 0
$script:Hovering = $false
# Consecutive hover ticks where the pixel under the cursor was transparent. The
# idle animation swaps silhouettes, so without this the tooltip blinked.
$script:HoverMissTicks = 0
$script:Dragging = $false
# True while this window holds the mouse capture for a drag (see the
# MouseLeftButtonDown handler): capture is what keeps a fast flick from
# outrunning the window and silently killing the drag.
$script:GotCapture = $false
# Set while we drop the capture ourselves, so LostMouseCapture does not mistake
# our own release for the OS taking it away mid-drag.
$script:ReleasingCapture = $false
$script:ClickThrough = $false
# Set by the "hide this pet" menu item: close the window a couple of seconds
# later so the confirmation bubble is actually visible.
$script:HideAtTicks = 0
# Deferred double-click action ("open Edge"), so a triple click can still win.
$script:PendingOpenTicks = 0
$script:FailStreak = 0
$script:HostState = $null
$script:AudioCache = @{}

# local override animation (dive easter egg / drag) wins over host mode briefly
# (hoisted to script scope: building this hashtable inside the 30fps tick was
#  pure garbage churn)
$script:ModeAnimMap = @{
    working     = 'running'
    review      = 'review'
    waiting     = 'waiting'
    failed      = 'failed'
    celebrating = 'jumping'
}

function Resolve-Anim {
    # Mirrors the web client's resolveAnim() line by line:
    #   if (dragging) return dragDir || "running";
    #   if (diving) return "failed";
    #   if (hover && hasLook) return "look";
    #   if (hostMode && hostMode !== "idle") return HOST_ANIM[hostMode] || "idle";
    #   return pet.behavior || "idle";
    if ($script:Dragging) { if ($script:DragDir) { return $script:DragDir } return 'running' }
    if ($script:Diving -gt 0) { return 'failed' }
    $spec = Get-StateSpec 'look'
    $hasLook = $false
    if ($script:Pet -and $script:Pet.states -and $script:Pet.states.look) {
        $lk = $script:Pet.states.look
        if ($lk.angles -or $lk.rows) { $hasLook = $true }
    }
    if ($script:Hovering -and $hasLook) { return 'look' }
    if ($script:Mode -and $script:Mode -ne 'idle') {
        $m = $script:ModeAnimMap[$script:Mode]
        if ($m) { return $m }
    }
    if ($script:Pet -and $script:Pet.behavior) { return [string]$script:Pet.behavior }
    return 'idle'
}

function Get-StateSpec {
    param([string]$Name)
    if (-not $script:Pet) { return $null }
    $st = $script:Pet.states
    if (-not $st) { return $null }
    $spec = $st.$Name
    if (-not $spec) { $spec = $st.idle }
    return $spec
}

function Update-Sprite {
    try {
        if (-not $script:Atlas) { return }
        $spec = Get-StateSpec $script:Anim
        if (-not $spec) { return }
        $row = $script:CellRow
        $col = 0

        if ($script:Anim -eq 'look') {
            # Mirrors the look branch of the web client's resolveCell():
            #   angles form (3D): map the direction onto one of N rendered angles
            #   rows form (2D): lookDir<8 -> row[0] col lookDir, else row[1] col lookDir-8
            #   otherwise fall back to the idle first frame. look never animates.
            $lk = $null
            if ($script:Pet -and $script:Pet.states) { $lk = $script:Pet.states.look }
            $dir = ((($script:LookDir % 16) + 16) % 16)
            if ($lk -and $lk.angles -and @($lk.angles).Count -gt 0) {
                $angles = @($lk.angles)
                $idx = [int][Math]::Round($dir / 16.0 * $angles.Count) % $angles.Count
                $row = [int]$angles[$idx].row
                $col = [int]$angles[$idx].col
            } elseif ($lk -and $lk.rows -and @($lk.rows).Count -ge 2) {
                $rows2 = @($lk.rows)
                if ($dir -lt 8) { $row = [int]$rows2[0]; $col = $dir }
                else { $row = [int]$rows2[1]; $col = $dir - 8 }
            } else {
                $idle = Get-StateSpec 'idle'
                $row = 0
                if ($idle -and $idle.row -ne $null) { $row = [int]$idle.row }
                $col = 0
            }
        } else {
            if ($spec.row -ne $null) { $row = [int]$spec.row }
            $frames = [Math]::Max(1, [int](Get-WebFrameCount $spec))
            $col = $script:FrameIdx % $frames
        }

        $script:CellRow = $row
        $script:CellCol = $col
        $src = Get-CellBitmap $row $col
        if ($src) { $sprite.Source = $src }
    } catch {
        # A broken tick must never kill the pet; log once per unique message.
        $msg = 'Update-Sprite failed: ' + $_.Exception.Message
        if ($script:LastSpriteError -ne $msg) {
            $script:LastSpriteError = $msg
            Write-Log $msg
        }
    }
}

$script:CellRow = 0
$script:CellCol = 0
# Cursor direction 0..15 (0 = straight up, clockwise), derived from the cursor
# position exactly like the web does. The look rows are chosen with it, so it
$script:LookDir = 0
$script:AppliedLookDir = -1
# Drag direction (web uses runRight / runLeft / running)
$script:DragDir = 'running'

# ---------------------------------------------------------------- audio
function Play-Sound {
    param([string]$Key)
    if (-not $script:Pet) { return }
    $entry = $null
    if ($script:Pet.audio) { $entry = $script:Pet.audio.$Key }
    if (-not $entry -or -not $entry.url) { return }
    try {
        $player = $null
        if ($script:AudioCache.ContainsKey($Key)) { $player = $script:AudioCache[$Key] }
        if (-not $player) {
            $player = New-Object System.Windows.Media.MediaPlayer
            $player.Open((New-Object System.Uri(($Base + $entry.url))))
            $script:AudioCache[$Key] = $player
        }
        $player.Stop()
        $player.Position = [TimeSpan]::Zero
        $player.Play()
    } catch {
        Write-Log ('audio failed for ' + $Key + ': ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------- pet loading
function Load-Pet {
    param($View)
    if (-not $View) { return $false }
    $url = $null
    if ($View.sheet) {
        if ($View.sheet.desktopUrl) { $url = $Base + $View.sheet.desktopUrl }
        elseif ($View.sheet.url) { $url = $Base + $View.sheet.url }
    }
    if (-not $url) {
        Write-Log ('pet ' + $View.id + ' has no sheet url')
        return $false
    }
    try {
        # Download the bytes ourselves and decode from a MemoryStream.
        # BitmapImage.UriSource + CacheOption.OnLoad reports PixelWidth/Height = 1
        # on some WIC/codec combinations (it ends up decoding lazily while the
        # sprite brush silently shows nothing), so never rely on it here.
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Method = 'GET'
        $req.Timeout = 20000
        $req.ReadWriteTimeout = 20000
        $req.Proxy = $null
        $resp = $req.GetResponse()
        $ms = New-Object System.IO.MemoryStream
        try {
            $resp.GetResponseStream().CopyTo($ms)
        } finally { $resp.Close() }
        $len = $ms.Length
        if ($len -le 64) {
            Write-Log ('atlas download too small (' + $len + ' bytes): ' + $url)
            return $false
        }
        $ms.Position = 0
        $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
        $bmp.BeginInit()
        $bmp.StreamSource = $ms
        $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bmp.EndInit()
        try { if (-not $bmp.IsFrozen -and $bmp.CanFreeze) { $bmp.Freeze() } } catch { }
        if ($bmp.PixelWidth -le 1 -or $bmp.PixelHeight -le 1) {
            Write-Log ('atlas decoded to ' + $bmp.PixelWidth + 'x' + $bmp.PixelHeight + ' from ' + $len + ' bytes: ' + $url)
            return $false
        }
        Write-Log ('atlas fetched: ' + $len + ' bytes -> ' + $bmp.PixelWidth + 'x' + $bmp.PixelHeight)
    } catch {
        Write-Log ('atlas load failed (' + $url + '): ' + $_.Exception.Message)
        return $false
    }

    $script:Pet = $View
    $script:Atlas = $bmp
    $script:Cols = [int]$View.sheet.cols
    $script:Rows = [int]$View.sheet.rows
    $script:CellW = [int]$View.sheet.cellW
    $script:CellH = [int]$View.sheet.cellH
    # A new atlas invalidates the per-cell caches (else the old pet keeps drawing)
    $script:CellCache = @{}
    $script:CellAlpha = @{}
    $script:AudioCache = @{}

    # Scaling quality.
    #
    # Photoreal or high-resolution art that gets shrunk to the window needs a
    # real resampler, or it comes out aliased and noisy. Pixel art wants the
    # exact opposite (hard edges, no blur). The author knows which one their
    # sheet is, so sheet.scaling decides; "smooth" is the safe default.
    try {
        $scaling = 'smooth'
        if ($View.sheet.scaling) { $scaling = ([string]$View.sheet.scaling).ToLowerInvariant() }
        $mode = [System.Windows.Media.BitmapScalingMode]::HighQuality
        if ($scaling -eq 'pixelated' -or $scaling -eq 'nearest' -or $scaling -eq 'nearestneighbor') {
            $mode = [System.Windows.Media.BitmapScalingMode]::NearestNeighbor
        }
        [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($sprite, $mode)
        Write-Log ('scaling mode: ' + $mode.ToString() + ' (sheet.scaling=' + $scaling + ')')
    } catch {
        Write-Log ('scaling mode setup failed: ' + $_.Exception.Message)
    }

    Apply-Size
    Update-Sprite
    Write-Log ('loaded pet ' + $View.id + ' (' + $View.name + ') atlas ' + $bmp.PixelWidth + 'x' + $bmp.PixelHeight + ' cell ' + $script:CellW + 'x' + $script:CellH)
    return $true
}

# Display size limits.
#
# The pet is drawn at this many DEVICE-INDEPENDENT PIXELS wide; the sheet is
# scaled to fit. These bounds are only a sanity guard -- the point of the wide
# range is that a photoreal sheet authored at, say, 1024px per cell can actually
# be shown large instead of being squashed into a 320px thumbnail.
$script:SizeMin = 32
$script:SizeMax = 1024

function Limit-Size {
    param([int]$Value)
    $v = [int]$Value
    if ($v -lt $script:SizeMin) { $v = $script:SizeMin }
    if ($v -gt $script:SizeMax) { $v = $script:SizeMax }
    return $v
}

# What "auto" resolves to: the sheet's native resolution, halved.
#
# Authors are asked to draw at 2x the intended display size (the usual HiDPI
# convention). That reproduces the built-in pet exactly -- a 192px cell shows at
# 96 DIP -- and it means a detailed/photoreal sheet comes up at a size that suits
# its detail instead of a fixed 96px postage stamp. Only used when no explicit
# size has been chosen; an explicit choice always wins.
function Get-NativeSize {
    if ($script:CellW -gt 0) { return [int][Math]::Round($script:CellW / 2.0) }
    return 96
}

function Get-DesktopSize {
    # Precedence: explicit choice remembered locally (also where the host pushes
    # /settings) > -Size from the host at launch > the pet's own desktopSize >
    # derived from the sheet's native resolution.
    #
    # NOTE: pet.size is deliberately NOT in this chain. That field is the WEB
    # size in CSS pixels (the client does size || pet.size || 120), and it has
    # nothing to do with how big the desktop window should be. Feeding it in
    # meant that as soon as the host stopped passing -Size (i.e. "auto"), the
    # desktop window silently picked up the web value -- 120 DIP for a pet whose
    # sheet said it should be 512.
    $s = 0
    if ($script:Prefs.size -gt 0) { $s = [int]$script:Prefs.size }
    elseif ($Size -gt 0) { $s = [int]$Size }
    elseif ($script:Pet -and $script:Pet.desktopSize) { $s = [int]$script:Pet.desktopSize }
    if ($s -le 0) { $s = Get-NativeSize }
    return (Limit-Size $s)
}

# Resize: apply locally right away AND report it back to the host, so the web
# slider follows and the size survives a restart. Does NOT restart the window,
# which keeps mouse-wheel resizing continuous.
#
# Value 0 means "auto": forget the explicit size so Get-DesktopSize goes back to
# following the sheet's native resolution. Without this there was no way back
# from a manual size, and switching to a much higher-resolution pet kept the old
# tiny size forever.
#
# (PowerShell has no C-style doc comments; block comments are angle-bracket-hash
#  pairs and they do not nest. Keep this file pure ASCII too.)
function Set-DesktopSize {
    param([int]$Value)
    if ($Value -le 0) {
        $script:Prefs.size = 0
        $script:HostDesktopSize = 0
        $script:LocalSizeTicks = [DateTime]::UtcNow.Ticks
        Save-Prefs
        Apply-Size
        Update-Sprite
        Clamp-ToWorkArea
        Save-Position
        Write-Log ('size -> auto (' + (Get-DesktopSize) + ' DIP, from cell ' + $script:CellW + 'px)')
        Send-PetJson ($Base + '/ronaldo-pet/settings') (ConvertTo-Json -Compress @{ patch = @{ desktopSize = 0 } })
        return
    }
    $v = Limit-Size $Value
    $script:Prefs.size = $v
    $script:HostDesktopSize = $v
    $script:LocalSizeTicks = [DateTime]::UtcNow.Ticks
    Save-Prefs
    # Apply-Size is what actually resizes the window. This used to call
    # Update-Sprite, which only swaps the atlas cell -- so the wheel and the
    # menu size items changed the stored size and nothing visibly happened.
    Apply-Size
    Update-Sprite
    # Growing near the bottom-right corner can push it off screen
    Clamp-ToWorkArea
    Save-Position
    Send-PetJson ($Base + '/ronaldo-pet/settings') (ConvertTo-Json -Compress @{ patch = @{ desktopSize = $v } })
}

function Apply-Size {
    $s = Get-DesktopSize
    $w = $s
    $h = [int][Math]::Round($s * $script:CellH / $script:CellW)
    $sprite.Width = $w
    $sprite.Height = $h
    $window.Width = $w
    $window.Height = $h
}

# ---------------------------------------------------------------- positioning
#
# DPI NOTE (a real bug we hit -- read before touching any coordinate math):
#   This machine runs at 200% scaling (GetDpiForWindow = 192). WPF's
#   Window.Left/Top are DEVICE-INDEPENDENT PIXELS, while GetCursorPos /
#   GetWindowRect / SetWindowPos all share ONE Win32 coordinate space. Mixing
#   the two produces: the window drifting while dragged, a visible jump on
#   mouse-up, and a saved position that restores to the wrong spot.
#
#   The rule here is: use the Win32 space for EVERYTHING.
#     - move / drag / clamp -> SetWindowPos + GetWindowRect + Screen.WorkingArea
#     - saved positions are Win32 pixels too (tagged with posUnit; untagged
#       legacy records are ignored rather than restoring a wrong spot)
#     - WPF Left/Top are read at most once, never as a coordinate source
#
#   The Chinese write-up of this bug lives in desktop/README.md.
#
$script:Positioned = $false

function Get-PhysicalWorkArea {
    try {
        $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        return @{ x = $wa.Left; y = $wa.Top; w = $wa.Width; h = $wa.Height }
    } catch {
        return @{ x = 0; y = 0; w = 1440; h = 900 }
    }
}

function Get-WindowBox {
    $h = Get-Hwnd
    if ($h -eq [IntPtr]::Zero -or -not $script:Win32Ready) { return $null }
    try {
        $rc = New-Object PetWin32+RECT
        if (-not [PetWin32]::GetWindowRect($h, [ref]$rc)) { return $null }
        return @{ x = $rc.Left; y = $rc.Top; w = ($rc.Right - $rc.Left); h = ($rc.Bottom - $rc.Top) }
    } catch { return $null }
}

function Clamp-ToWorkArea {
    $box = Get-WindowBox
    if (-not $box) { return }
    $wa = Get-PhysicalWorkArea
    $x = $box.x
    $y = $box.y
    # Keep at least 48px of the pet reachable on every side.
    if ($x -lt ($wa.x - $box.w + 48)) { $x = $wa.x - $box.w + 48 }
    if ($x -gt ($wa.x + $wa.w - 48)) { $x = $wa.x + $wa.w - 48 }
    if ($y -lt $wa.y) { $y = $wa.y }
    if ($y -gt ($wa.y + $wa.h - 48)) { $y = $wa.y + $wa.h - 48 }
    if ($x -ne $box.x -or $y -ne $box.y) { Move-WindowPhysical $x $y }
}

function Default-Position {
    $wa = Get-PhysicalWorkArea
    $box = Get-WindowBox
    $w = 140
    $h = 152
    if ($box) { $w = $box.w; $h = $box.h }
    Move-WindowPhysical ($wa.x + $wa.w - $w - 24) ($wa.y + $wa.h - $h - 16)
}

function Save-Position {
    $box = Get-WindowBox
    if (-not $box) { return }
    $script:Prefs.posUnit = 'physical'
    $script:Prefs.left = [int]$box.x
    $script:Prefs.top = [int]$box.y
    Save-Prefs
}

# ---------------------------------------------------------------------------
# Operate the pet from the desktop, exactly like the web settings panel does.
#
# Every one of these writes through to the host (/ronaldo-pet/pets/update), so
# the web panel shows the same value and it survives a restart. That is the whole
# point: the desktop window should be a first-class way to manage the pet, not a
# read-only mirror of it.
# ---------------------------------------------------------------------------
function Send-PetUpdate {
    param($Patch)
    if (-not $script:Pet) { return }
    $body = ConvertTo-Json -Compress -Depth 4 @{ id = $script:Pet.id; patch = $Patch }
    Send-PetJson ($Base + '/ronaldo-pet/pets/update') $body
}

function Set-PetBehavior {
    param([string]$Value)
    if (-not $script:Pet) { return }
    $script:Pet.behavior = $Value
    Send-PetUpdate @{ behavior = $Value }
    # Take effect at once: clear the cached animation so the resolve tick re-picks it
    $script:Anim = ''
    Update-Sprite
    Sync-AnimTimer
    Show-Bubble ((T 'bubble.behavior' 'Behavior: ') + (T ('behavior.' + $Value) $Value)) ''
    Write-Log ('behavior -> ' + $Value)
}

function Toggle-PetSound {
    if (-not $script:Pet) { return }
    $script:Pet.sound = -not ($script:Pet.sound -ne $false)
    Send-PetUpdate @{ sound = $script:Pet.sound }
    if ($script:Pet.sound) { Show-Bubble (T 'bubble.soundOn' 'Sound on') '' }
    else { Show-Bubble (T 'bubble.soundOff' 'Sound off') '' }
    Write-Log ('sound -> ' + $script:Pet.sound)
}

function Hide-Pet {
    if (-not $script:Pet) { return }
    Send-PetUpdate @{ visible = $false }
    Show-Bubble (T 'bubble.hidden' 'Hidden') ''
    Write-Log 'hidden by desktop menu'
    # Let the bubble be readable for a moment, then close. Restore via the web panel.
    $script:HideAtTicks = [DateTime]::UtcNow.Ticks + 14000000
}

function Make-PetDefault {
    # Same action as the star button in the web settings panel: this pet becomes
    # the one that opens by default, and the others stop launching.
    if (-not $script:Pet) { return }
    Send-PetUpdate @{ makeDefault = $true }
    $script:DefaultPetId = [string]$script:Pet.id
    Show-Bubble (T 'bubble.setDefault' 'Default pet set') ''
    Write-Log ('make default -> ' + $script:Pet.id)
}

# ---------------------------------------------------------------- menu
function Resolve-Edge {
    foreach ($p in @(
            (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
        )) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

function Open-HarnessPage {
    $url = $Base
    if ($script:HostState -and $script:HostState.webUrl) { $url = [string]$script:HostState.webUrl }
    $edge = Resolve-Edge
    try {
        if ($edge) {
            Start-Process -FilePath $edge -ArgumentList @($url) | Out-Null
            Write-Log ('opened Edge: ' + $url + ' via ' + $edge)
        } else {
            Start-Process $url | Out-Null
            Write-Log ('msedge.exe not found, opened default browser: ' + $url)
        }
        Show-Bubble (T 'bubble.opening' 'Opening Harness...') ''
    } catch {
        Write-Log ('open page failed: ' + $_.Exception.Message)
        Show-Bubble ((T 'bubble.openFailed' 'Could not open the browser') + ' ' + $_.Exception.Message) ''
    }
}

function Show-Bubble {
    param([string]$Text, [string]$Sub)
    $bubbleText.Text = $Text
    if ($Sub) { $bubbleSub.Text = $Sub; $bubbleSub.Visibility = 'Visible' } else { $bubbleSub.Text = ''; $bubbleSub.Visibility = 'Collapsed' }
    $bubble.PlacementTarget = $sprite
    $bubble.IsOpen = $true
    if ($script:BubbleTimer) { $script:BubbleTimer.Stop() }
    $script:BubbleTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:BubbleTimer.Interval = [TimeSpan]::FromMilliseconds(2600)
    $script:BubbleTimer.Add_Tick({
            $script:BubbleTimer.Stop()
            $bubble.IsOpen = $false
        })
    $script:BubbleTimer.Start()
}

function Build-Menu {
    $menu = New-Object System.Windows.Controls.ContextMenu

    $mi = New-Object System.Windows.Controls.MenuItem
    $mi.Header = (T 'menu.openPage' 'Open Harness page (Edge)')
    $mi.FontWeight = 'SemiBold'
    $mi.Add_Click({ Open-HarnessPage })
    [void]$menu.Items.Add($mi)

    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

    # pet switcher
    $pets = @($script:PetsCache)
    if ($pets.Count -gt 0) {
        $sw = New-Object System.Windows.Controls.MenuItem
        $sw.Header = (T 'menu.switchPet' 'Switch pet')
        foreach ($p in $pets) {
            if ($p.broken) { continue }
            $item = New-Object System.Windows.Controls.MenuItem
            $item.Header = [string]$p.name
            $item.IsCheckable = $true
            if ($script:Pet -and $script:Pet.id -eq $p.id) { $item.IsChecked = $true }
            $item.Tag = $p.id
            $item.Add_Click({
                    param($sender, $e)
                    $script:Prefs.petId = [string]$sender.Tag
                    Save-Prefs
                    Apply-PetSelection
                })
            [void]$sw.Items.Add($item)
        }
        [void]$menu.Items.Add($sw)
    }

    # behavior -- the same 10 options the web settings panel offers
    $bh = New-Object System.Windows.Controls.MenuItem
    $bh.Header = (T 'menu.behavior' 'Usual behaviour')
    foreach ($key in @('idle', 'runRight', 'runLeft', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'look')) {
        $item = New-Object System.Windows.Controls.MenuItem
        $item.Header = (T ('behavior.' + $key) $key)
        $item.Tag = $key
        $item.IsCheckable = $true
        if ($script:Pet -and $script:Pet.behavior -eq $key) { $item.IsChecked = $true }
        $item.Add_Click({
                param($sender, $e)
                Set-PetBehavior ([string]$sender.Tag)
            })
        [void]$bh.Items.Add($item)
    }
    [void]$menu.Items.Add($bh)

    # size
    #
    # 0 is the "auto" entry: it forgets the explicit size so the window goes back
    # to following the sheet's native resolution (see Get-NativeSize). The upper
    # entries exist for high-resolution / photoreal sheets, which look wrong at
    # the old 72..200 range.
    $sz = New-Object System.Windows.Controls.MenuItem
    $sz.Header = (T 'menu.size' 'Size')
    $cur = Get-DesktopSize
    $autoNow = ($script:Prefs.size -le 0)
    $autoItem = New-Object System.Windows.Controls.MenuItem
    $autoLabel = (T 'size.auto' 'Auto') + ' (' + $cur + ')'
    $autoItem.Header = $autoLabel
    $autoItem.Tag = 0
    $autoItem.IsCheckable = $true
    $autoItem.IsChecked = $autoNow
    $autoItem.Add_Click({
            param($sender, $e)
            Set-DesktopSize 0
        })
    [void]$sz.Items.Add($autoItem)
    [void]$sz.Items.Add((New-Object System.Windows.Controls.Separator))
    foreach ($pair in @(
            @(64, 'size.tiny'), @(96, 'size.small'), @(140, 'size.medium'),
            @(200, 'size.large'), @(320, 'size.xl'), @(512, 'size.huge'), @(768, 'size.max'))) {
        $item = New-Object System.Windows.Controls.MenuItem
        $item.Header = (T $pair[1] ([string]$pair[0]))
        $item.Tag = [int]$pair[0]
        $item.IsCheckable = $true
        if (-not $autoNow -and $cur -eq [int]$pair[0]) { $item.IsChecked = $true }
        $item.Add_Click({
                param($sender, $e)
                Set-DesktopSize ([int]$sender.Tag)
            })
        [void]$sz.Items.Add($item)
    }
    [void]$menu.Items.Add($sz)

    # sound on/off (same flag the web panel's speaker button toggles)
    $snd = New-Object System.Windows.Controls.MenuItem
    if ($script:Pet -and $script:Pet.sound -eq $false) { $snd.Header = (T 'menu.soundOff' 'Sound: off') }
    else { $snd.Header = (T 'menu.soundOn' 'Sound: on') }
    $snd.Add_Click({ Toggle-PetSound })
    [void]$menu.Items.Add($snd)

    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

    $tm = New-Object System.Windows.Controls.MenuItem
    $tm.Header = (T 'menu.topmost' 'Always on top')
    $tm.IsCheckable = $true
    $tm.IsChecked = $true
    $tm.Add_Click({
            param($sender, $e)
            $window.Topmost = [bool]$sender.IsChecked
        })
    [void]$menu.Items.Add($tm)

    $rs = New-Object System.Windows.Controls.MenuItem
    $rs.Header = (T 'menu.resetPos' 'Reset position')
    $rs.Add_Click({
            Default-Position
            Save-Position
        })
    [void]$menu.Items.Add($rs)

    $hd = New-Object System.Windows.Controls.MenuItem
    $hd.Header = (T 'menu.hide' 'Hide this pet')
    $hd.Add_Click({ Hide-Pet })
    [void]$menu.Items.Add($hd)

    $df = New-Object System.Windows.Controls.MenuItem
    $df.Header = (T 'menu.setDefault' 'Set as default pet')
    if ($script:Pet -and $script:DefaultPetId -eq [string]$script:Pet.id) { $df.IsEnabled = $false }
    $df.Add_Click({ Make-PetDefault })
    [void]$menu.Items.Add($df)

    [void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

    $hint = New-Object System.Windows.Controls.MenuItem
    $hint.Header = (T 'menu.hint' 'These settings are shared with the web panel')
    $hint.IsEnabled = $false
    [void]$menu.Items.Add($hint)

    $qt = New-Object System.Windows.Controls.MenuItem
    $qt.Header = (T 'menu.quit' 'Quit desktop pet')
    $qt.Add_Click({
            Save-Prefs
            $tip.IsOpen = $false
            $bubble.IsOpen = $false
            $window.Close()
        })
    [void]$menu.Items.Add($qt)

    return $menu
}

$script:Menu = $null
$script:MenuSignature = ''
# Filled by Poll-State / Poll-Pets. Kept as $null until the first successful poll.
$script:HostState = $null
$script:PetsCache = @()
$script:PetsFailStreak = 0
# Which pet the user marked as "default" in the web settings (settings.defaultPet).
$script:DefaultPetId = ''
# Last desktop size seen from the host (settings.desktopSize) -- used to apply
# web-side slider changes live without restarting the window.
$script:HostDesktopSize = 0
# When we last changed the size ourselves. Set-DesktopSize posts the new value to
# the host, and until that lands an in-flight /pets response still reports the old
# one; the poller ignores host sizes for a short while after this to stop the pet
# snapping back right after a wheel notch.
$script:LocalSizeTicks = 0

# Cheap UI-thread watchdog: only touches the log when a tick actually stalls.
function Test-SlowTick {
    param([string]$Label, [long]$StartTicks)
    if ($SlowTickMs -le 0) { return }
    $ms = ([DateTime]::UtcNow.Ticks - $StartTicks) / 10000.0
    if ($ms -ge $SlowTickMs) {
        Write-Log ('SLOW ' + $Label + ' ' + [int]$ms + 'ms')
    }
}

function Apply-PetSelection {
    $pets = @($script:PetsCache)

    $visible = @()
    foreach ($p in $pets) {
        if ($p.broken) { continue }
        if ($p.visible -eq $false) { continue }
        $visible += $p
    }

    $target = $null

    # 1) explicit -PetId on the command line (wins over everything)
    if ($PetId) {
        foreach ($p in $pets) { if ($p.id -eq $PetId) { $target = $p; break } }
    }

    # 2) this machine's own remembered choice, but only while it is still shown.
    if (-not $target -and $script:Prefs.petId) {
        foreach ($p in $visible) { if ($p.id -eq $script:Prefs.petId) { $target = $p; break } }
    }

    # 3) the host's "default pet" -- what the user picked with the star button
    #    in the web settings panel (settings.defaultPet).
    if (-not $target -and $script:DefaultPetId) {
        foreach ($p in $visible) { if ($p.id -eq $script:DefaultPetId) { $target = $p; break } }
    }

    # 4) anything that is currently shown
    if (-not $target -and $visible.Count -gt 0) { $target = $visible[0] }

    # 5) last resort: anything installed at all
    if (-not $target) {
        foreach ($p in $pets) { if (-not $p.broken) { $target = $p; break } }
    }
    if (-not $target) { return }

    if (-not $script:Pet -or $script:Pet.id -ne $target.id) {
        [void](Load-Pet $target)
        $script:Prefs.petId = [string]$target.id
        Save-Prefs
        Write-Log ('selected pet: ' + $target.id + ' (' + [string]$target.name + ')')
    }
}

# ---------------------------------------------------------------- tooltip
function Build-TipText {
    $head = ''
    $ws = ''
    $conv = ''
    $hint = ''

    if ($script:Pet) {
        $head = [string]$script:Pet.name
    }
    $modeLabel = @{
        'idle'        = (T 'mode.idle' 'idle')
        'working'     = (T 'mode.working' 'working')
        'review'      = (T 'mode.review' 'thinking')
        'waiting'     = (T 'mode.waiting' 'waiting for you')
        'failed'      = (T 'mode.failed' 'error')
        'celebrating' = (T 'mode.celebrating' 'done!')
    }
    if ($modeLabel.ContainsKey($script:Mode)) {
        $head = $head + '  -  ' + $modeLabel[$script:Mode]
    }

    $st = $script:HostState
    if ($st -and $st.active) {
        $a = $st.active
        if ($a.workspace) {
            $wt = [string]$a.workspace.title
            if (-not $wt) { $wt = [string]$a.workspace.path }
            $ws = (T 'tip.workspace' 'Workspace') + ': ' + $wt
            if ($a.workspace.path -and $a.workspace.path -ne $wt) { $ws = $ws + '   (' + $a.workspace.path + ')' }
        } else {
            $ws = (T 'tip.workspace' 'Workspace') + ': ' + (T 'tip.unknown' '(unknown)')
        }
        $ct = [string]$a.title
        if (-not $ct) { $ct = T 'tip.untitled' '(untitled conversation)' }
        $conv = (T 'tip.conversation' 'Conversation') + ': ' + $ct
    } else {
        $conv = T 'tip.noConversation' 'No active conversation'
    }

    $running = 0
    if ($st -and $st.runningCount) { $running = [int]$st.runningCount }
    if ($running -gt 1) {
        $hint = (T 'tip.moreRunning' 'Running') + ': ' + $running
    } else {
        $hint = T 'tip.hint' 'Double-click to open Edge  |  Right-click for menu'
    }
    return @{ head = $head; ws = $ws; conv = $conv; hint = $hint }
}

function Refresh-Tip {
    if (-not $tip.IsOpen) { return }
    $t = Build-TipText
    $tipHead.Text = $t.head
    $tipWs.Text = $t.ws
    $tipConv.Text = $t.conv
    $tipHint.Text = $t.hint
}

# ---------------------------------------------------------------- polling
#
# Why the HTTP is ASYNC here: the web client polls with fetch(), which never
# blocks rendering. The first version of this file polled with a synchronous
# HttpWebRequest from a DispatcherTimer -- i.e. on the UI thread -- twice a
# second. Even at 10-30ms per call that is a visible hitch in the animation,
# and if the host stalls, the whole pet freezes for the timeout. That is the
# "much laggier than the web version" complaint.
#
# BeginGetResponse/EndGetResponse gives us async without needing a PowerShell
# callback on a foreign thread (scriptblock delegates cannot run there): the UI
# timer only asks whether the request has completed, and a completed request
# returns instantly.
$script:AnimTimer = $null
$script:PollTimer = $null
$script:HitTimer = $null
$script:BubbleTimer = $null

$script:Http = @{
    stateReq = $null; stateIar = $null; stateStarted = 0; stateDone = 0
    petsReq = $null; petsIar = $null; petsStarted = 0; petsDone = 0
}

function New-PetRequest {
    param([string]$Url, [int]$TimeoutMs)
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.Proxy = $null
    $req.KeepAlive = $true
    $req.Headers.Add('Cache-Control', 'no-store')
    return $req
}

# Returns $true when this call actually produced new data (parsed into $script:LastJson)
function Complete-PetRequest {
    param([string]$Kind)
    $h = $script:Http
    $req = $h.($Kind + 'Req')
    $iar = $h.($Kind + 'Iar')
    if (-not $req -or -not $iar) { return $false }
    try {
        if (-not $iar.IsCompleted) { return $false }
        $resp = $req.EndGetResponse($iar)
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        $sr.Close(); $resp.Close()
        $h.($Kind + 'Req') = $null
        $h.($Kind + 'Iar') = $null
        $h.($Kind + 'Done') = [DateTime]::UtcNow.Ticks
        if (-not $text) { return $false }
        $script:LastJson = ($text | ConvertFrom-Json)
        return $true
    } catch {
        $h.($Kind + 'Req') = $null
        $h.($Kind + 'Iar') = $null
        $h.($Kind + 'Done') = [DateTime]::UtcNow.Ticks
        throw
    }
}

function Start-PetRequest {
    param([string]$Kind, [string]$Path, [int]$TimeoutMs)
    $h = $script:Http
    if ($h.($Kind + 'Iar')) { return }
    # Wait at least this long after the previous one finished (matches the web poll rate)
    $minGap = if ($Kind -eq 'state') { 450 } else { 3800 }
    if ($h.($Kind + 'Done') -gt 0) {
        $since = ([DateTime]::UtcNow.Ticks - $h.($Kind + 'Done')) / 10000.0
        if ($since -lt $minGap) { return }
    }
    try {
        $req = New-PetRequest ($Base + $Path) $TimeoutMs
        $h.($Kind + 'Req') = $req
        $h.($Kind + 'Started') = [DateTime]::UtcNow.Ticks
        $h.($Kind + 'Iar') = $req.BeginGetResponse($null, $null)
    } catch {
        $h.($Kind + 'Req') = $null
        $h.($Kind + 'Iar') = $null
    }
}

function Poll-State {
    # 1) Did the previous async request land? EndGetResponse on a completed one returns at once.
    try {
        if (Complete-PetRequest 'state') {
            $st = $script:LastJson
            $script:FailStreak = 0
            if ($st) {
                if ($st.mode) { $script:Mode = [string]$st.mode }
                $script:HostState = $st
            }
        }
    } catch {
        $script:FailStreak = $script:FailStreak + 1
        if ($script:FailStreak -eq 3) { Write-Log ('state poll failing: ' + $_.Exception.Message) }
        if ($script:FailStreak -ge 30) {
            Write-Log 'host unreachable for ~15s, exiting'
            Save-Prefs
            $window.Close()
            return
        }
    }
    # 2) Timeout guard: a request that never settles counts as a failure
    $h = $script:Http
    if ($h.stateIar) {
        $elapsed = ([DateTime]::UtcNow.Ticks - $h.stateStarted) / 10000.0
        if ($elapsed -gt 3000) {
            try { $h.stateReq.Abort() } catch { }
            $h.stateReq = $null; $h.stateIar = $null; $h.stateDone = [DateTime]::UtcNow.Ticks
            $script:FailStreak = $script:FailStreak + 1
        }
    }
    # 3) Start the next one
    Start-PetRequest 'state' '/ronaldo-pet/state' 2500

    if ($HostPid -gt 0) {
        try {
            $p = Get-Process -Id $HostPid -ErrorAction Stop
            if (-not $p) { $window.Close(); return }
        } catch {
            Write-Log 'host process gone, exiting'
            Save-Prefs
            $window.Close()
            return
        }
    }
    Refresh-Tip
}

function Poll-Pets {
    try {
        if (-not (Complete-PetRequest 'pets')) {
            Start-PetRequest 'pets' '/ronaldo-pet/pets' 4000
            return
        }
        $r = $script:LastJson
        Start-PetRequest 'pets' '/ronaldo-pet/pets' 4000
        if ($r -and $r.pets) {
            # NOTE: $r is a PSCustomObject (ConvertFrom-Json) -- never try to add
            # properties to it. The pet list lives in $script:PetsCache.
            $script:PetsCache = @($r.pets)

            if ($r.settings -and $r.settings.defaultPet) {
                $script:DefaultPetId = [string]$r.settings.defaultPet
            }

            # settings.desktopSize is the channel for the web slider: apply it live,
            # without restarting the window, so dragging the slider looks continuous.
            #
            # ...but a /pets response that was already in flight when the user
            # scrolled carries the OLD size, and applying it snapped the pet back
            # to its previous size a moment after every wheel notch. Our own
            # change needs a round trip to reach the host, so ignore host sizes
            # for a moment after we changed the size ourselves.
            $localAgeMs = 99999
            if ($script:LocalSizeTicks -gt 0) {
                $localAgeMs = ([DateTime]::UtcNow.Ticks - $script:LocalSizeTicks) / 10000.0
            }
            if ($r.settings -and $r.settings.desktopSize -and $localAgeMs -gt 3000) {
                $hostSize = [int]$r.settings.desktopSize
                if ($hostSize -ne $script:HostDesktopSize) {
                    $script:HostDesktopSize = $hostSize
                    if ($hostSize -ne (Get-DesktopSize)) {
                        $script:Prefs.size = $hostSize
                        Save-Prefs
                        Apply-Size
                        Update-Sprite
                        Write-Log ('size from host: ' + $hostSize)
                    }
                }
            }

            $before = ''
            if ($script:Pet) { $before = [string]$script:Pet.id }
            Apply-PetSelection
            $after = ''
            if ($script:Pet) { $after = [string]$script:Pet.id }

            # Only rebuild the context menu when the pet set actually changed.
            # Rebuilding it on every poll (4s) was a periodic visible hitch.
            $sig = ($script:PetsCache | ForEach-Object { [string]$_.id + ':' + [string]$_.name }) -join '|'
            if ($sig -ne $script:MenuSignature) {
                $script:MenuSignature = $sig
                $script:Menu = Build-Menu
                $window.ContextMenu = $script:Menu
            }
            if ($after -ne $before) {
                Write-Log ('pets: ' + $script:PetsCache.Count + ' available, showing ' + $after)
            }
        } elseif ($r -and $r.error) {
            Write-Log ('pets endpoint error: ' + [string]$r.error)
        }
    } catch {
        $script:PetsFailStreak = [int]$script:PetsFailStreak + 1
        if ($script:PetsFailStreak -le 2) { Write-Log ('pets poll failed: ' + $_.Exception.Message) }
    }
}

# ---------------------------------------------------------------- hit testing
function Test-CursorInWindowRect {
    # Is the cursor inside the window's rectangle at all? Separate from the
    # per-pixel test because the tooltip wants the coarse answer (see Hover-Tick).
    if (-not $script:Win32Ready) { return $true }
    try {
        if (-not [PetWin32]::GetCursorPos([ref]$script:CursorPt)) { return $true }
        $pt = $script:CursorPt
        $h = $script:Hwnd
        if ($h -eq [IntPtr]::Zero) { return $true }
        $rc = $script:ScratchRect
        if (-not [PetWin32]::GetWindowRect($h, [ref]$rc)) { return $true }
        $script:ScratchRect = $rc
        return (-not ($pt.X -lt $rc.Left -or $pt.X -ge $rc.Right -or $pt.Y -lt $rc.Top -or $pt.Y -ge $rc.Bottom))
    } catch {
        return $true
    }
}

function Test-CursorOverPet {
    # returns $true when the cursor is inside the window AND the sheet pixel there
    # is opaque -- i.e. when the pet should receive mouse input.
    #
    # Samples the CURRENT CELL's alpha (see Get-CellAlpha) rather than one
    # atlas-wide buffer, and maps the cursor through the window rect so it works
    # at any native cell resolution and any display size.
    if (-not $script:Win32Ready) { return $true }
    try {
        if (-not [PetWin32]::GetCursorPos([ref]$script:CursorPt)) { return $true }
        $pt = $script:CursorPt
        $h = $script:Hwnd
        if ($h -eq [IntPtr]::Zero) { return $true }
        $rc = $script:ScratchRect
        if (-not [PetWin32]::GetWindowRect($h, [ref]$rc)) { return $true }
        $script:ScratchRect = $rc
        if ($pt.X -lt $rc.Left -or $pt.X -ge $rc.Right -or $pt.Y -lt $rc.Top -or $pt.Y -ge $rc.Bottom) { return $false }
        $w = $rc.Right - $rc.Left
        $h2 = $rc.Bottom - $rc.Top
        if ($w -le 0 -or $h2 -le 0) { return $true }
        $cell = Get-CellAlpha $script:CellRow $script:CellCol
        if (-not $cell) { return $true }
        $fx = ($pt.X - $rc.Left) / [double]$w
        $fy = ($pt.Y - $rc.Top) / [double]$h2
        $ax = [int][Math]::Floor($fx * $cell.W)
        $ay = [int][Math]::Floor($fy * $cell.H)
        if ($ax -lt 0) { $ax = 0 }
        if ($ay -lt 0) { $ay = 0 }
        if ($ax -ge $cell.W) { $ax = $cell.W - 1 }
        if ($ay -ge $cell.H) { $ay = $cell.H - 1 }
        $idx = ($ay * $cell.Stride) + ($ax * 4) + 3
        if ($idx -lt 0 -or $idx -ge $cell.Pixels.Length) { return $true }
        return ($cell.Pixels[$idx] -gt 16)
    } catch {
        return $true
    }
}

function Set-ClickThrough {
    param([bool]$On)
    if ($script:ClickThrough -eq $On) { return }
    if (-not $script:Win32Ready) { return }
    # Never toggle during a drag: flipping WS_EX_TRANSPARENT mid-drag drops the
    # mouse capture and makes the window stutter.
    if ($script:Dragging) { return }
    try {
        $hwnd = Get-Hwnd
        if ($hwnd -eq [IntPtr]::Zero) { return }
        $ex = Get-ExStyle $hwnd
        if ($On) { $ex = $ex -bor $WS_EX_TRANSPARENT } else { $ex = $ex -band (-bnot $WS_EX_TRANSPARENT) }
        Set-ExStyle $hwnd $ex
        $script:ClickThrough = $On
    } catch { }
}

# Cursor direction relative to the window centre -> 0..15, same algorithm as the
# web client:  deg = atan2(dx, -dy) * 180/PI; if (deg<0) deg += 360;
#              dir = round(deg / 22.5) % 16
# The web uses getBoundingClientRect (CSS pixels); this uses Win32 coordinates.
# Both express "direction from the window centre", so the result matches.
function Update-LookDirFromCursor {
    if (-not $script:Win32Ready) { return }
    $box = Get-WindowBox
    if (-not $box) { return }
    try {
        # Reuse the preallocated POINT: this runs every 100ms, no need to
        # allocate a struct each time.
        if (-not [PetWin32]::GetCursorPos([ref]$script:CursorPt)) { return }
        $pt = $script:CursorPt
        $cx = $box.x + $box.w / 2.0
        $cy = $box.y + $box.h / 2.0
        $dx = $pt.X - $cx
        $dy = $pt.Y - $cy
        # Too close to the centre and the direction flickers; keep the last one.
        if ([Math]::Abs($dx) -le 6 -and [Math]::Abs($dy) -le 6) { return }
        $deg = [Math]::Atan2($dx, -$dy) * 180.0 / [Math]::PI
        if ($deg -lt 0) { $deg = $deg + 360 }
        $script:LookDir = [int]([Math]::Round($deg / 22.5)) % 16
    } catch { }
}

function Hover-Tick {
    # A drag owns the mouse: skip hit-testing and, above all, skip opening and
    # closing the tooltip Popup (creating/destroying a Popup window every tick is
    # one of the most expensive things this process can do).
    if ($script:Dragging) { return }
    try {
        $inside = Test-CursorInWindowRect
        $opaque = $false
        if ($inside) { $opaque = Test-CursorOverPet }

        # The sprite animates, so at a given pixel the alpha alternates between
        # frames: sampling it once per tick made the tooltip pop open and shut
        # two or three times a second while the cursor just rested on the pet.
        # So: an opaque pixel OPENS the tooltip, and once open it survives a few
        # transparent frames (and is only closed when the cursor leaves the
        # window for good). A transparent corner can still never open it.
        if ($opaque) {
            $script:HoverMissTicks = 0
            $over = $true
        } elseif ($inside -and $script:Hovering -and $script:HoverMissTicks -lt 6) {
            $script:HoverMissTicks = [int]$script:HoverMissTicks + 1
            $over = $true
        } else {
            $script:HoverMissTicks = 0
            $over = $false
        }

        # Click-through follows the same value, so the pet stays clickable for as
        # long as the tooltip says the cursor is on it -- an invisible
        # WS_EX_TRANSPARENT window would swallow exactly the clicks the user is
        # aiming at the pet.
        Set-ClickThrough (-not $over)

        if ($over -eq $script:Hovering) {
            return
        }
        $script:Hovering = $over
        if ($over) {
            if ($script:Menu) { $tip.PlacementTarget = $sprite }
            $t = Build-TipText
            $tipHead.Text = $t.head
            $tipWs.Text = $t.ws
            $tipConv.Text = $t.conv
            $tipHint.Text = $t.hint
            $tip.IsOpen = $true
            Write-Log ('hover ON | ' + $t.head + ' | ' + $t.ws + ' | ' + $t.conv)
        } else {
            $tip.IsOpen = $false
            Write-Log 'hover OFF'
        }
    } catch { }
}

# ---------------------------------------------------------------- mouse
#
# Drag is hand-rolled (SetWindowPos per MouseMove), NOT Window.DragMove().
#
# DragMove was tried and reverted: it runs the OS modal move loop, which should
# be smoother, but on this machine it entered the loop and never left it (the
# window stayed put while PressTicks stayed set, so the pet was stuck thinking it
# was being dragged forever). Not something we can debug from outside, so we do
# it ourselves -- but the hot path is written carefully, because that is where
# the "dragging feels sticky" complaint came from:
#
#   - Windows delivers WM_MOUSEMOVE 100+ times per second, and EVERY run of this
#     body goes through the PowerShell engine. The first version called three
#     nested PowerShell functions per event (Move-WindowPhysical -> Get-Hwnd ->
#     SetWindowPos) plus the WinForms Cursor.Position getter -- roughly 1-3ms of
#     engine overhead per event, i.e. up to a third of the UI thread.
#   - Now: P/Invoke into a PREALLOCATED POINT, the HWND comes from the cache, and
#     SetWindowPos is called directly. No function calls, no allocations.
#
# Please keep this handler free of function calls and object creation.
$script:SWP_DRAG = 0x15   # SWP_NOSIZE(1) | SWP_NOZORDER(4) | SWP_NOACTIVATE(0x10)

$window.Add_MouseLeftButtonDown({
        # Diagnostic: proves the click actually reached the window. If a user says
        # "clicking does nothing", this line (or its absence) settles it: absent =
        # the window is click-through / not receiving input; present = our handler.
        Write-Log ('mousedown at ' + [int]$_.GetPosition($window).X + ',' + [int]$_.GetPosition($window).Y + ' clickCount=' + $_.ClickCount)
        $script:Dragging = $false
        $script:DragDir = 'running'
        $script:DragMoves = 0
        $script:DragCostMs = 0
        $script:DragWorstMs = 0
        # Diagnostic only (-SlowTickMs): the exact sequence of cursor deltas the
        # handler saw, which is what tells us whether events were dropped.
        $script:DragTrace = ''
        if (-not [PetWin32]::GetCursorPos([ref]$script:CursorPt)) { return }
        $rc = $script:ScratchRect
        $ok = $false
        if ($script:Win32Ready -and $script:Hwnd -ne [IntPtr]::Zero) {
            $ok = [PetWin32]::GetWindowRect($script:Hwnd, [ref]$rc)
        }
        $script:ScratchRect = $rc
        if ($ok) {
            $script:DragOrigin = @{ cx = $script:CursorPt.X; cy = $script:CursorPt.Y; px = $rc.Left; py = $rc.Top }
        } else {
            $script:DragOrigin = @{ cx = $script:CursorPt.X; cy = $script:CursorPt.Y; px = [int]($window.Left * $script:DpiX); py = [int]($window.Top * $script:DpiY) }
        }
        # CAPTURE THE MOUSE. Without this the drag is only alive while the cursor
        # happens to sit on our window, and SetWindowPos always trails the cursor
        # by at least one event. A quick flick therefore outruns the window, the
        # cursor ends up outside it, WM_MOUSEMOVE/WM_LBUTTONUP stop arriving and
        # the pet freezes mid-drag with the button still down -- the "dragging is
        # not smooth" report. Capture also guarantees the button-up that ends the
        # drag, which is what the web client gets from setPointerCapture.
        try { $script:GotCapture = $window.CaptureMouse() } catch { $script:GotCapture = $false }
        if ($tip.IsOpen) { $tip.IsOpen = $false }
    })

$window.Add_MouseMove({
        $d = $script:DragOrigin
        if ($null -eq $d) { return }
        if ($_.LeftButton -ne [System.Windows.Input.MouseButtonState]::Pressed) { return }
        $t0 = [DateTime]::UtcNow.Ticks
        if (-not [PetWin32]::GetCursorPos([ref]$script:CursorPt)) { return }
        $dx = $script:CursorPt.X - $d.cx
        $dy = $script:CursorPt.Y - $d.cy
        if (-not $script:Dragging) {
            if ($dx -lt 4 -and $dx -gt -4 -and $dy -lt 4 -and $dy -gt -4) { return }
            $script:Dragging = $true
        }
        if ($dx -gt 4) { $script:DragDir = 'runRight' }
        elseif ($dx -lt -4) { $script:DragDir = 'runLeft' }
        else { $script:DragDir = 'running' }
        $h = $script:Hwnd
        if ($h -ne [IntPtr]::Zero) {
            [void][PetWin32]::SetWindowPos($h, [IntPtr]::Zero, ($d.px + $dx), ($d.py + $dy), 0, 0, $script:SWP_DRAG)
        }
        $script:DragMoves = [int]$script:DragMoves + 1
        if ($SlowTickMs -gt 0) {
            if ($script:DragTrace.Length -lt 200) {
                $script:DragTrace = $script:DragTrace + $dx.ToString() + '/' + $dy.ToString() + ' '
            }
            $ms = ([DateTime]::UtcNow.Ticks - $t0) / 10000.0
            $script:DragCostMs = [double]$script:DragCostMs + $ms
            if ($ms -gt $script:DragWorstMs) { $script:DragWorstMs = $ms }
        }
    })

$window.Add_MouseLeftButtonUp({
        Write-Log ('mouseup at ' + [int]$_.GetPosition($window).X + ',' + [int]$_.GetPosition($window).Y +
            ' dragging=' + $script:Dragging + ' moves=' + $script:DragMoves + ' capture=' + $script:GotCapture)
        # Read the drag state BEFORE releasing the capture: ReleaseMouseCapture
        # raises LostMouseCapture synchronously, and that handler clears
        # Dragging/DragOrigin. Reading afterwards made $wasDragging false and $d
        # null, so a finished drag fell through to the click branch and never
        # clamped, saved or logged.
        $wasDragging = $script:Dragging
        $d = $script:DragOrigin
        if ($script:GotCapture) {
            $script:ReleasingCapture = $true
            try { [void]$window.ReleaseMouseCapture() } catch { }
            $script:ReleasingCapture = $false
            $script:GotCapture = $false
        }
        $script:DragOrigin = $null
        $script:Dragging = $false
        Set-ClickThrough $false
        if ($wasDragging) {
            # SetWindowPos bypassed the WPF properties entirely, so there is
            # nothing to resync -- just clamp and remember (Win32 coordinates).
            Clamp-ToWorkArea
            Save-Position
            $script:Hovering = $false
            if ($SlowTickMs -gt 0 -and $script:DragMoves -gt 0) {
                $avg = [Math]::Round([double]$script:DragCostMs / [int]$script:DragMoves, 3)
                Write-Log ('drag: ' + $script:DragMoves + ' mousemove events, handler avg ' + $avg +
                    'ms, worst ' + [Math]::Round($script:DragWorstMs, 2) + 'ms')
                Write-Log ('drag trace (dx/dy): ' + $script:DragTrace)
            }
            return
        }
        if (-not $d) { return }
        # ---- click bookkeeping ----
        # 3 fast clicks -> dive + sound; 2 fast clicks -> open Edge; 1 click -> bubble
        $now = Get-Date
        $list = @()
        foreach ($t in $script:Clicks) { if (($now - $t).TotalMilliseconds -lt 1200) { $list += $t } }
        $list += $now
        $script:Clicks = $list

        if ($list.Count -ge 3) {
            # 3 fast clicks -> dive, and this MUST be tested before the double-click
            # action: the first two clicks of a triple already look like a double,
            # so firing "open Edge" on the 2nd would make the dive unreachable.
            $script:Clicks = @()
            $script:PendingOpenTicks = 0
            $script:Diving = 1
            $phrases = @()
            if ($script:Pet -and $script:Pet.divePhrases) { $phrases = @($script:Pet.divePhrases) }
            if ($phrases.Count -eq 0) { $phrases = @(T 'bubble.dive' 'Ouch!') }
            Show-Bubble ($phrases[(Get-Random -Maximum $phrases.Count)]) ''
            Play-Sound 'dive'
            Write-Log 'click -> dive (3x)'
            return
        }

        $gap = 9999
        if ($list.Count -ge 2) {
            $gap = ($list[$list.Count - 1] - $list[$list.Count - 2]).TotalMilliseconds
        }
        if ($list.Count -ge 2 -and $gap -lt 500) {
            # Double click -> open Edge, but DEFERRED by 400ms: if a third click
            # lands inside that window it is a triple click and becomes the dive
            # instead. The resolve tick performs the open.
            $script:PendingOpenTicks = [DateTime]::UtcNow.Ticks + 4000000
            Write-Log 'click -> double (open Edge in 400ms unless a 3rd click lands)'
            return
        }

        $phrases = @()
        if ($script:Pet -and $script:Pet.phrases) { $phrases = @($script:Pet.phrases) }
        if ($phrases.Count -eq 0) { $phrases = @(T 'bubble.hello' 'Hi!') }
        Show-Bubble ($phrases[(Get-Random -Maximum $phrases.Count)]) (T 'bubble.clickHint' 'Double-click = open Edge')
        Play-Sound 'click'
        Write-Log 'click -> bubble'
    })

$window.Add_MouseRightButtonUp({
        if ($script:Menu) {
            $script:Menu.PlacementTarget = $sprite
            $script:Menu.IsOpen = $true
        }
    })

$window.Add_MouseWheel({
        # quick size adjust without opening the menu
        $step = 12
        $cur = Get-DesktopSize
        if ($_.Delta -gt 0) { $cur = $cur + $step } else { $cur = $cur - $step }
        Write-Log ('wheel delta=' + $_.Delta + ' size ' + (Get-DesktopSize) + ' -> ' + $cur +
            ' sprite=' + [int]$sprite.Width + 'x' + [int]$sprite.Height)
        Set-DesktopSize $cur
        $box = Get-WindowBox
        $where = 'n/a'
        if ($box) { $where = $box.x.ToString() + ',' + $box.y.ToString() + ' ' + $box.w.ToString() + 'x' + $box.h.ToString() }
        Write-Log ('wheel applied: window=' + $where + ' sprite=' + [int]$sprite.Width + 'x' + [int]$sprite.Height)
    })

# If anything steals the capture (another window taking foreground, ALT+TAB, a
# native dialog), end the drag instead of leaving it latched with the origin
# still set -- otherwise the pet thinks it is being dragged forever.
$window.Add_LostMouseCapture({
        if ($script:ReleasingCapture) { return }
        if ($script:Dragging) {
            Write-Log ('lost capture mid-drag after ' + $script:DragMoves + ' moves; ending drag')
            $script:Dragging = $false
            $script:DragOrigin = $null
            $script:GotCapture = $false
        }
    })

# ---------------------------------------------------------------- self capture
#
# Renders the live sprite with RenderTargetBitmap and writes it to a PNG.
#
# Why this exists: from outside, this window is nearly impossible to inspect.
# BitBlt (CopyFromScreen) does not see layered windows at all, PrintWindow
# returns the window flattened over whatever is behind it, and at 200% DPI the
# probe process reports half-size rectangles. Every "the pet looks cut off"
# investigation ended in noise. This gives an answer with no middlemen.
#
# Trigger: create the file <logdir>/desktop-pet-capture.txt (any content); the
# pet writes desktop-pet-frame.png next to it and deletes the trigger.
function Get-CaptureTrigger { if (-not $script:LogPath) { return '' } return (Join-Path (Split-Path -Parent $script:LogPath) 'desktop-pet-capture.txt') }
function Get-CaptureOutput { if (-not $script:LogPath) { return '' } return (Join-Path (Split-Path -Parent $script:LogPath) 'desktop-pet-frame.png') }

function Invoke-SelfCapture {
    try {
        $out = Get-CaptureOutput
        $w = [int]$sprite.Width
        $h = [int]$sprite.Height
        if ($w -le 0 -or $h -le 0) { Write-Log 'self-capture: sprite has no size'; return }
        $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap -ArgumentList @($w, $h, 96.0, 96.0, [System.Windows.Media.PixelFormats]::Pbgra32)
        $rtb.Render($sprite)
        $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
        $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create([System.Windows.Media.Imaging.BitmapSource]$rtb))
        $fs = [System.IO.File]::Create($out)
        $enc.Save($fs)
        $fs.Close()
        Write-Log ('self-capture -> ' + $out + '  ' + $w + 'x' + $h +
            ' anim=' + $script:Anim + ' cell=' + $script:CellRow + '/' + $script:CellCol +
            ' atlas=' + $script:CellW + 'x' + $script:CellH)
    } catch {
        Write-Log ('self-capture failed: ' + $_.Exception.Message)
    }
}
$window.Add_SourceInitialized({
        try {
            [void](Get-Hwnd)
            try {
                $dpi = [System.Windows.Media.VisualTreeHelper]::GetDpi($window)
                if ($dpi.DpiScaleX -gt 0) { $script:DpiX = [double]$dpi.DpiScaleX }
                if ($dpi.DpiScaleY -gt 0) { $script:DpiY = [double]$dpi.DpiScaleY }
            } catch { }
            if ($script:Prefs.topmost -eq $false) { $window.Topmost = $false }
            Write-Log ('source initialized hwnd=' + (Get-Hwnd) + ' dpi=' + $script:DpiX + 'x' + $script:DpiY)
        } catch { }
    })

$window.Add_Loaded({
        # Restore the saved position, but only if it was recorded in Win32
        # coordinates (older builds saved DIPs; those are ignored on a scaled
        # display rather than restoring a wrong spot).
        if ($script:Prefs.posUnit -eq 'physical' -and $script:Prefs.left -ge 0 -and $script:Prefs.top -ge 0) {
            Move-WindowPhysical ([int]$script:Prefs.left) ([int]$script:Prefs.top)
            Clamp-ToWorkArea
        } else {
            Default-Position
        }
        $script:Positioned = $true
        $box = Get-WindowBox
        if ($box) {
            Write-Log ('window: ' + $box.x + ',' + $box.y + ' ' + $box.w + 'x' + $box.h + ' (win32) dpi=' + $script:DpiX + ' visible=' + $window.IsVisible + ' topmost=' + $window.Topmost)
        } else {
            Write-Log ('window: (rect unavailable) dpi=' + $script:DpiX)
        }
    })

$window.Add_Closed({
        try {
            if ($script:AnimTimer) { $script:AnimTimer.Stop() }
            if ($script:PollTimer) { $script:PollTimer.Stop() }
            if ($script:HitTimer) { $script:HitTimer.Stop() }
            if ($script:BubbleTimer) { $script:BubbleTimer.Stop() }
            foreach ($k in $script:AudioCache.Keys) { try { $script:AudioCache[$k].Close() } catch { } }
        } catch { }
        Write-Log 'window closed'
    })

# ---------------------------------------------------------------- boot
Write-Log ('starting: base=' + $Base + ' hostPid=' + $HostPid + ' petId=' + $PetId)
$script:EdgePath = Resolve-Edge
if ($script:EdgePath) { Write-Log ('edge resolved: ' + $script:EdgePath) }
else { Write-Log 'edge NOT found; double-click will fall back to the default browser' }

# initial load (best effort; the poller retries)
Poll-State
Poll-Pets
if (-not $script:Pet) {
    Write-Log 'no pet loaded yet; will retry from the poller'
    Show-Bubble (T 'bubble.waiting' 'Waiting for DSH...') ''
}

# ---------------------------------------------------------------- animation
#
# Mirrors the web client's animation loop exactly:
#
#   web:  useEffect(() => { setFrame(0); if (n<=1) return;
#                           setInterval(() => setFrame(f => (f+1)%n), max(40, round(1000/fps))) })
#
# Two things the first version got wrong, both visible to the user:
#
#   1. It reset the frame index on an animation change but did NOT repaint, so
#      frame 0 of every new animation was skipped (you see a missing frame).
#   2. It ran a fixed 33ms timer and *accumulated* ms, which quantises the rate:
#      fps=12 (83.3ms) became 99ms, i.e. 10.1fps instead of 12. The web uses
#      setInterval(1000/fps) directly, so this did too, now.
#
# Split into two timers for the same reason the web has a render pass and an
# effect: a cheap ~100ms "resolve" tick decides WHICH animation is current and
# restarts the frame timer when it changes; the frame timer then advances one
# frame per tick at the correct interval. A single timer cannot do this, because
# a static animation (look has frames=1) would stop the timer and nothing would
# ever notice the state changed.
# Helper functions used by Update-Sprite / the timers below. They must be
# defined BEFORE the boot section runs Poll-Pets -> Load-Pet -> Update-Sprite,
# otherwise PowerShell would not have them yet at first paint.
function Get-WebFrameCount {
    param($spec)
    # web: frameCount = anim==='look' ? 1 : (st.frames || 1)
    if ($script:Anim -eq 'look') { return 1 }
    if ($spec -and $spec.frames) { return [Math]::Max(1, [int]$spec.frames) }
    return 1
}

function Get-WebFps {
    param($spec)
    if ($spec -and $spec.fps -and [double]$spec.fps -gt 0) { return [double]$spec.fps }
    return 8
}

function Sync-AnimTimer {
    if (-not $script:AnimTimer) { return }
    $spec = Get-StateSpec $script:Anim
    $frames = Get-WebFrameCount $spec
    if ($frames -le 1) {
        if ($script:AnimTimer.IsEnabled) { $script:AnimTimer.Stop() }
        return
    }
    $ms = [Math]::Max(40, [Math]::Round(1000.0 / (Get-WebFps $spec)))
    # Restart so the new Interval takes effect immediately rather than after the
    # pending tick (DispatcherTimer keeps the old interval until it fires).
    if ($script:AnimTimer.IsEnabled) { $script:AnimTimer.Stop() }
    $script:AnimTimer.Interval = [TimeSpan]::FromMilliseconds($ms)
    $script:AnimTimer.Start()
}

$script:AnimTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:AnimTimer.Interval = [TimeSpan]::FromMilliseconds(125)
$script:AnimTimer.Add_Tick({
        $t0 = [DateTime]::UtcNow.Ticks
        try {
            $spec = Get-StateSpec $script:Anim
            $frames = Get-WebFrameCount $spec
            $script:FrameIdx = ($script:FrameIdx + 1) % $frames
            Update-Sprite
        } catch {
            Write-Log ('anim tick failed: ' + $_.Exception.Message)
        }
        Test-SlowTick 'anim' $t0
    })

# ~10/s: decides WHICH animation is current. Much cheaper than the frame timer;
# and even for a static animation it notices state changes and restarts the frame timer.
$script:ResolveTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:ResolveTimer.Interval = [TimeSpan]::FromMilliseconds(100)
$script:ResolveTimer.Add_Tick({
        try {
            if ($script:Diving -gt 0) {
                $script:Diving = $script:Diving + 100
                if ($script:Diving -gt 2500) { $script:Diving = 0 }
            }
            # look (watch the cursor) is a STATIC frame that turns to face the
            # cursor: each tick we recompute which atlas cell to show from the
            # cursor's direction relative to the window centre.
            #
            # This call is the whole point -- Update-LookDirFromCursor used to be
            # defined and NEVER called by anything, so $script:LookDir sat at its
            # initial value 0 forever and the pet stared straight up. You can see
            # it in the self-capture log line: "anim=look cell=9/0" -- row 9 is
            # the upper half of the look ring and col 0 means "straight up".
            #
            # Only while hovering: look is only ever the current animation while
            # the cursor is on the pet (see Resolve-Anim), so computing it the
            # rest of the time is pointless and costs two extra P/Invokes per
            # 100ms tick.
            if ($script:Hovering) { Update-LookDirFromCursor }
            $anim = Resolve-Anim
            $lookChanged = $false
            # Deferred "open Edge" from a double click (see the click handler).
            if ($script:PendingOpenTicks -gt 0 -and [DateTime]::UtcNow.Ticks -ge $script:PendingOpenTicks) {
                $script:PendingOpenTicks = 0
                $script:Clicks = @()
                Write-Log 'click -> open Edge (double confirmed)'
                Open-HarnessPage
                return
            }
            # "Hide this pet" closes the window once the bubble has been readable.
            if ($script:HideAtTicks -gt 0 -and [DateTime]::UtcNow.Ticks -ge $script:HideAtTicks) {
                $script:HideAtTicks = 0
                Save-Prefs
                $window.Close()
                return
            }
            if ($anim -eq 'look' -and $anim -eq $script:Anim -and $script:LookDir -ne $script:AppliedLookDir) {
                $lookChanged = $true
            }
            if ($anim -ne $script:Anim) {
                $script:Anim = $anim
                $script:FrameIdx = 0
                # Keep AppliedLookDir in sync, else the tick right after switching
                # to look repaints for nothing.
                $script:AppliedLookDir = $script:LookDir
                # Repaint frame 0 IMMEDIATELY -- without this every new animation skips its first frame
                Update-Sprite
                Sync-AnimTimer
            } elseif ($lookChanged) {
                # look is a static frame; only the direction changed (web does the same)
                $script:AppliedLookDir = $script:LookDir
                Update-Sprite
            }
        } catch {
            Write-Log ('resolve tick failed: ' + $_.Exception.Message)
        }
    })
$script:ResolveTimer.Start()
Sync-AnimTimer

# state poll ~2/s; pet list every ~4s, or every tick until the first pet loads
$script:PollTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PollTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:PollTimer.Add_Tick({
        $t0 = [DateTime]::UtcNow.Ticks
        Poll-State
        $script:PollTick = [int]$script:PollTick + 1
        if (-not $script:Pet) { Poll-Pets }
        elseif (($script:PollTick % 16) -eq 0) { Poll-Pets }
        Test-SlowTick 'poll' $t0
    })
$script:PollTick = 0
$script:PollTimer.Start()

# cursor hit-test ~12/s (80ms). 60ms bought nothing perceptible but tripled the
# P/Invoke traffic on the UI thread; 80ms still feels instant.
$script:HitTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:HitTimer.Interval = [TimeSpan]::FromMilliseconds(80)
$script:HitTimer.Add_Tick({
        $t0 = [DateTime]::UtcNow.Ticks
        try { Hover-Tick } catch { }
        Test-SlowTick 'hover' $t0
    })
$script:HitTimer.Start()

# self-capture trigger poll (2s). Costs one Test-Path; only does work on request.
$script:CaptureTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:CaptureTimer.Interval = [TimeSpan]::FromMilliseconds(2000)
$script:CaptureTimer.Add_Tick({
        try {
            $trigger = Get-CaptureTrigger
            if ($trigger -and (Test-Path -LiteralPath $trigger)) {
                Remove-Item -LiteralPath $trigger -Force -ErrorAction SilentlyContinue
                Invoke-SelfCapture
            }
        } catch { }
    })
$script:CaptureTimer.Start()

[void]$window.ShowDialog()
Write-Log 'exit'
exit 0
