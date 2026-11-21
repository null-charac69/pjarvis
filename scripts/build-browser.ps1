$ErrorActionPreference = "Stop"
npm --prefix "$PSScriptRoot\..\apps\desktop" run build:browser
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm --prefix "$PSScriptRoot\..\apps\desktop" run build:pwa
exit $LASTEXITCODE