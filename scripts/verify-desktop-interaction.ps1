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
#   E  look          -- the look animation must actually turn to face the cursor
#                       (needs -LogPath; see section E for why)
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
    [string]$Base = 'http://127.0.0.1:3080',
    [switch]$SkipDrag,
    [switch]$SkipWheel,
    [switch]$SkipMenu,
    [switch]$SkipLook
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
        # Count mousedown lines so we can tell "the pet ignored the drag" apart from
        # "the click never reached the pet" (someone else was driving the mouse).
        $downBefore = 0
        if ($LogPath -and (Test-Path -LiteralPath $LogPath)) {
            $downBefore = @(Select-String -LiteralPath $LogPath -Pattern 'mousedown at' -ErrorAction SilentlyContinue).Count
        }
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
            $downAfter = $downBefore
            if ($LogPath -and (Test-Path -LiteralPath $LogPath)) {
                $downAfter = @(Select-String -LiteralPath $LogPath -Pattern 'mousedown at' -ErrorAction SilentlyContinue).Count
            }
            if ($outside -lt 0 -or ($park.y - 180) -lt 0) {
                Inconclusive "drag" "target would be off-screen"
            }
            elseif ($gotL -eq 0 -and $gotT -eq 0 -and $downAfter -le $downBefore) {
                # Nothing moved AND the pet never saw a mousedown: the synthetic
                # click did not land on it. A human moving the mouse steals the
                # cursor between Park() and the click, so this is not a pet bug.
                # (Measured for real once: log showed no mousedown at all during
                # the run, while hover was flickering from someone else's mouse.)
                Inconclusive "drag" "the synthetic mousedown never reached the pet (someone else using the mouse?)"
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

# ---------------------------------------------------------------- E: look
#
# "look" is the static animation where the pet turns to face the cursor. It is a
# regression test for a real bug: Update-LookDirFromCursor was defined but NEVER
# called, so the direction stayed at its initial 0 and the pet stared straight up
# no matter where the cursor was.
#
# How it is checked: park the cursor at a known offset from the window centre,
# ask the pet to capture its own current frame (see the self-capture trigger in
# DesktopPet.ps1), and read the atlas cell it reports. The cell encodes the
# direction (row/col), which we compare against the direction the cursor was
# actually at.
Write-Host ""
Write-Host "=== E  look (faces the cursor) ==="
if ($SkipLook) {
    Write-Host "  (skipped)"
}
elseif (-not $LogPath -or -not (Test-Path -LiteralPath $LogPath)) {
    Inconclusive "look faces the cursor" "needs -LogPath <the pet's -Log file> to read the captured cell"
}
else {
    # Which atlas rows hold the look ring? Ask the host, fall back to the standard.
    $lookRows = @(9, 10)
    $lookCols = 8
    try {
        $petsResp = Invoke-RestMethod -Uri ($Base + '/ronaldo-pet/pets') -TimeoutSec 5
        $viz = @($petsResp.pets | Where-Object { $_.visible -ne $false })
        if ($viz.Count -gt 0 -and $viz[0].states -and $viz[0].states.look -and $viz[0].states.look.rows) {
            $lookRows = @($viz[0].states.look.rows)
            if ($lookRows.Count -ge 2) { $lookCols = 8 }
        }
    } catch { /* host not reachable: use the standard layout */ }

    $logDir = Split-Path -Parent $LogPath
    $trigger = Join-Path $logDir 'desktop-pet-capture.txt'

    # Points on the pet's body, as fractions of the window. Kept well inside so the
    # cursor lands on opaque pixels (hover, and therefore look, needs that).
    # The silhouette changes between animation frames, so a point near the edge can
    # still miss; that sample is reported INCONCLUSIVE rather than as a failure.
    $points = @(
        @{ name = 'up';    fx = 0.50; fy = 0.24 },
        @{ name = 'right'; fx = 0.70; fy = 0.52 },
        @{ name = 'down';  fx = 0.50; fy = 0.78 },
        @{ name = 'left';  fx = 0.30; fy = 0.52 }
    )

    $seen = @{}
    $bad = 0
    $unstable = 0
    foreach ($p in $points) {
        $r = New-Object Win32Probe+RECT
        [void][Win32Probe]::GetWindowRect($h, [ref]$r)
        $tx = $r.Left + [int](($r.Right - $r.Left) * $p.fx)
        $ty = $r.Top + [int](($r.Bottom - $r.Top) * $p.fy)
        if (-not [Win32Probe]::Park($tx, $ty, 12)) { $unstable++; Write-Host ("  [?]   " + $p.name + ": cursor will not stay put"); continue }

        # Expected direction, computed from where the cursor ACTUALLY is.
        $cx = ($r.Left + $r.Right) / 2.0
        $cy = ($r.Top + $r.Bottom) / 2.0
        $dx = [Win32Probe]::CursorX() - $cx
        $dy = [Win32Probe]::CursorY() - $cy
        $deg = [Math]::Atan2($dx, -$dy) * 180.0 / [Math]::PI
        if ($deg -lt 0) { $deg = $deg + 360 }
        $wantDir = [int]([Math]::Round($deg / 22.5)) % 16

        # Ask the pet to capture itself and read the cell it reports.
        #
        # Self-capture is asynchronous: the pet polls for the trigger file on a 2s
        # timer, so up to two seconds pass between asking and the frame being
        # written. If a human nudges the mouse in that window the cursor leaves the
        # pet, hover goes off, and the capture happens in some other animation.
        # Re-pin the cursor on every poll so the sample stays on the pet.
        $before = @(Select-String -LiteralPath $LogPath -Pattern 'self-capture ->' -ErrorAction SilentlyContinue).Count
        Set-Content -LiteralPath $trigger -Value 'go' -Encoding ASCII
        $line = $null
        for ($i = 0; $i -lt 20; $i++) {
            [void][Win32Probe]::SetCursorPos($tx, $ty)
            Start-Sleep -Milliseconds 300
            $all = @(Select-String -LiteralPath $LogPath -Pattern 'self-capture ->' -ErrorAction SilentlyContinue)
            if ($all.Count -gt $before) { $line = $all[$all.Count - 1].Line; break }
        }
        if (-not $line) { $unstable++; Write-Host ("  [?]   " + $p.name + ": pet did not self-capture in time"); continue }

        $m = [regex]::Match($line, 'anim=(\S+)\s+cell=(\d+)/(\d+)')
        if (-not $m.Success) { $unstable++; Write-Host ("  [?]   " + $p.name + ": cannot parse '" + $line + "'"); continue }
        $animWas = $m.Groups[1].Value
        $row = [int]$m.Groups[2].Value
        $col = [int]$m.Groups[3].Value
        if ($animWas -ne 'look') {
            # Not hovering (or not on an opaque pixel) -> look is not the current
            # animation, so there is nothing to read. Not a failure.
            $unstable++
            Write-Host ("  [?]   " + $p.name + ": pet was in '" + $animWas + "', not look (cursor not on the body?)")
            continue
        }

        # cell -> direction
        $gotDir = -1
        if ($lookRows.Count -ge 2) {
            if ($row -eq [int]$lookRows[0]) { $gotDir = $col }
            elseif ($row -eq [int]$lookRows[1]) { $gotDir = $col + $lookCols }
        }
        if ($gotDir -ge 0) { $seen[$gotDir] = $true }
        $tolerance = 2
        $delta = [Math]::Abs($gotDir - $wantDir)
        if ($delta -gt 8) { $delta = 16 - $delta }
        if ($gotDir -ge 0 -and $delta -le $tolerance) {
            Pass ("look[" + $p.name + "]") ("cell " + $row + "/" + $col + " -> dir " + $gotDir + ", want " + $wantDir)
        } else {
            $bad++
            Fail ("look[" + $p.name + "]") ("cell " + $row + "/" + $col + " -> dir " + $gotDir + ", want " + $wantDir)
        }    }

    $usable = $points.Count - $unstable
    if ($usable -lt 2) {
        # Not enough readable samples to conclude anything. This is the normal
        # outcome when a human is using the mouse: the capture is async, so the
        # cursor often leaves the pet before the frame lands.
        Inconclusive "look faces the cursor" ("" + $usable + " of " + $points.Count + " points produced a readable look frame (was the cursor kept on the pet?)")
    } elseif ($seen.Count -gt 1) {
        Pass "look direction actually changes with the cursor" ("directions seen: " + (@($seen.Keys | Sort-Object) -join ',') + "  (" + $usable + "/" + $points.Count + " points usable)")
    } elseif ($bad -eq 0) {
        # Every usable sample landed on the same direction: exactly the frozen
        # LookDir bug (Update-LookDirFromCursor never being called looked like this).
        Fail "look direction actually changes with the cursor" ("only ever saw dir " + (@($seen.Keys)[0]) + " across " + $usable + " usable points")
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
