@echo off
rem ===========================================================================
rem  DSH desktop pet -- stop it.
rem
rem  Asks the plugin host to shut the pet down (it also taskkills the process
rem  tree). Falls back to killing by command line if the host is unreachable.
rem ===========================================================================
setlocal
set "PS1=%TEMP%\dsh-pet-stop.ps1"
> "%PS1%" echo $ErrorActionPreference = 'SilentlyContinue'
>> "%PS1%" echo $done = $false
>> "%PS1%" echo try {
>> "%PS1%" echo   $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3080/ronaldo-pet/desktop' -ContentType 'application/json' -Body '{"action":"stop"}' -TimeoutSec 5
>> "%PS1%" echo   if ($r.ok) { Write-Host 'host asked the pet to quit'; $done = $true }
>> "%PS1%" echo } catch { }
>> "%PS1%" echo if (-not $done) {
>> "%PS1%" echo   $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" ^| Where-Object { $_.CommandLine -like '*DesktopPet.ps1*' }
>> "%PS1%" echo   foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force; Write-Host ('killed pid ' + $p.ProcessId) }
>> "%PS1%" echo   if (-not $procs) { Write-Host 'no desktop pet process found' }
>> "%PS1%" echo }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
del "%PS1%" >nul 2>&1
endlocal
