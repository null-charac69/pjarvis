$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $root
try {
    foreach ($mode in @("browser", "pwa")) {
        Write-Output "--- $mode profile ---"
        & node scripts\browser-mode.cjs status $mode
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}
finally {
    Pop-Location
}
Write-Output "For browser permissions, inspect the site controls in the organization-managed browser. This diagnostic does not change browser or certificate policy."