param(
    [ValidateSet("dir", "nsis", "portable")]
    [string] $Target = "nsis"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $repositoryRoot "apps/desktop"

$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersionText = (& $nodeExecutable --version).Trim().TrimStart("v")
if ($LASTEXITCODE -ne 0) { throw "Node.js is required." }
$nodeVersion = [version]::Parse($nodeVersionText)
if ($nodeVersion -lt [version]"22.12.0") {
    throw "Node.js 22.12.0 or newer is required; found $nodeVersionText."
}
if ($env:NODE_TLS_REJECT_UNAUTHORIZED -eq "0") {
    throw "Refusing to package with NODE_TLS_REJECT_UNAUTHORIZED=0."
}

Push-Location $desktopRoot
try {
    $strictSsl = (& npm config get strict-ssl).Trim()
    if ($LASTEXITCODE -ne 0 -or $strictSsl -ne "true") {
        throw "npm strict-ssl must remain true."
    }
    $electronExecutable = Join-Path $desktopRoot "node_modules/electron/dist/electron.exe"
    if (-not (Test-Path $electronExecutable)) {
        throw "Electron runtime is missing. Install the locked dependencies with npm ci and approved CA configuration, then retry."
    }
    npm audit --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "Production dependency audit failed." }
    npm audit --audit-level=high
    if ($LASTEXITCODE -ne 0) { throw "High/critical dependency audit failed." }
    npm run "package:win:$Target"
    if ($LASTEXITCODE -ne 0) { throw "Windows $Target packaging failed." }
    Write-Host "Package output: $(Join-Path $desktopRoot 'release')"
    Write-Host "Do not distribute until signing and installed-app smoke tests are complete."
}
finally {
    Pop-Location
}
