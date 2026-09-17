# =============================================================================
# Publish this pet package to GitHub.
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads a
# BOM-less UTF-8 script using the system ANSI code page, which garbles non-ASCII
# text. Chinese documentation lives in SHARING.md instead.
#
#   .\publish.ps1                 # init + commit + push
#   .\publish.ps1 -NoPush         # init + commit only
#   .\publish.ps1 -Remote <url>   # set/override the origin remote
#
# This script only runs git inside its own folder. The plugin never runs it for
# you: publishing is always an explicit action by the author.
# =============================================================================
param(
  [string]$Remote = '{{repo}}',
  # NOTE: keep the default commit message ASCII. Putting the pet's (possibly
  # Chinese) name here would inject non-ASCII bytes into this script, and
  # PowerShell 5.1 would then read them with the ANSI code page.
  [string]$Message = 'pet: DPSL-1.0 share package',
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path '.git')) {
  Write-Host '[1/4] git init'
  git init | Out-Null
  git branch -M main
}

Write-Host '[2/4] staging files'
git add -A

Write-Host '[3/4] committing'
$dirty = git status --porcelain
if ($dirty) { git commit -m $Message } else { Write-Host '      nothing to commit' }

if ($Remote -and $Remote -notmatch 'owner/repo') {
  $existing = ''
  try { $existing = (git remote get-url origin) } catch { $existing = '' }
  if ($existing -ne $Remote) {
    if ($existing) { git remote set-url origin $Remote } else { git remote add origin $Remote }
    Write-Host "      origin -> $Remote"
  }
} else {
  Write-Host '      no remote configured (pass -Remote https://github.com/you/your-repo)'
}

if ($NoPush) {
  Write-Host '[4/4] skipped push (-NoPush)'
  exit 0
}

Write-Host '[4/4] pushing'
git push -u origin main

Write-Host ''
Write-Host 'Done. Two things left:'
Write-Host '  1. Add the topic "{{topic}}" to the repository (About -> gear -> Topics).'
Write-Host '     That topic is how the DSH pet gallery discovers your pet.'
Write-Host '  2. Open the plugin: Settings -> pet -> Community, hit refresh.'
