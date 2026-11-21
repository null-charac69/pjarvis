$ErrorActionPreference = "Stop"
& node "$PSScriptRoot\browser-mode.cjs" stop pwa
exit $LASTEXITCODE