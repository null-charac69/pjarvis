$ErrorActionPreference = "Stop"
& node "$PSScriptRoot\browser-mode.cjs" stop browser
exit $LASTEXITCODE