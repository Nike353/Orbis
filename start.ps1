# Native Windows browser setup and launch. No shell-profile changes.
$ErrorActionPreference = "Stop"
$appDir = $PSScriptRoot
$cache = Join-Path $appDir ".orbis"
$previous = Join-Path $appDir ".litbench"
if (!(Test-Path $cache) -and (Test-Path $previous -PathType Container)) {
    Move-Item -LiteralPath $previous -Destination $cache
}

$uvCommand = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue
if ($uvCommand) {
    $uv = $uvCommand.Source
} else {
    $uv = Join-Path $cache "uv\uv.exe"
    if (!(Test-Path $uv -PathType Leaf)) {
        Write-Host "Setting up uv for Orbis (one time)..."
        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        $installer = Join-Path $cache "install-uv.ps1"
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri "https://astral.sh/uv/install.ps1" -OutFile $installer
        $previousInstall = $env:UV_UNMANAGED_INSTALL
        try {
            $env:UV_UNMANAGED_INSTALL = Join-Path $cache "uv"
            & $installer
            if ($LASTEXITCODE -ne 0 -or !(Test-Path $uv -PathType Leaf)) {
                throw "uv setup failed. Install uv from https://docs.astral.sh/uv/ and retry."
            }
        } finally {
            $env:UV_UNMANAGED_INSTALL = $previousInstall
        }
    }
}

Push-Location -LiteralPath $appDir
try {
    & $uv run --locked --python 3.12 python -u scripts/start.py @args
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $exitCode
