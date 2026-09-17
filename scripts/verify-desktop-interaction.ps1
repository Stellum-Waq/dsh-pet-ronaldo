# =============================================================================
# Desktop pet interaction test
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-desktop-interaction.ps1 `
#       [-LogPath <path to the pet's -Log file>] [-SkipDrag] [-SkipWheel] [-SkipMenu]
#
# What it covers (the part of the pet that has no other automated coverage):
#   B  drag          -- window must follow the cursor by the full delta
#   C  wheel         -- window must actually resize
#   D  right-click   -- a context-menu popup window must appear
#
# ---------------------------------------------------------------------------
# READ THIS BEFORE TRUSTING A FAILURE
#
# This drives the REAL mouse via SetCursorPos + mouse_event. If a human is using
# the mouse at the same time they keep stealing the cursor back, and the test
# silently measures the wrong thing (it will look like "drag moved 530px instead
# of 220px"). So:
#   - the cursor is parked on the pet, read back, and retried up to 15 times;
#   - if it never stabilises the affected check is reported "INCONCLUSIVE",
#     NOT "FAIL" -- do not chase that as a bug;
#   - the run exits non-zero only for real failures.
#
# THIS FILE MUST STAY PURE ASCII -- see the note in lib\win32-probe.ps1.
# All paths arrive as parameters, never as literals.
# =============================================================================

param(
    [string]$LogPath = '',
    [switch]$SkipDrag,
    [switch]$SkipWheel,
    [switch]$SkipMenu
)

. (Join-Path $PSScriptRoot 'lib\win32-probe.ps1')

$ErrorActionPreference = 'Continue'
$script:Pass = 0
$script:Fail = 0
$script:Skip = 0

function Pass($name, $extra = '') {
    $script:Pass++
    Write-Host ("  ok    " + $name + $(if ($extra) { "  -- $extra" } else { '' }))
}
function Fail($name, $extra = '') {
    $script:Fail++
    Write-Host ("  FAIL  " + $name + $(if ($extra) { "  -- $extra" } else { '' }))
}
function Inconclusive($name, $why) {
    $script:Skip++
    Write-Host ("  [?]   " + $name + "  -- INCONCLUSIVE: " + $why)
}

$TITLE = 'DSH Pet'

$count = [Win32Probe]::CountTitled($TITLE)
Write-Host ("pet windows: " + $count)
if ($count -eq 0) {
    Write-Host "no desktop pet is running -- start it first (settings panel, or POST /ronaldo-pet/desktop {action:start})"
    exit 2
}
if ($count -gt 1) {
    # Duplicate windows used to come from the host relaunching while an earlier
    # attempt was still starting; that is a bug, so make it loud.
    Fail "only one pet window" ("found " + $count)
}
else {
    Pass "only one pet window"
}

$h = [Win32Probe]::Find($TITLE)
Write-Host ("window: " + [Win32Probe]::Describe($h))
Write-Host ''

function Get-PetPoint($hwnd) {
    $r = New-Object Win32Probe+RECT
    [void][Win32Probe]::GetWindowRect($hwnd, [ref]$r)
    return @{
        x = $r.Left + [int](($r.Right - $r.Left) / 2)
        y = $r.Top + [int](($r.Bottom - $r.Top) * 0.55)
    }
}

function Park-OnPet($hwnd) {
    $p = Get-PetPoint $hwnd
    $ok = [Win32Probe]::Park($p.x, $p.y, 15)
    return @{ ok = $ok; x = [Win32Probe]::CursorX(); y = [Win32Probe]::CursorY(); target = $p }
}

# ---------------------------------------------------------------- B: drag
Write-Host "=== B  drag ==="
if ($SkipDrag) {
    Write-Host "  (skipped)"
}
else {
    $park = Park-OnPet $h
    if (-not $park.ok) {
        Inconclusive "drag" "cursor will not stay put (is someone using the mouse?)"
    }
    else {
        $under = [Win32Probe]::At($park.x, $park.y)
        Write-Host ("  cursor " + $park.x + "," + $park.y + "  under=" + [Win32Probe]::Describe($under))
        $beforeL = [Win32Probe]::RectL($h)
        $beforeT = [Win32Probe]::RectT($h)
        $dxWant = -220
        $dyWant = -160

        [Win32Probe]::Move(0x0002, 0, 0)     # left down
        Start-Sleep -Milliseconds 80
        for ($i = 1; $i -le 30; $i++) {
            [void][Win32Probe]::SetCursorPos(
                [int]($park.x + $dxWant * $i / 30),
                [int]($park.y + $dyWant * $i / 30))
            Start-Sleep -Milliseconds 16
        }
        Start-Sleep -Milliseconds 60
        [Win32Probe]::Move(0x0004, 0, 0)     # left up
        Start-Sleep -Milliseconds 800

        $gotL = [Win32Probe]::RectL($h) - $beforeL
        $gotT = [Win32Probe]::RectT($h) - $beforeT
        $want = "want $dxWant,$dyWant"
        if ([Math]::Abs($gotL - $dxWant) -le 10 -and [Math]::Abs($gotT - $dyWant) -le 10) {
            Pass "drag follows the cursor" ("moved $gotL,$gotT  ($want)")
        }
        else {
            $outside = $park.x - 260
            if ($outside -lt 0 -or ($park.y - 180) -lt 0) {
                Inconclusive "drag" "target would be off-screen"
            }
            else {
                Fail "drag follows the cursor" ("moved $gotL,$gotT  ($want)")
            }
        }
    }
}

# ---------------------------------------------------------------- C: wheel
Write-Host ""
Write-Host "=== C  wheel resize ==="
if ($SkipWheel) {
    Write-Host "  (skipped)"
}
else {
    $park = Park-OnPet $h
    if (-not $park.ok) {
        Inconclusive "wheel resize" "cursor will not stay put (is someone using the mouse?)"
    }
    else {
        $w0 = [Win32Probe]::RectW($h)
        [Win32Probe]::Wheel(120); Start-Sleep -Milliseconds 500
        [Win32Probe]::Wheel(120); Start-Sleep -Milliseconds 500
        [Win32Probe]::Wheel(120); Start-Sleep -Milliseconds 1000
        $w1 = [Win32Probe]::RectW($h)
        if ($w1 -gt $w0) {
            Pass "wheel up enlarges the window" ("width $w0 -> $w1")
        }
        else {
            Fail "wheel up enlarges the window" ("width $w0 -> $w1")
        }
        # put it back
        [Win32Probe]::Wheel(-120); Start-Sleep -Milliseconds 400
        [Win32Probe]::Wheel(-120); Start-Sleep -Milliseconds 400
        [Win32Probe]::Wheel(-120); Start-Sleep -Milliseconds 1000
    }
}

# ---------------------------------------------------------------- D: menu
Write-Host ""
Write-Host "=== D  right-click menu ==="
if ($SkipMenu) {
    Write-Host "  (skipped)"
}
else {
    $park = Park-OnPet $h
    if (-not $park.ok) {
        Inconclusive "context menu" "cursor will not stay put (is someone using the mouse?)"
    }
    else {
        $before = @{}
        foreach ($w in [Win32Probe]::ListAll()) { $before[($w -split '\|')[0]] = $true }
        [Win32Probe]::Move(0x0008, 0, 0)     # right down
        Start-Sleep -Milliseconds 50
        [Win32Probe]::Move(0x0010, 0, 0)     # right up
        Start-Sleep -Milliseconds 1500
        $new = @()
        foreach ($w in [Win32Probe]::ListAll()) {
            $id = ($w -split '\|')[0]
            if (-not $before.ContainsKey($id)) { $new += $w }
        }
        if ($new.Count -gt 0) {
            Pass "context menu pops up" ($new -join ' ; ')
        }
        else {
            Fail "context menu pops up" "no new top-level window appeared"
        }
    }
}

# ---------------------------------------------------------------- log tail
Write-Host ""
if ($LogPath -and (Test-Path -LiteralPath $LogPath)) {
    Write-Host "=== pet log tail ($LogPath) ==="
    Get-Content -LiteralPath $LogPath -Encoding UTF8 | Select-Object -Last 20
}
elseif ($LogPath) {
    Write-Host ("pet log not found: " + $LogPath)
}

Write-Host ""
if ($script:Fail -eq 0) {
    if ($script:Skip -gt 0) {
        Write-Host ("OK  " + $script:Pass + " passed, " + $script:Skip + " inconclusive (cursor kept moving)")
    }
    else {
        Write-Host ("OK  all " + $script:Pass + " checks passed")
    }
    exit 0
}
Write-Host ("FAILED  " + $script:Fail + " failed / " + ($script:Pass + $script:Fail + $script:Skip) + " checks")
exit 1
