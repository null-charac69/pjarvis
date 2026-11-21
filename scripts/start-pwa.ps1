$ErrorActionPreference = "Stop"
npm --prefix "$PSScriptRoot\..\apps\desktop" run build:pwa
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$startOutput = & node "$PSScriptRoot\browser-mode.cjs" start pwa
$startOutput | Write-Output
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$readyLine = $startOutput | Where-Object { $_ -like "pwa mode is ready at *" } | Select-Object -First 1
if (-not $readyLine) { exit 1 }
Start-Process ($readyLine -replace "^pwa mode is ready at ", "")