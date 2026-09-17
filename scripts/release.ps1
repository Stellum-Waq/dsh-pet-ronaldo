# =============================================================================
# One-command release: verify, then push master + tags to GitHub.
#
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 [-DryRun] [-SkipTests] [-Force]
#
# -DryRun     : run the tests and show what WOULD be pushed, change nothing
# -SkipTests  : skip the test suites (only for a docs-only push)
# -Force      : push even if the working tree is dirty
#
# It refuses to publish while anything is red. Publishing a plugin that fails its
# own tests is how you get a marketplace listing nobody can install.
#
# THIS FILE MUST STAY PURE ASCII -- Windows PowerShell 5.1 reads a .ps1 with no
# BOM as ANSI, so non-ASCII literals get mangled at parse time. (Same rule as
# desktop\DesktopPet.ps1 and scripts\lib\win32-probe.ps1.)
# =============================================================================

param(
    [switch]$DryRun,
    [switch]$SkipTests,
    [switch]$Force
)

$ErrorActionPreference = 'Continue'
$REPO = Split-Path -Parent $PSScriptRoot
Set-Location $REPO

$fail = 0
function Step($msg) { Write-Host ""; Write-Host ("== " + $msg) }
function Good($msg) { Write-Host ("   ok    " + $msg) }
function Bad($msg)  { $script:fail++; Write-Host ("   FAIL  " + $msg) }

# ---------------------------------------------------------------- 1. tests

if (-not $SkipTests) {
    Step "Running the test suites"
    $suites = @(
        @{ name = 'smoke-host';      cmd = 'scripts\smoke-host.mjs' },
        @{ name = 'desktop-lifecycle'; cmd = 'scripts\verify-desktop-lifecycle.mjs' },
        @{ name = 'highres';         cmd = 'scripts\verify-highres.mjs' },
        @{ name = 'client-render';   cmd = 'scripts\verify-client-render.mjs' },
        @{ name = 'skill-selftest';  cmd = 'skill\dsh-pet-forge\scripts\selftest.mjs' }
    )
    foreach ($s in $suites) {
        if (-not (Test-Path (Join-Path $REPO $s.cmd))) { Bad ($s.name + ": missing " + $s.cmd); continue }
        $out = & node (Join-Path $REPO $s.cmd) 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            # Report the suite's own last non-empty line. Deliberately no literal
            # match on the summary text: those lines are Chinese, and a Chinese
            # literal in this file would be mangled by PowerShell 5.1 (see the
            # ASCII rule at the top). The exit code above is the real signal.
            $lines = @($out -split "`n" | Where-Object { $_.Trim().Length -gt 0 })
            $last = ''
            if ($lines.Count -gt 0) { $last = $lines[$lines.Count - 1].Trim() }
            Good ($s.name + "  " + $last)
        } else {
            Bad ($s.name + " FAILED")
            ($out -split "`n" | Select-Object -Last 12) | ForEach-Object { Write-Host ("         " + $_) }
        }
    }
} else {
    Write-Host "== Skipping tests (-SkipTests)"
}

# ---------------------------------------------------------------- 2. tree state

Step "Checking the working tree"
if (Test-Path (Join-Path $REPO 'skill\dsh-pet-forge\.selftest')) {
    Remove-Item (Join-Path $REPO 'skill\dsh-pet-forge\.selftest') -Recurse -Force -ErrorAction SilentlyContinue
}
$dirty = & git status --porcelain
if ($dirty) {
    if ($Force) {
        Write-Host "   warn  working tree is dirty (continuing because -Force)"
        $dirty | ForEach-Object { Write-Host ("         " + $_) }
    } else {
        Bad "working tree is dirty -- commit first, or pass -Force"
        $dirty | ForEach-Object { Write-Host ("         " + $_) }
    }
} else {
    Good "working tree is clean"
}

# ---------------------------------------------------------------- 3. version

Step "Checking version consistency"
$pkg = Get-Content (Join-Path $REPO 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$pkg.version
$tags = & git tag -l ("v" + $version)
$head = (& git log --oneline -1).Trim()
Write-Host ("   version : " + $version)
Write-Host ("   HEAD    : " + $head)
if ($tags) { Good ("tag v" + $version + " exists") }
else { Write-Host ("   warn  no tag v" + $version + " yet -- create it: git tag -a v" + $version + " -m ""...""") }

$changelog = Join-Path $REPO 'CHANGELOG.md'
if (Test-Path $changelog) {
    if ((Get-Content $changelog -Raw -Encoding UTF8) -match [regex]::Escape("[" + $version + "]")) {
        Good ("CHANGELOG.md has a section for " + $version)
    } else {
        Write-Host ("   warn  CHANGELOG.md has no [" + $version + "] section")
    }
} else {
    Write-Host "   warn  CHANGELOG.md is missing"
}

# ---------------------------------------------------------------- 4. ahead/behind

Step "Comparing with origin"
$env:GIT_TERMINAL_PROMPT = '0'
$ahead = (& git log --oneline origin/master..HEAD 2>$null | Measure-Object).Count
$behind = (& git log --oneline HEAD..origin/master 2>$null | Measure-Object).Count
Write-Host ("   commits ahead of origin/master : " + $ahead)
Write-Host ("   commits behind origin/master  : " + $behind)
if ($behind -gt 0) { Bad "remote has commits you do not have -- pull first" }
if ($ahead -eq 0 -and -not $DryRun) { Write-Host "   nothing to push (already up to date)" }

# ---------------------------------------------------------------- 5. push

if ($fail -gt 0) {
    Write-Host ""
    Write-Host ("ABORTED: " + $fail + " problem(s) above. Nothing was pushed.")
    exit 1
}

Step "Pushing"
if ($DryRun) {
    Write-Host "   (dry run) would run: git push origin master"
    Write-Host "   (dry run) would run: git push origin --tags"
    Write-Host ""
    Write-Host "DRY RUN complete. Nothing was pushed."
    exit 0
}

& git push origin master 2>&1 | ForEach-Object { Write-Host ("   " + $_) }
$pushOk = ($LASTEXITCODE -eq 0)
if ($pushOk) { Good "master pushed" } else { Bad "git push origin master failed" }

if ($pushOk) {
    & git push origin --tags 2>&1 | ForEach-Object { Write-Host ("   " + $_) }
    if ($LASTEXITCODE -eq 0) { Good "tags pushed" } else { Bad "git push origin --tags failed" }
}

if (-not $pushOk) {
    Write-Host ""
    Write-Host "If this failed with 'Invalid username or token', the stored credential is dead."
    Write-Host "Log in once, then re-run this script:"
    Write-Host ""
    Write-Host '    & "C:\Program Files\Git\mingw64\bin\git-credential-manager.exe" github login'
    Write-Host ""
    exit 1
}

# ---------------------------------------------------------------- 6. reminders

Write-Host ""
Write-Host "Pushed. Remaining steps are on github.com (about a minute):"
Write-Host ""
Write-Host "  1. Create the Release:"
Write-Host "     https://github.com/Stellum-Waq/dsh-pet-ronaldo/releases/new?tag=v$version"
Write-Host "     Title: v$version    Body: copy the [$version] section of CHANGELOG.md"
Write-Host ""
Write-Host "  2. Add the marketplace topic (this is what most DSH plugin markets index):"
Write-Host "     repo page -> About gear -> Topics -> add: dsh-plugin"
Write-Host "     suggested alongside: deepseek-harness, desktop-pet, cordis"
Write-Host ""
Write-Host "  3. Optional: submit to the curated lists (fork + PR). Ready-to-paste entry"
Write-Host "     text is in docs/PUBLISHING.md section 3.4."
Write-Host ""
exit 0
