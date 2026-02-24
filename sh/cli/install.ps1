# Spawn CLI installer for Windows PowerShell
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sh/cli/install.ps1 | iex
#
# Or download and run:
#   Invoke-WebRequest -Uri https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sh/cli/install.ps1 -OutFile install.ps1
#   .\install.ps1
#
# Override install directory:
#   $env:SPAWN_INSTALL_DIR = "C:\Users\you\bin"; irm .../install.ps1 | iex

$ErrorActionPreference = "Stop"

$SPAWN_REPO    = "OpenRouterTeam/spawn"
$SPAWN_RAW_BASE = "https://raw.githubusercontent.com/$SPAWN_REPO/main"
$MIN_BUN_VERSION = [version]"1.2.0"

function Write-Step  { param($msg) Write-Host "[spawn] $msg" -ForegroundColor Cyan }
function Write-Info  { param($msg) Write-Host "[spawn] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "[spawn] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[spawn] $msg" -ForegroundColor Red }

# -- Helpers -------------------------------------------------------------------

function Test-BunAvailable {
    try { $null = Get-Command bun -ErrorAction Stop; return $true } catch { return $false }
}

function Get-BunVersion {
    $v = (bun --version 2>$null).Trim()
    try { return [version]$v } catch { return [version]"0.0.0" }
}

function Install-Bun {
    Write-Step "Installing bun for Windows..."
    $bunInstaller = "https://bun.sh/install.ps1"
    try {
        Invoke-RestMethod $bunInstaller | Invoke-Expression
    } catch {
        Write-Err "Failed to install bun automatically."
        Write-Err "Install bun manually from: https://bun.sh"
        Write-Err "Then re-run this installer."
        exit 1
    }
    # Refresh PATH so bun is available in this session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
}

function Find-InstallDir {
    if ($env:SPAWN_INSTALL_DIR) { return $env:SPAWN_INSTALL_DIR }

    # Prefer %USERPROFILE%\.local\bin (mirrors unix behaviour) or bun's global bin
    $candidates = @(
        "$env:USERPROFILE\.local\bin",
        $(try { & bun pm bin -g 2>$null } catch { $null })
    )
    $pathDirs = $env:Path -split ";"

    foreach ($dir in $candidates) {
        if ($dir -and $pathDirs -contains $dir) { return $dir }
    }

    # Default -- will be added to PATH below
    return "$env:USERPROFILE\.local\bin"
}

function Add-ToUserPath {
    param([string]$Dir)
    $currentPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $dirs = $currentPath -split ";"
    if ($dirs -notcontains $Dir) {
        $newPath = ($dirs + $Dir) -join ";"
        [System.Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        $env:Path = "$env:Path;$Dir"
        Write-Warn "$Dir added to your user PATH. Restart your terminal to use 'spawn'."
    }
}

function Install-SpawnCli {
    $tmpDir = Join-Path $env:TEMP ("spawn-install-" + [System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $tmpDir | Out-Null

    try {
        $cliDir = Join-Path $tmpDir "cli"

        # Download CLI source via git (preferred) or individual files
        Write-Step "Downloading spawn CLI source..."
        $gitAvailable = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
        if ($gitAvailable) {
            $repoDir = Join-Path $tmpDir "repo"
            git clone --depth 1 --filter=blob:none --sparse `
                "https://github.com/$SPAWN_REPO.git" $repoDir 2>$null
            Push-Location $repoDir
            git sparse-checkout set cli 2>$null
            Pop-Location
            Move-Item (Join-Path $repoDir "cli") $cliDir
            Remove-Item $repoDir -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            # Fallback: download individual source files
            New-Item -ItemType Directory -Path (Join-Path $cliDir "src") | Out-Null
            $apiUrl = "https://api.github.com/repos/$SPAWN_REPO/contents/cli/src"
            $files = (Invoke-RestMethod $apiUrl) |
                Where-Object { $_.name -match '\.ts$' -and $_.name -notmatch '__tests__' } |
                Select-Object -ExpandProperty name

            foreach ($f in @("package.json","bun.lock","tsconfig.json")) {
                Invoke-WebRequest "$SPAWN_RAW_BASE/cli/$f" -OutFile (Join-Path $cliDir $f)
            }
            foreach ($f in $files) {
                # SECURITY: block path traversal
                if ($f -match '\.\.' -or $f -match '[/\\]') {
                    Write-Err "Security: invalid filename from API: $f -- aborting."
                    exit 1
                }
                Invoke-WebRequest "$SPAWN_RAW_BASE/cli/src/$f" -OutFile (Join-Path (Join-Path $cliDir "src") $f)
            }
        }

        # Build with bun
        Write-Step "Building spawn CLI..."
        Push-Location $cliDir
        bun install
        $buildOk = $false
        try { bun run build 2>$null } catch { }
        if ($LASTEXITCODE -eq 0) { $buildOk = $true }
        if (-not $buildOk) {
            Write-Warn "Local build failed -- downloading pre-built binary..."
            Invoke-WebRequest "https://github.com/$SPAWN_REPO/releases/download/cli-latest/cli.js" `
                -OutFile "cli.js"
            if ((Get-Item "cli.js").Length -eq 0) {
                Write-Err "Failed to download pre-built binary."
                exit 1
            }
        }
        Pop-Location

        # Install
        $installDir = Find-InstallDir
        New-Item -ItemType Directory -Force -Path $installDir | Out-Null

        # Copy cli.js as the spawn script; create a .cmd wrapper so it's invokable from cmd.exe too
        $cliJs    = Join-Path $installDir "spawn"
        $cliCmd   = Join-Path $installDir "spawn.cmd"

        Copy-Item (Join-Path $cliDir "cli.js") $cliJs -Force

        # spawn.cmd -- lets users run `spawn` from cmd.exe and PowerShell without specifying bun
        Set-Content $cliCmd "@bun `"%~dp0spawn`" %*"

        Write-Info "Installed spawn to $installDir"
        Add-ToUserPath $installDir

        # Show version
        try {
            Write-Host ""
            & bun $cliJs version
            Write-Host ""
            Write-Info "Run 'spawn' to get started"
        } catch { }
    } finally {
        Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# -- Main ----------------------------------------------------------------------

Write-Host ""

if (-not (Test-BunAvailable)) {
    Install-Bun
    if (-not (Test-BunAvailable)) {
        Write-Err "bun is not available after installation. Please install bun manually: https://bun.sh"
        exit 1
    }
    Write-Info "bun installed successfully"
}

$bunVer = Get-BunVersion
if ($bunVer -lt $MIN_BUN_VERSION) {
    Write-Warn "bun $bunVer is below minimum $MIN_BUN_VERSION -- upgrading..."
    bun upgrade
    $bunVer = Get-BunVersion
    if ($bunVer -lt $MIN_BUN_VERSION) {
        Write-Err "Failed to upgrade bun to >= $MIN_BUN_VERSION (got $bunVer)"
        Write-Err "Please run: bun upgrade"
        exit 1
    }
    Write-Info "bun upgraded to $bunVer"
}

Write-Step "Installing spawn via bun..."
Install-SpawnCli
