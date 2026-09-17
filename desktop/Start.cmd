@echo off
rem ===========================================================================
rem  DSH desktop pet -- manual launcher (double-click me).
rem
rem  Normally you never need this: the plugin host starts the pet automatically
rem  as soon as `dsh web` runs. Use this to start it by hand, or when the plugin
rem  has no web server yet.
rem
rem  Optional args are forwarded, e.g.:
rem     Start.cmd -Base http://127.0.0.1:3080 -Size 160 -SlowTickMs 25
rem ===========================================================================
setlocal
set "HERE=%~dp0"
if "%~1"=="" (
  powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File "%HERE%DesktopPet.ps1" -Base http://127.0.0.1:3080
) else (
  powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File "%HERE%DesktopPet.ps1" %*
)
endlocal
