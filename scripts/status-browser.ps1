$ErrorActionPreference = "Stop"
& node "$PSScriptRoot\browser-mode.cjs" status browser
exit $LASTEXITCODE