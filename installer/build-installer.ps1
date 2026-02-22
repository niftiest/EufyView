# EufyView Installer Build Script
# Downloads dependencies and compiles the Inno Setup installer
#
# Prerequisites: Inno Setup 6 installed (https://jrsoftware.org/isinfo.php)
# Usage: powershell -ExecutionPolicy Bypass -File build-installer.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildCache = Join-Path $ScriptDir "build-cache"
$DistDir = Join-Path $ScriptDir "dist"

$NodeVersion = "22.13.1"
$NodeZipUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$NodeZipFile = Join-Path $BuildCache "node-v$NodeVersion-win-x64.zip"
$NodeExtractDir = Join-Path $BuildCache "node-v22-win-x64"

$FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
$FfmpegZipFile = Join-Path $BuildCache "ffmpeg-release-essentials.zip"
$FfmpegExtractDir = Join-Path $BuildCache "ffmpeg"

$TailscaleVersion = "1.78.1"
$TailscaleMsiUrl = "https://pkgs.tailscale.com/stable/tailscale-setup-$TailscaleVersion-amd64.msi"
$TailscaleMsiFile = Join-Path $BuildCache "tailscale-setup.msi"

$CloudflaredUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
$CloudflaredFile = Join-Path $BuildCache "cloudflared-windows-amd64.exe"

Write-Host "=== EufyView Installer Build ===" -ForegroundColor Cyan
Write-Host ""

# --- Create directories ---
if (-not (Test-Path $BuildCache)) { New-Item -ItemType Directory -Path $BuildCache | Out-Null }
if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir | Out-Null }

# --- 1. Download Node.js portable ---
if (-not (Test-Path $NodeExtractDir)) {
    if (-not (Test-Path $NodeZipFile)) {
        Write-Host "[1/8] Downloading Node.js v$NodeVersion..." -ForegroundColor Yellow
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $NodeZipUrl -OutFile $NodeZipFile -UseBasicParsing
        Write-Host "      Downloaded: $NodeZipFile"
    } else {
        Write-Host "[1/8] Node.js zip already cached" -ForegroundColor Green
    }

    Write-Host "      Extracting..."
    $tempExtract = Join-Path $BuildCache "_node_temp"
    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
    Expand-Archive -Path $NodeZipFile -DestinationPath $tempExtract -Force

    $innerFolder = Get-ChildItem -Path $tempExtract -Directory | Select-Object -First 1
    if ($innerFolder) {
        if (Test-Path $NodeExtractDir) { Remove-Item $NodeExtractDir -Recurse -Force }
        Move-Item -Path $innerFolder.FullName -Destination $NodeExtractDir
        Remove-Item $tempExtract -Recurse -Force
        Write-Host "      Extracted to: $NodeExtractDir" -ForegroundColor Green
    } else {
        throw "Failed to find extracted Node.js folder"
    }
} else {
    Write-Host "[1/8] Node.js v$NodeVersion already extracted" -ForegroundColor Green
}

# Verify node.exe exists
$nodeExe = Join-Path $NodeExtractDir "node.exe"
if (-not (Test-Path $nodeExe)) {
    throw "node.exe not found at $nodeExe"
}
$nodeVer = & $nodeExe --version 2>&1
Write-Host "      Node.js version: $nodeVer"

# --- 2. Download FFmpeg ---
if (-not (Test-Path (Join-Path $FfmpegExtractDir "ffmpeg.exe"))) {
    if (-not (Test-Path $FfmpegZipFile)) {
        Write-Host "[2/8] Downloading FFmpeg essentials..." -ForegroundColor Yellow
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $FfmpegUrl -OutFile $FfmpegZipFile -UseBasicParsing
        Write-Host "      Downloaded: $FfmpegZipFile"
    } else {
        Write-Host "[2/8] FFmpeg zip already cached" -ForegroundColor Green
    }

    Write-Host "      Extracting ffmpeg.exe..."
    if (-not (Test-Path $FfmpegExtractDir)) { New-Item -ItemType Directory -Path $FfmpegExtractDir | Out-Null }

    # Extract to temp, find ffmpeg.exe inside the nested folder
    $tempFfmpeg = Join-Path $BuildCache "_ffmpeg_temp"
    if (Test-Path $tempFfmpeg) { Remove-Item $tempFfmpeg -Recurse -Force }
    Expand-Archive -Path $FfmpegZipFile -DestinationPath $tempFfmpeg -Force

    $ffmpegExe = Get-ChildItem -Path $tempFfmpeg -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if ($ffmpegExe) {
        Copy-Item -Path $ffmpegExe.FullName -Destination (Join-Path $FfmpegExtractDir "ffmpeg.exe") -Force
        Remove-Item $tempFfmpeg -Recurse -Force
        Write-Host "      Extracted ffmpeg.exe to: $FfmpegExtractDir" -ForegroundColor Green
    } else {
        Remove-Item $tempFfmpeg -Recurse -Force -ErrorAction SilentlyContinue
        throw "ffmpeg.exe not found in downloaded archive"
    }
} else {
    Write-Host "[2/8] FFmpeg already extracted" -ForegroundColor Green
}

# --- 3. Download Tailscale MSI ---
if (-not (Test-Path $TailscaleMsiFile)) {
    Write-Host "[3/8] Downloading Tailscale v$TailscaleVersion MSI..." -ForegroundColor Yellow
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $TailscaleMsiUrl -OutFile $TailscaleMsiFile -UseBasicParsing
    Write-Host "      Downloaded: $TailscaleMsiFile" -ForegroundColor Green
} else {
    Write-Host "[3/8] Tailscale MSI already cached" -ForegroundColor Green
}

# --- 4. Download cloudflared ---
if (-not (Test-Path $CloudflaredFile)) {
    Write-Host "[4/8] Downloading cloudflared..." -ForegroundColor Yellow
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $CloudflaredUrl -OutFile $CloudflaredFile -UseBasicParsing
    Write-Host "      Downloaded: $CloudflaredFile" -ForegroundColor Green
} else {
    Write-Host "[4/8] cloudflared already cached" -ForegroundColor Green
}

# --- 5. Generate tray icon ---
Write-Host "[5/8] Generating tray icon..." -ForegroundColor Yellow
$iconScript = Join-Path $ScriptDir "generate-icon.ps1"
$iconOutput = Join-Path $ScriptDir "tray-icon.ico"
if (-not (Test-Path $iconOutput)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $iconScript -OutputPath $iconOutput
} else {
    Write-Host "      Tray icon already exists" -ForegroundColor Green
}

# --- 6. Compile tray app ---
Write-Host "[6/8] Compiling tray app..." -ForegroundColor Yellow
$cscExe = Join-Path $env:windir "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $cscExe)) {
    $cscExe = Join-Path $env:windir "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $cscExe)) {
    Write-Host "ERROR: C# compiler (csc.exe) not found!" -ForegroundColor Red
    exit 1
}
$trayCs = Join-Path $ScriptDir "EufyViewTray.cs"
$trayExe = Join-Path $ScriptDir "EufyViewTray.exe"
& $cscExe /nologo /target:winexe /out:$trayExe /win32icon:$iconOutput /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $trayCs
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Tray app compilation failed" -ForegroundColor Red
    exit 1
}
Write-Host "      Compiled: $trayExe ($([math]::Round((Get-Item $trayExe).Length / 1KB, 0)) KB)" -ForegroundColor Green

# --- 7. Find Inno Setup compiler ---
Write-Host "[7/8] Looking for Inno Setup compiler..." -ForegroundColor Yellow
$isccPaths = @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)

$isccExe = $null
foreach ($p in $isccPaths) {
    if (Test-Path $p) {
        $isccExe = $p
        break
    }
}

# Also check PATH
if (-not $isccExe) {
    $isccCmd = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
    if ($isccCmd) { $isccExe = $isccCmd.Source }
}

if (-not $isccExe) {
    Write-Host ""
    Write-Host "ERROR: Inno Setup 6 not found!" -ForegroundColor Red
    Write-Host "Download from: https://jrsoftware.org/isdl.php" -ForegroundColor Red
    Write-Host "Install it, then re-run this script." -ForegroundColor Red
    exit 1
}
Write-Host "      Found: $isccExe" -ForegroundColor Green

# --- 8. Compile installer ---
Write-Host "[8/8] Compiling installer..." -ForegroundColor Yellow
$issFile = Join-Path $ScriptDir "EufyView-Setup.iss"

& $isccExe $issFile
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Inno Setup compilation failed (exit code $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

$outputExe = Join-Path $DistDir "EufyView-Setup.exe"
if (Test-Path $outputExe) {
    $size = (Get-Item $outputExe).Length / 1MB
    Write-Host ""
    Write-Host "=== Build complete! ===" -ForegroundColor Green
    Write-Host "Output: $outputExe" -ForegroundColor Green
    Write-Host "Size:   $([math]::Round($size, 1)) MB" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "ERROR: Expected output not found at $outputExe" -ForegroundColor Red
    exit 1
}
