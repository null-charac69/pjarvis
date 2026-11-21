param(
    [ValidateRange(1, 5)] [int] $BackendRuns = 3,
    [ValidateRange(1, 5)] [int] $DesktopRuns = 2
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
    param([string] $Name, [scriptblock] $Command)
    Write-Host "=== $Name ==="
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersionText = (& $nodeExecutable --version).Trim().TrimStart("v")
if ($LASTEXITCODE -ne 0) { throw "Node.js is required." }
$nodeVersion = [version]::Parse($nodeVersionText)
if ($nodeVersion -lt [version]"22.12.0") {
    throw "Node.js 22.12.0 or newer is required; found $nodeVersionText."
}
if ($env:NODE_TLS_REJECT_UNAUTHORIZED -eq "0") {
    throw "Refusing to run with NODE_TLS_REJECT_UNAUTHORIZED=0."
}

Push-Location $repositoryRoot
try {
    Invoke-Checked "Python lock consistency" { uv lock --check }
    Invoke-Checked "Ruff lint" { uv run ruff check apps/api tests }
    Invoke-Checked "Ruff format" { uv run ruff format --check apps/api tests }
    Invoke-Checked "mypy" { uv run mypy apps/api/app }
    for ($run = 1; $run -le $BackendRuns; $run++) {
        Invoke-Checked "Backend test run $run of $BackendRuns" { uv run pytest }
    }

    Push-Location (Join-Path $repositoryRoot "apps/desktop")
    try {
        $strictSsl = (& npm config get strict-ssl).Trim()
        if ($LASTEXITCODE -ne 0 -or $strictSsl -ne "true") {
            throw "npm strict-ssl must remain true."
        }
        Invoke-Checked "Production dependency audit" { npm audit --omit=dev }
        Invoke-Checked "High/critical dependency audit" { npm audit --audit-level=high }
        for ($run = 1; $run -le $DesktopRuns; $run++) {
            Invoke-Checked "Desktop test run $run of $DesktopRuns" { npm run test }
        }
        Invoke-Checked "Renderer TypeScript" { npm run typecheck }
        Invoke-Checked "Electron TypeScript" { npm run typecheck:electron }
        Invoke-Checked "Desktop production build" { npm run build }
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
}
