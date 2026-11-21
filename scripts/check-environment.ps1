$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$checks = @(
    @{ Name = "Node.js"; Command = "node"; Path = $null },
    @{ Name = "Python virtual environment"; Command = $null; Path = Join-Path $root ".venv\Scripts\python.exe" },
    @{ Name = "Vite dependencies"; Command = $null; Path = Join-Path $root "apps\desktop\node_modules\vite\bin\vite.js" }
)
$failed = $false
foreach ($check in $checks) {
    $available = if ($check.Path) { Test-Path $check.Path } else { [bool](Get-Command $check.Command -ErrorAction SilentlyContinue) }
    if ($available) { Write-Output "OK: $($check.Name)" }
    else {
        Write-Output "Missing: $($check.Name)"
        $failed = $true
    }
}
if (-not $env:LOCALAPPDATA) {
    Write-Output "Missing: LOCALAPPDATA user profile location"
    $failed = $true
}
foreach ($port in @(8765, 5173)) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { Write-Output "Port $port is occupied; the supervisor will select a free loopback fallback port." }
    else { Write-Output "Port $port is available." }
}
if ($failed) {
    Write-Output "Install or restore only the repository dependencies and runtimes approved for this device, then rerun this check."
    exit 1
}
Write-Output "Environment is ready for scripts/start-browser.ps1. No administrator access is required."