$ErrorActionPreference = "Stop"
$startOutput = & node "$PSScriptRoot\browser-mode.cjs" start browser
$startOutput | Write-Output
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$readyLine = $startOutput | Where-Object { $_ -like "browser mode is ready at *" } | Select-Object -First 1
if (-not $readyLine) { exit 1 }
Start-Process ($readyLine -replace "^browser mode is ready at ", "")